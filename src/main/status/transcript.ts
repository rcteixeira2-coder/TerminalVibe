import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const TAIL_BYTES = 256 * 1024
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// Últimas linhas do transcript (JSONL). O caminho vem do hook: só lê dentro de ~/.claude/projects.
function tailLines(path: unknown, root: string): string[] {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return []
  const abs = resolve(path)
  if (!abs.startsWith(root + sep)) return []
  let fd: number | null = null
  try {
    fd = openSync(abs, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (len < size) lines.shift() // primeira linha cortada no meio
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

// Texto da última resposta do Claude.
export function lastAssistantText(path: unknown, root = PROJECTS_DIR): string {
  const lines = tailLines(path, root)
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = assistantText(lines[i])
    if (text) return text
  }
  return ''
}

// Modelo que respondeu por último (o rodapé do painel mostra o real, inclusive o escolhido pelo Automático).
export function lastAssistantModel(path: unknown, root = PROJECTS_DIR): string {
  const lines = tailLines(path, root)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.includes('"assistant"')) continue
    try {
      const row = JSON.parse(line) as { type?: string; isSidechain?: boolean; message?: { model?: unknown } }
      if (row.type === 'assistant' && !row.isSidechain && typeof row.message?.model === 'string' && row.message.model.startsWith('claude-'))
        return row.message.model
    } catch {
      // linha inválida: tenta a anterior
    }
  }
  return ''
}

function assistantText(line: string | undefined): string {
  if (!line || !line.includes('"assistant"')) return ''
  try {
    const row = JSON.parse(line) as { type?: string; isSidechain?: boolean; message?: { content?: unknown } }
    if (row.type !== 'assistant' || row.isSidechain) return ''
    const content = row.message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((c): c is { type: 'text'; text: string } => !!c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n\n')
  } catch {
    return ''
  }
}
