import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { TokenTotals, UsageDay, UsagePeriod, UsageRow, UsageSource } from '@shared/types'
import { costOf } from './prices'

// Leitura dos registros locais do Claude Code e do Codex. Só números saem daqui: nunca o texto das conversas.

// [chave (sem repetir), dia AAAA-MM-DD local, modelo, projeto, entrada, escrita 5 min, escrita 1 h, leitura de cache, saída]
export type Entry = [string, string, string, string, number, number, number, number, number]

export interface CodexLimits {
  at: number
  plan?: string
  primary?: { percent: number; windowMinutes?: number; resetsAt?: number }
  secondary?: { percent: number; windowMinutes?: number; resetsAt?: number }
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string }
}

export interface FileState {
  size: number
  mtimeMs: number
  offset: number
  entries: Entry[]
  // Codex: estado que atravessa leituras incrementais do mesmo arquivo.
  model?: string
  project?: string
  prevTotal?: number[]
  limits?: CodexLimits
}

export type Kind = 'claude' | 'codex'

const CHUNK = 1 << 20

export function localDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function claudeLine(line: string): Entry | null {
  // Filtro barato antes do JSON.parse: só respostas do modelo com uso.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  let d: { type?: string; timestamp?: string; cwd?: string; requestId?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } }
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  const m = d.message
  const u = m?.usage
  if (d.type !== 'assistant' || !m || !u || !m.model || m.model === '<synthetic>') return null
  const ts = Date.parse(d.timestamp ?? '')
  if (!Number.isFinite(ts)) return null
  const cc = (u.cache_creation ?? {}) as Record<string, unknown>
  const w1h = num(cc.ephemeral_1h_input_tokens)
  const w5m = cc.ephemeral_5m_input_tokens !== undefined ? num(cc.ephemeral_5m_input_tokens) : Math.max(0, num(u.cache_creation_input_tokens) - w1h)
  return [
    `${m.id ?? ''}:${d.requestId ?? ''}`, localDay(ts), m.model, d.cwd ? basename(d.cwd) : '—',
    num(u.input_tokens), w5m, w1h, num(u.cache_read_input_tokens), num(u.output_tokens),
  ]
}

// Codex: o uso vem acumulado por sessão (`total_token_usage`); cada evento vira a diferença para o anterior.
export function codexLine(line: string, st: FileState, file: string): Entry | null {
  if (!line.includes('"turn_context"') && !line.includes('"token_count"') && !line.includes('"session_meta"')) return null
  let d: { timestamp?: string; type?: string; payload?: Record<string, unknown> }
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  const p = d.payload ?? {}
  if (d.type === 'session_meta' || d.type === 'turn_context') {
    if (typeof p.model === 'string') st.model = p.model
    if (typeof p.cwd === 'string') st.project = basename(p.cwd)
    return null
  }
  if (p.type !== 'token_count') return null
  const ts = Date.parse(d.timestamp ?? '')
  if (!Number.isFinite(ts)) return null
  const rl = p.rate_limits as Record<string, unknown> | null | undefined
  if (rl && (!st.limits || ts >= st.limits.at)) st.limits = codexLimits(rl, ts)
  const info = p.info as { total_token_usage?: Record<string, unknown> } | null | undefined
  const t = info?.total_token_usage
  if (!t) return null
  const cur = [num(t.input_tokens), num(t.cached_input_tokens), num(t.cache_write_input_tokens), num(t.output_tokens)]
  const prev = st.prevTotal ?? [0, 0, 0, 0]
  const delta = cur.map((v, i) => Math.max(0, v - prev[i]))
  st.prevTotal = cur
  if (!delta.some((v) => v > 0)) return null
  const [input, cached, write, output] = delta
  return [`${file}:${ts}:${cur.join(',')}`, localDay(ts), st.model ?? 'codex', st.project ?? '—', Math.max(0, input - cached - write), write, 0, cached, output]
}

function codexLimits(rl: Record<string, unknown>, at: number): CodexLimits {
  const win = (w: unknown) => {
    if (!w || typeof w !== 'object') return undefined
    const o = w as Record<string, unknown>
    if (typeof o.used_percent !== 'number') return undefined
    return {
      percent: o.used_percent,
      windowMinutes: typeof o.window_minutes === 'number' ? o.window_minutes : undefined,
      resetsAt: typeof o.resets_at === 'number' ? o.resets_at * 1000 : undefined,
    }
  }
  const c = rl.credits as Record<string, unknown> | undefined
  return {
    at,
    plan: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
    primary: win(rl.primary),
    secondary: win(rl.secondary),
    credits: c ? { hasCredits: !!c.has_credits, unlimited: !!c.unlimited, balance: typeof c.balance === 'string' ? c.balance : undefined } : undefined,
  }
}

// Lê só o que o arquivo ganhou desde a última vez (linhas completas).
export async function scanFile(kind: Kind, file: string, prev: FileState | undefined): Promise<FileState> {
  const s = await stat(file)
  // Arquivo encolheu ou foi trocado: relê do início.
  if (prev && s.size === prev.size && s.mtimeMs === prev.mtimeMs) return prev
  const fresh = !prev || s.size < prev.offset
  const st: FileState = fresh ? { size: 0, mtimeMs: 0, offset: 0, entries: [] } : { ...prev!, entries: prev!.entries.slice() }
  const fh = await open(file, 'r')
  try {
    let pos = st.offset
    let rest = ''
    const buf = Buffer.alloc(CHUNK)
    while (pos < s.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, s.size - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      const text = rest + buf.subarray(0, bytesRead).toString('utf8')
      const lines = text.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const e = kind === 'claude' ? claudeLine(line) : codexLine(line, st, file)
        if (e) st.entries.push(e)
      }
    }
    // A última linha incompleta fica para a próxima leitura.
    st.offset = pos - Buffer.byteLength(rest, 'utf8')
    st.size = s.size
    st.mtimeMs = s.mtimeMs
    return st
  } finally {
    await fh.close()
  }
}

export async function listJsonl(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  await walk(root, 0)
  return out
}

// ---- agregação ----

export function periodStart(period: UsagePeriod, now = Date.now()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (period === '7d') d.setDate(d.getDate() - 6)
  if (period === '30d') d.setDate(d.getDate() - 29)
  return localDay(d.getTime())
}

const zero = (): TokenTotals => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 })

function add(t: TokenTotals, e: Entry, cost: number | null): void {
  t.input += e[4]
  t.cacheWrite += e[5] + e[6]
  t.cacheRead += e[7]
  t.output += e[8]
  t.cost = t.cost === null || cost === null ? null : t.cost + cost
}

export function aggregate(id: UsageSource['id'], title: string, entries: Iterable<Entry>, period: UsagePeriod, now = Date.now()): UsageSource {
  const from = periodStart(period, now)
  const seen = new Set<string>()
  const totals = zero()
  const days = new Map<string, TokenTotals>()
  const models = new Map<string, TokenTotals>()
  const projects = new Map<string, TokenTotals>()
  let unpriced = false
  for (const e of entries) {
    if (e[1] < from || seen.has(e[0])) continue
    seen.add(e[0])
    const cost = costOf(e[2], { input: e[4], cacheWrite5m: e[5], cacheWrite1h: e[6], cacheRead: e[7], output: e[8] })
    if (cost === null) unpriced = true
    // O total soma o que tem preço; os modelos sem preço aparecem como "—" na tabela.
    add(totals, e, cost ?? 0)
    for (const [map, key] of [[days, e[1]], [models, e[2]], [projects, e[3]]] as const) {
      if (!map.has(key)) map.set(key, zero())
      add(map.get(key)!, e, cost)
    }
  }
  if (unpriced && totals.cost === 0) totals.cost = null
  const rows = (m: Map<string, TokenTotals>): UsageRow[] =>
    [...m].map(([key, t]) => ({ key, label: key, ...t })).sort((a, b) => b.input + b.output + b.cacheRead + b.cacheWrite - (a.input + a.output + a.cacheRead + a.cacheWrite))
  const dayList: UsageDay[] = []
  // Todos os dias do período, inclusive os sem uso (o gráfico fica contínuo).
  const cur = new Date(`${from}T00:00:00`)
  const end = localDay(now)
  while (localDay(cur.getTime()) <= end) {
    const k = localDay(cur.getTime())
    dayList.push({ day: k, ...(days.get(k) ?? zero()) })
    cur.setDate(cur.getDate() + 1)
  }
  return { id, title, totals, days: dayList, byModel: rows(models), byProject: rows(projects), note: unpriced ? 'Alguns modelos não têm preço público confirmado: o custo deles aparece como "—" e fica fora do total.' : undefined }
}
