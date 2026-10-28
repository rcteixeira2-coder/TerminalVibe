import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

// ---- Ambiente do pty (porte de DevProtocol.swift:121-137) ----

const COPIED = ['USER', 'LOGNAME', 'LANG', 'LC_CTYPE', 'LC_ALL', 'TMPDIR', 'SSH_AUTH_SOCK']

export function fixedPath(home = homedir()): string[] {
  return [
    join(home, '.local/bin'),
    join(home, '.local/opt/node/bin'),
    join(home, '.cargo/bin'),
    join(home, '.bun/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
}

export interface EnvExtra {
  paneId: string
  sock: string
  token: string
  version: string
  // Ambiente lido uma vez do shell de login (`zsh -ilc env`), só as chaves permitidas.
  login?: Record<string, string>
}

export function buildEnv(source: NodeJS.ProcessEnv, extra: EnvExtra, home = homedir()): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of COPIED) {
    const v = extra.login?.[k] ?? source[k]
    if (typeof v === 'string' && v && !v.includes('\0')) env[k] = v
  }
  const inherited = [extra.login?.PATH, source.PATH]
    .filter((p): p is string => typeof p === 'string')
    .flatMap((p) => p.split(':'))
  const seen = new Set<string>()
  const path: string[] = []
  for (const p of [...fixedPath(home), ...inherited]) {
    // Só caminhos absolutos: nunca `.` nem vazio no PATH.
    if (!p || !isAbsolute(p) || seen.has(p)) continue
    seen.add(p)
    path.push(p)
  }
  env.PATH = path.join(':')
  env.HOME = home
  env.SHELL = '/bin/zsh'
  env.LANG = env.LANG || 'pt_BR.UTF-8'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Cockpit'
  env.TERM_PROGRAM_VERSION = extra.version
  env.COCKPIT_PANE_ID = extra.paneId
  env.COCKPIT_SOCK = extra.sock
  env.COCKPIT_TOKEN = extra.token
  return env
}

// ---- Caminhos ----

export function canonicalDirectory(path: string): string | null {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

// Recusa `..` e links simbólicos que saem da raiz em qualquer nível (porte de ProjectFiles.swift:39-57).
export function isInside(root: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidate)
    if (realCandidate === realRoot) return true
    const rel = relative(realRoot, realCandidate)
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
  } catch {
    return false
  }
}

// Nomes com caracteres de controle podem virar comandos quando digitados no pty: recusados.
export function hasControlChars(s: string): boolean {
  return /[\x00-\x1f\x7f-\x9f]/.test(s)
}

// Caminho como dado no shell: aspas simples, `'` → `'\''` (ProjectFiles.swift:59-62).
export function quotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

// ---- Links (DevProtocol.swift:111-119) ----

export function validateLink(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  if (url.username || url.password) return null
  return url.toString()
}

export function isLocalUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return (u.protocol === 'http:' || u.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)
  } catch {
    return false
  }
}

// Argumentos que nunca podem ser usados (o app não pula permissões dos agentes).
export const FORBIDDEN_ARGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto',
]
