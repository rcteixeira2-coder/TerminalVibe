import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Agent, OpenIn, Prefs, SidebarGroup } from '@shared/types'
import { DEFAULT_PREFS } from '@shared/types'

export interface ProjectMeta {
  favorite?: boolean
  color?: string
  lastAgent?: Agent
  launchTarget?: string
  browserHidden?: boolean
  openIn?: OpenIn
  group?: string
}

export interface OpenSession {
  projectId: string
  agent: Agent
  title: string
  claudeSessionId?: string
}

export interface StoreData {
  added: string[]
  meta: Record<string, ProjectMeta>
  groups: SidebarGroup[]
  prefs: Prefs
  openSessions: OpenSession[]
  modsEnabled: Record<string, boolean>
  modWriteGrants: Record<string, boolean>
  window?: { x: number; y: number; width: number; height: number }
}

const EMPTY: StoreData = { added: [], meta: {}, groups: [], prefs: DEFAULT_PREFS, openSessions: [], modsEnabled: {}, modWriteGrants: {} }

// JSON em userData com gravação atômica. Nunca guarda saída de terminal.
export class Store {
  data: StoreData
  private timer: NodeJS.Timeout | null = null

  constructor(private file: string) {
    this.data = this.load()
  }

  private load(): StoreData {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>
      return {
        added: Array.isArray(raw.added) ? raw.added.filter((x) => typeof x === 'string') : [],
        meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
        groups: Array.isArray(raw.groups) ? raw.groups.filter((g) => typeof g?.id === 'string' && typeof g?.name === 'string') : [],
        prefs: { ...DEFAULT_PREFS, ...(raw.prefs ?? {}) },
        openSessions: Array.isArray(raw.openSessions) ? raw.openSessions : [],
        modsEnabled: raw.modsEnabled ?? {},
        modWriteGrants: raw.modWriteGrants ?? {},
        window: raw.window,
      }
    } catch {
      return structuredClone(EMPTY)
    }
  }

  meta(id: string): ProjectMeta {
    return this.data.meta[id] ?? {}
  }

  setMeta(id: string, patch: ProjectMeta): void {
    this.data.meta[id] = { ...this.meta(id), ...patch }
    this.save()
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 200)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
