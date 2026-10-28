import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { LaunchTarget } from '@shared/types'
import { hasControlChars, quotePath } from './security'

const SKIP = new Set(['node_modules', '.git', '.build', '.next', '.cache', '__pycache__', 'win-unpacked', 'linux-unpacked', 'dist', 'out', 'release'])

function packageManager(dir: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

// Comando montado só com palavras fixas + a pasta entre aspas (LaunchTargets.swift:16-21, 60-70).
export function serverCommand(root: string, dir: string, script: 'dev' | 'start'): string {
  const pm = packageManager(dir)
  const parts: string[] = []
  if (dir !== root) parts.push(`cd ${quotePath(dir)}`)
  if (!existsSync(join(dir, 'node_modules'))) parts.push(`${pm} install`)
  parts.push(pm === 'npm' || pm === 'bun' ? `${pm} run ${script}` : `${pm} ${script}`)
  return parts.join(' && ')
}

// Apps, servidores (scripts dev/start) e páginas .html até 2 níveis (LaunchTargets.swift:24-58).
export function scanLaunchTargets(root: string): LaunchTarget[] {
  const apps: LaunchTarget[] = []
  const servers: LaunchTarget[] = []
  const pages: LaunchTarget[] = []
  const walk = (dir: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name) || hasControlChars(e.name)) continue
      const full = join(dir, e.name)
      const rel = relative(root, full) || e.name
      if (e.isDirectory() && e.name.endsWith('.app')) {
        apps.push({ id: `app:${rel}`, kind: 'app', title: basename(e.name, '.app'), detail: rel, path: full })
        continue
      }
      if (e.isFile() && e.name === 'package.json') {
        try {
          const pkg = JSON.parse(readFileSync(full, 'utf8')) as { scripts?: Record<string, string> }
          for (const script of ['dev', 'start'] as const) {
            if (pkg.scripts?.[script]) {
              servers.push({
                id: `server:${relative(root, dir) || '.'}:${script}`,
                kind: 'server',
                title: `${script} — ${relative(root, dir) || basename(root)}`,
                detail: pkg.scripts[script].slice(0, 80),
                path: dir,
                command: serverCommand(root, dir, script),
              })
              break
            }
          }
        } catch {
          // package.json inválido
        }
        continue
      }
      if (e.isFile() && /\.html?$/i.test(e.name)) {
        pages.push({ id: `page:${rel}`, kind: 'page', title: e.name, detail: rel, path: full })
        continue
      }
      if (e.isDirectory() && depth < 2) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return [...apps, ...servers, ...pages.slice(0, 50)]
}

// Página preferida: lembrada → index.html na raiz → única → mais recente (PreviewFiles.swift:28-38).
export function preferredPage(root: string, pages: string[], remembered?: string): string | null {
  if (remembered && pages.includes(remembered)) return remembered
  const index = join(root, 'index.html')
  if (pages.includes(index)) return index
  if (pages.length === 1) return pages[0]
  let best: string | null = null
  let bestTime = -1
  for (const p of pages) {
    try {
      const t = statSync(p).mtimeMs
      if (t > bestTime) {
        bestTime = t
        best = p
      }
    } catch {
      // ignore
    }
  }
  return best
}

// Ignorados no recarregamento ao vivo (PreviewFiles.swift:40-51).
export function ignoredForReload(path: string): boolean {
  const parts = path.split('/')
  if (parts.some((p) => p === '.git' || p === 'node_modules')) return true
  const name = parts[parts.length - 1] ?? ''
  return name === '.DS_Store' || name.endsWith('~') || name.endsWith('.swp') || name.endsWith('.tmp') || name.startsWith('.#')
}
