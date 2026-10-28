import { promises as fsp, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isInside } from '../security'
import { listDir } from '../files'

// Ferramentas do agente: só leitura e confinadas ao projeto. O conteúdo vai para um provedor externo,
// então segredos nunca são lidos (lista fixa, não configurável).

const MAX_READ_BYTES = 200 * 1024
const MAX_READ_LINES = 2000
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_FILES = 20000
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const SEARCH_BUDGET_MS = 5000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'release', '.next', '.cache', '.build', '__pycache__', '.venv', 'venv', 'target', 'coverage'])

export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  if (parts.some((p) => p === '.git' || p === '.ssh' || p === '.gnupg' || p === '.aws')) return true
  const name = parts[parts.length - 1] ?? ''
  return /^\.env(\..*)?$/i.test(name) || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i.test(name) || /^\.?(netrc|npmrc|pypirc)$/i.test(name)
}

export interface ToolDef {
  name: string
  description: string
  schema: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'list_dir',
    description: 'Lista o conteúdo de uma pasta do projeto (um nível). Use "." para a raiz.',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'Pasta relativa à raiz do projeto' } }, required: ['path'] },
  },
  {
    name: 'read_file',
    description: 'Lê um arquivo de texto do projeto, com números de linha. Para arquivos grandes, peça um intervalo de linhas.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Arquivo relativo à raiz do projeto' },
        start_line: { type: 'integer', description: 'Primeira linha (1 = início). Opcional.' },
        end_line: { type: 'integer', description: 'Última linha. Opcional.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Procura um texto (sem diferenciar maiúsculas) em todos os arquivos de texto do projeto e devolve caminho:linha: trecho.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a procurar' },
        path: { type: 'string', description: 'Pasta onde procurar (opcional, padrão: raiz)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'terminal_tail',
    description: 'Mostra as últimas linhas de um terminal aberto deste projeto (ex.: o que o Claude ou um servidor acabou de imprimir). Sem "session", lista os terminais abertos.',
    schema: { type: 'object', properties: { session: { type: 'string', description: 'Título ou id do terminal (opcional)' } }, required: [] },
  },
]

export interface ToolContext {
  root: string
  sessions(): { id: string; title: string; agent: string }[]
  tail(sessionId: string, lines: number): string
}

export interface ToolResult {
  ok: boolean
  content: string
  summary: string
  // Print (ferramentas do navegador): vai como imagem para quem suporta (MCP).
  image?: { data: string; mimeType: string }
}

export function resolveInProject(root: string, raw: unknown): { abs: string; rel: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'Caminho vazio.' }
  const cleaned = raw.trim().replace(/^["']|["']$/g, '')
  const abs = isAbsolute(cleaned) ? cleaned : resolve(root, cleaned)
  if (!isInside(root, abs)) return { error: `Fora do projeto ou inexistente: ${cleaned}` }
  const rel = relative(root, abs) || '.'
  if (isSecretPath(rel)) return { error: `Arquivo protegido (segredos não são lidos pelo agente): ${rel}` }
  return { abs, rel }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_dir': {
        const r = resolveInProject(ctx.root, input.path ?? '.')
        if ('error' in r) return { ok: false, content: r.error, summary: 'pasta recusada' }
        const listing = await listDir(ctx.root, r.abs)
        if ('error' in listing) return { ok: false, content: listing.error, summary: `não leu ${r.rel}` }
        const lines = listing.entries
          .filter((e) => !isSecretPath(relative(ctx.root, e.path)))
          .map((e) => `${e.kind === 'dir' ? '📁' : e.kind === 'symlink' ? '🔗' : '📄'} ${e.name}${e.kind === 'dir' ? '/' : ''}`)
        if (listing.truncated) lines.push(`… mais ${listing.truncated} itens`)
        return { ok: true, content: lines.join('\n') || '(vazia)', summary: `listou ${r.rel}` }
      }
      case 'read_file': {
        const r = resolveInProject(ctx.root, input.path)
        if ('error' in r) return { ok: false, content: r.error, summary: 'arquivo recusado' }
        const st = statSync(r.abs)
        if (!st.isFile()) return { ok: false, content: `${r.rel} não é um arquivo.`, summary: `não leu ${r.rel}` }
        const fh = await fsp.open(r.abs, 'r')
        let buf: Buffer
        try {
          buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES * 4))
          await fh.read(buf, 0, buf.length, 0)
        } finally {
          await fh.close()
        }
        if (looksBinary(buf)) return { ok: false, content: `${r.rel} é binário; o agente só lê texto.`, summary: `não leu ${r.rel} (binário)` }
        const all = buf.toString('utf8').split('\n')
        // Arquivo terminado em \n não tem uma linha vazia a mais.
        if (all.length > 1 && all[all.length - 1] === '') all.pop()
        const start = Math.max(1, Number(input.start_line) || 1)
        let end = Math.min(all.length, Number(input.end_line) || all.length, start + MAX_READ_LINES - 1)
        let out = ''
        for (let i = start; i <= end; i++) {
          const line = `${i}| ${all[i - 1]}\n`
          if (out.length + line.length > MAX_READ_BYTES) {
            end = i - 1
            break
          }
          out += line
        }
        const total = st.size > buf.length ? 'muitas' : String(all.length)
        const note = end < all.length || st.size > buf.length ? `[linhas ${start}–${end} de ${total}; peça outro intervalo para continuar]` : ''
        return { ok: true, content: out + note, summary: `leu ${r.rel} (linhas ${start}–${end})` }
      }
      case 'search': {
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        if (!query) return { ok: false, content: 'Busca vazia.', summary: 'busca vazia' }
        const base = resolveInProject(ctx.root, input.path ?? '.')
        if ('error' in base) return { ok: false, content: base.error, summary: 'pasta recusada' }
        const results = await searchText(ctx.root, base.abs, query.toLowerCase())
        const body = results.lines.length ? results.lines.join('\n') : 'Nenhum resultado.'
        const note = results.truncated ? `\n[resultados cortados em ${MAX_SEARCH_RESULTS}; refine a busca]` : ''
        return { ok: true, content: body + note, summary: `buscou “${query.slice(0, 40)}” (${results.lines.length} resultado${results.lines.length === 1 ? '' : 's'})` }
      }
      case 'terminal_tail': {
        const list = ctx.sessions()
        if (!list.length) return { ok: true, content: 'Nenhum terminal aberto neste projeto.', summary: 'sem terminais abertos' }
        const want = typeof input.session === 'string' ? input.session.trim().toLowerCase() : ''
        if (!want) {
          return { ok: true, content: list.map((s) => `- ${s.title} (${s.agent}) id=${s.id}`).join('\n'), summary: 'listou os terminais' }
        }
        const s = list.find((x) => x.id === want || x.title.toLowerCase() === want) ?? list.find((x) => x.title.toLowerCase().includes(want))
        if (!s) return { ok: false, content: `Terminal não encontrado. Abertos: ${list.map((x) => x.title).join(', ')}`, summary: 'terminal não encontrado' }
        const text = ctx.tail(s.id, 120)
        return { ok: true, content: text || '(sem saída)', summary: `leu o terminal ${s.title}` }
      }
      default:
        return { ok: false, content: `Ferramenta desconhecida: ${name}`, summary: `ferramenta desconhecida ${name}` }
    }
  } catch (e) {
    return { ok: false, content: `Erro: ${(e as Error).message}`, summary: `falhou: ${name}` }
  }
}

async function searchText(root: string, base: string, needle: string): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = []
  const started = Date.now()
  let files = 0
  let truncated = false
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      const rel = relative(root, full)
      if (isSecretPath(rel)) continue
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full)
        continue
      }
      if (!e.isFile()) continue
      if (++files > MAX_SEARCH_FILES || Date.now() - started > SEARCH_BUDGET_MS) return { lines, truncated: true }
      let buf: Buffer
      try {
        const st = statSync(full)
        if (st.size > MAX_SEARCH_FILE_BYTES) continue
        buf = await fsp.readFile(full)
      } catch {
        continue
      }
      if (looksBinary(buf)) continue
      const text = buf.toString('utf8')
      if (!text.toLowerCase().includes(needle)) continue
      const fileLines = text.split('\n')
      for (let i = 0; i < fileLines.length; i++) {
        if (!fileLines[i].toLowerCase().includes(needle)) continue
        lines.push(`${rel.split(sep).join('/')}:${i + 1}: ${fileLines[i].trim().slice(0, 200)}`)
        if (lines.length >= MAX_SEARCH_RESULTS) return { lines, truncated: true }
      }
    }
  }
  return { lines, truncated }
}

// Arquivos do projeto para o autocomplete de @arquivo.
export async function findFiles(root: string, query: string, limit = 40): Promise<string[]> {
  const q = query.toLowerCase()
  const out: string[] = []
  const stack = [root]
  let seen = 0
  while (stack.length && out.length < limit && seen < 30000) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      seen++
      const full = join(dir, e.name)
      const rel = relative(root, full)
      if (isSecretPath(rel)) continue
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full)
      } else if (e.isFile() && (!q || basename(rel).toLowerCase().includes(q) || rel.toLowerCase().includes(q))) {
        out.push(rel.split(sep).join('/'))
        if (out.length >= limit) break
      }
    }
  }
  return out.sort((a, b) => a.length - b.length)
}
