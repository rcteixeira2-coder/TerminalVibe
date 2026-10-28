import { EventEmitter } from 'node:events'
import type { GitState } from '@shared/types'
import { fetchRemote, localStatus } from './git'

const FETCH_EVERY_MS = 5 * 60_000
const FETCH_MIN_GAP_MS = 60_000
const FOCUS_GAP_MS = 30_000
const MAX_FETCHING = 2

interface Deps {
  projects(): { id: string; path: string; missing?: boolean }[]
  env(): Record<string, string>
}

// Estado git de cada projeto: status local (barato) a toda hora; fetch (rede) a cada 5 min ou quando pedido.
export class GitWatcher extends EventEmitter<{ state: [string, GitState] }> {
  private states = new Map<string, GitState>()
  private local = new Map<string, Promise<GitState | null>>()
  private fetching = new Set<string>()
  private fetchQueue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private lastFocus = 0

  constructor(private deps: Deps) {
    super()
  }

  start(): void {
    void this.refreshAll(true)
    this.timer = setInterval(() => void this.refreshAll(true), FETCH_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  all(): Record<string, GitState> {
    return Object.fromEntries(this.states)
  }

  // Janela ganhou foco: status local de todos, no máximo a cada 30 s.
  onFocus(): void {
    if (Date.now() - this.lastFocus < FOCUS_GAP_MS) return
    this.lastFocus = Date.now()
    void this.refreshAll(false)
  }

  async refreshAll(fetch: boolean): Promise<void> {
    const list = this.deps.projects().filter((p) => !p.missing)
    const known = new Set(list.map((p) => p.id))
    for (const id of this.states.keys()) if (!known.has(id)) this.states.delete(id)
    for (const p of list) {
      const st = await this.refreshLocal(p.id)
      if (fetch && st?.kind === 'remote') this.enqueueFetch(p.id)
    }
  }

  async refresh(id: string, opts: { fetch?: boolean; force?: boolean } = {}): Promise<GitState | null> {
    const st = await this.refreshLocal(id)
    if (opts.fetch && st?.kind === 'remote') this.enqueueFetch(id, opts.force)
    return this.states.get(id) ?? st
  }

  private path(id: string): string | null {
    const p = this.deps.projects().find((x) => x.id === id && !x.missing)
    return p ? p.path : null
  }

  private refreshLocal(id: string): Promise<GitState | null> {
    const running = this.local.get(id)
    if (running) return running
    const root = this.path(id)
    if (!root) return Promise.resolve(null)
    const job = localStatus(root, this.deps.env())
      .then((st) => {
        const prev = this.states.get(id)
        // Fetch e erro de rede valem até o próximo fetch.
        const next: GitState = { ...st, fetchedAt: prev?.fetchedAt, error: st.error ?? prev?.error, fetching: this.fetching.has(id) || undefined }
        if (st.kind !== 'remote') delete next.error
        this.states.set(id, next)
        this.emit('state', id, next)
        return next
      })
      .catch(() => null)
      .finally(() => this.local.delete(id))
    this.local.set(id, job)
    return job
  }

  private enqueueFetch(id: string, force = false): void {
    const st = this.states.get(id)
    if (!force && st?.fetchedAt && Date.now() - st.fetchedAt < FETCH_MIN_GAP_MS) return
    if (this.fetching.has(id) || this.fetchQueue.includes(id)) return
    this.fetchQueue.push(id)
    this.pump()
  }

  private pump(): void {
    while (this.fetching.size < MAX_FETCHING && this.fetchQueue.length) {
      const id = this.fetchQueue.shift()!
      const root = this.path(id)
      if (!root) continue
      this.fetching.add(id)
      const cur = this.states.get(id)
      if (cur) {
        const marked = { ...cur, fetching: true }
        this.states.set(id, marked)
        this.emit('state', id, marked)
      }
      void fetchRemote(root, this.deps.env())
        .then(async (error) => {
          this.fetching.delete(id)
          const prev = this.states.get(id)
          if (prev) this.states.set(id, { ...prev, fetchedAt: Date.now(), error: error ?? undefined, fetching: undefined })
          // Uma leitura iniciada antes do fetch traria o ahead/behind antigo: espera e lê de novo.
          await this.local.get(id)
          await this.refreshLocal(id)
        })
        .finally(() => {
          this.fetching.delete(id)
          this.pump()
        })
    }
  }
}
