import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { UsagePeriod, UsageSource } from '@shared/types'
import { aggregate, listJsonl, scanFile, type CodexLimits, type Entry, type FileState, type Kind } from './scan'

// Roda fora do processo principal: a primeira leitura passa por gigabytes de registros.
export interface ScanInput {
  claudeRoot: string
  codexRoots: string[]
  cacheFile: string
}

export interface ScanOutput {
  sessions: Record<UsagePeriod, UsageSource[]>
  codexLimits?: CodexLimits
  files: number
  ms: number
}

const VERSION = 1
type Cache = { version: number; files: Record<string, FileState & { kind: Kind }> }

function loadCache(file: string): Cache {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as Cache
    if (c.version === VERSION && c.files) return c
  } catch {
    // primeira vez
  }
  return { version: VERSION, files: {} }
}

async function run(input: ScanInput): Promise<ScanOutput> {
  const t0 = Date.now()
  const cache = loadCache(input.cacheFile)
  const next: Cache = { version: VERSION, files: {} }
  const jobs: [Kind, string][] = [
    ...(await listJsonl(input.claudeRoot)).map((f): [Kind, string] => ['claude', f]),
    ...(await Promise.all(input.codexRoots.map(listJsonl))).flat().map((f): [Kind, string] => ['codex', f]),
  ]
  for (const [kind, file] of jobs) {
    try {
      const prev = cache.files[file]
      const st = await scanFile(kind, file, prev?.kind === kind ? prev : undefined)
      next.files[file] = { ...st, kind }
    } catch {
      // arquivo sumiu ou sem permissão: fica de fora
    }
  }
  mkdirSync(dirname(input.cacheFile), { recursive: true, mode: 0o700 })
  const tmp = `${input.cacheFile}.tmp`
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
  renameSync(tmp, input.cacheFile)

  const entries = (k: Kind): Entry[] => Object.values(next.files).filter((f) => f.kind === k).flatMap((f) => f.entries)
  const claude = entries('claude')
  const codex = entries('codex')
  let codexLimits: CodexLimits | undefined
  for (const f of Object.values(next.files)) if (f.limits && (!codexLimits || f.limits.at > codexLimits.at)) codexLimits = f.limits
  const now = Date.now()
  const sessions = Object.fromEntries(
    (['today', '7d', '30d'] as UsagePeriod[]).map((p) => [
      p,
      [aggregate('claude', 'Claude Code', claude, p, now), aggregate('codex', 'Codex', codex, p, now)],
    ]),
  ) as Record<UsagePeriod, UsageSource[]>
  return { sessions, codexLimits, files: jobs.length, ms: Date.now() - t0 }
}

run(workerData as ScanInput)
  .then((out) => parentPort?.postMessage({ ok: true, out }))
  .catch((e) => parentPort?.postMessage({ ok: false, error: String((e as Error)?.message ?? e) }))
