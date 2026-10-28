import { execFile } from 'node:child_process'

// Identidade de processo = PID + horário de início, para nunca sinalizar um PID reaproveitado
// (porte de DevProcessTree.swift:4-57).
export interface ProcessIdentity {
  pid: number
  start: string
}

export interface ProcRow {
  pid: number
  ppid: number
  start: string
  command: string
}

export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    // pid ppid lstart(5 campos: Seg Out 27 08:31:02 2026) comm
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3], command: m[4] })
  }
  return rows
}

export function psSnapshot(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { env: { LANG: 'C', LC_ALL: 'C' }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : parsePs(stdout))
    })
  })
}

export function descendants(rows: ProcRow[], root: number): ProcRow[] {
  const children = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const list = children.get(r.ppid)
    if (list) list.push(r)
    else children.set(r.ppid, [r])
  }
  const out: ProcRow[] = []
  const stack = [root]
  const seen = new Set<number>([root])
  while (stack.length) {
    const pid = stack.pop()!
    for (const c of children.get(pid) ?? []) {
      if (seen.has(c.pid)) continue
      seen.add(c.pid)
      out.push(c)
      stack.push(c.pid)
    }
  }
  return out
}

function signal(id: ProcessIdentity, current: Map<number, string>, sig: NodeJS.Signals): void {
  // Só sinaliza se o PID ainda pertence ao mesmo processo (mesmo horário de início).
  if (current.get(id.pid) !== id.start) return
  try {
    process.kill(id.pid, sig)
  } catch {
    // já saiu
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// STOP → recoleta → TERM → CONT → KILL (0,6 s).
export async function terminateTree(root: ProcessIdentity | null, known: ProcessIdentity[]): Promise<void> {
  let rows = await psSnapshot()
  let current = new Map(rows.map((r) => [r.pid, r.start]))
  const targets = new Map<number, ProcessIdentity>()
  for (const k of known) targets.set(k.pid, k)
  if (root) {
    targets.set(root.pid, root)
    for (const d of descendants(rows, root.pid)) targets.set(d.pid, { pid: d.pid, start: d.start })
  }
  for (const t of targets.values()) signal(t, current, 'SIGSTOP')
  rows = await psSnapshot()
  current = new Map(rows.map((r) => [r.pid, r.start]))
  for (const t of [...targets.values()]) {
    for (const d of descendants(rows, t.pid)) targets.set(d.pid, { pid: d.pid, start: d.start })
  }
  for (const t of targets.values()) signal(t, current, 'SIGTERM')
  for (const t of targets.values()) signal(t, current, 'SIGCONT')
  await sleep(600)
  rows = await psSnapshot()
  current = new Map(rows.map((r) => [r.pid, r.start]))
  for (const t of targets.values()) signal(t, current, 'SIGKILL')
}

export async function killOrphans(known: ProcessIdentity[]): Promise<void> {
  if (!known.length) return
  const rows = await psSnapshot()
  const current = new Map(rows.map((r) => [r.pid, r.start]))
  for (const k of known) signal(k, current, 'SIGKILL')
}
