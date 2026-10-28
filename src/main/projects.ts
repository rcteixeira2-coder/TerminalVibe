import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Project } from '@shared/types'
import { PROJECT_COLORS } from '@shared/types'
import { canonicalDirectory } from './security'
import type { Store } from './store'

const PACKAGE_EXT = /\.(app|bundle|framework|photoslibrary|xcodeproj|xcworkspace|playground|pkg|rtfd|key|pages|numbers)$/i

export function colorFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PROJECT_COLORS[h % PROJECT_COLORS.length]
}

// Pastas da Mesa (sem ocultas e pacotes) + pastas adicionadas (porte de Dev.swift:37-55).
export class Projects extends EventEmitter<{ changed: [Project[]] }> {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private cache: Project[] = []
  readonly desktop = join(homedir(), 'Desktop')

  constructor(private store: Store) {
    super()
    this.cache = this.scan()
    try {
      this.watcher = watch(this.desktop, () => this.refreshSoon())
    } catch {
      // Sem permissão de Mesa: só as adicionadas.
    }
  }

  list(): Project[] {
    return this.cache
  }

  get(id: string): Project | undefined {
    return this.cache.find((p) => p.id === id)
  }

  path(id: string): string | null {
    const p = this.get(id)
    return p && !p.missing ? p.path : null
  }

  refreshSoon(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.refresh(), 400)
  }

  refresh(): void {
    this.cache = this.scan()
    this.emit('changed', this.cache)
  }

  add(path: string): Project | null {
    const real = canonicalDirectory(path)
    if (!real) return null
    if (!this.store.data.added.includes(real) && !this.isDesktopChild(real)) {
      this.store.data.added.push(real)
      this.store.save()
    }
    this.refresh()
    return this.get(real) ?? null
  }

  remove(id: string): void {
    this.store.data.added = this.store.data.added.filter((p) => p !== id)
    this.store.save()
    this.refresh()
  }

  update(id: string, patch: Partial<Pick<Project, 'favorite' | 'color' | 'lastAgent' | 'openIn' | 'group'>>): Project | null {
    if (!this.get(id)) return null
    this.store.setMeta(id, patch)
    this.refresh()
    return this.get(id) ?? null
  }

  dispose(): void {
    this.watcher?.close()
  }

  private isDesktopChild(real: string): boolean {
    return canonicalDirectory(this.desktop) === canonicalDirectory(join(real, '..'))
  }

  private scan(): Project[] {
    const out = new Map<string, Project>()
    const make = (path: string, source: Project['source'], missing = false): Project => {
      const m = this.store.meta(path)
      return {
        id: path,
        name: basename(path),
        path,
        source,
        favorite: !!m.favorite,
        color: m.color ?? colorFor(path),
        lastAgent: m.lastAgent,
        openIn: m.openIn,
        group: m.group && this.store.data.groups.some((g) => g.id === m.group) ? m.group : undefined,
        missing: missing || undefined,
      }
    }
    try {
      for (const e of readdirSync(this.desktop, { withFileTypes: true })) {
        if (e.name.startsWith('.') || PACKAGE_EXT.test(e.name)) continue
        const full = join(this.desktop, e.name)
        let isDir = e.isDirectory()
        if (e.isSymbolicLink()) {
          try {
            isDir = statSync(full).isDirectory()
          } catch {
            isDir = false
          }
        }
        if (!isDir) continue
        const real = canonicalDirectory(full)
        if (real && !out.has(real)) out.set(real, make(real, 'desktop'))
      }
    } catch {
      // ignore
    }
    for (const added of this.store.data.added) {
      if (out.has(added)) continue
      out.set(added, make(added, 'added', !existsSync(added)))
    }
    const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })
    return [...out.values()].sort((a, b) => collator.compare(a.name, b.name))
  }
}
