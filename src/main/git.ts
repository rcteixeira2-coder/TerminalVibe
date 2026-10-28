import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GitCommit, GitState } from '@shared/types'
import { canonicalDirectory } from './security'

// Leitura do estado git sem shell. `core.fsmonitor=false`: nunca roda programas configurados no repositório.
const BASE = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false']
const MAX_FILES = 8
const MAX_COMMITS = 5

export function gitEnv(path: string, home: string): Record<string, string> {
  return {
    PATH: path,
    HOME: home,
    // Mensagens em inglês para classificar erros; nunca pede senha (Keychain ou falha).
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
  }
}

function git(root: string, args: string[], env: Record<string, string>, timeout = 20_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...BASE, ...args], { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => {
      resolve({ ok: !e, out: String(out), err: e && (e as { killed?: boolean }).killed ? 'timeout' : String(err) })
    })
  })
}

export interface PorcelainStatus {
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  changed: number
  untracked: number
  files: string[]
}

// `git status --porcelain=v2 --branch -z`.
export function parsePorcelain(raw: string): PorcelainStatus {
  const st: PorcelainStatus = { ahead: 0, behind: 0, changed: 0, untracked: 0, files: [] }
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const b = line.slice(14)
      st.branch = b === '(detached)' ? undefined : b
    } else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const m = /^\+(\d+) -(\d+)$/.exec(line.slice(12))
      if (m) {
        st.ahead = Number(m[1])
        st.behind = Number(m[2])
      }
    } else if (line.startsWith('? ')) {
      st.untracked++
      if (st.files.length < MAX_FILES) st.files.push(line.slice(2))
    } else if (/^[12u] /.test(line)) {
      st.changed++
      // Campos fixos antes do caminho: 1 → 8, 2 → 9 (+ caminho original no próximo campo), u → 10.
      const n = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10
      const path = line.split(' ').slice(n).join(' ')
      if (st.files.length < MAX_FILES) st.files.push(path)
      if (line[0] === '2') i++
    }
  }
  return st
}

// "dono/repo" e a página web, a partir da URL do remote. Credenciais na URL nunca saem daqui.
export function parseRemote(url: string): { repo: string; webUrl: string } | null {
  const s = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(s)
  if (scp && !s.includes('://')) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const u = new URL(s)
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null
      host = u.hostname
      path = u.pathname
    } catch {
      return null
    }
  }
  const repo = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo) || !/^[\w.-]+$/.test(host)) return null
  return { repo, webUrl: `https://${host}/${repo}` }
}

function parseLog(out: string): GitCommit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, ct] = l.split('\x1f')
      return { hash, subject: subject ?? '', author: author ?? '', at: Number(ct) * 1000 || 0 }
    })
}

export function fetchError(err: string): string {
  const e = err.toLowerCase()
  if (e === 'timeout') return 'O GitHub demorou demais para responder.'
  if (e.includes('could not resolve host') || e.includes('network is unreachable') || e.includes('timed out') || e.includes('failed to connect'))
    return 'Sem internet (ou o GitHub não respondeu).'
  if (e.includes('repository not found') || e.includes('not found')) return 'Repositório não encontrado ou sem acesso com a sua conta.'
  if (e.includes('authentication') || e.includes('could not read username') || e.includes('permission denied') || e.includes('403'))
    return 'Sem permissão: entre no GitHub de novo (gh auth login).'
  return 'Não consegui falar com o GitHub.'
}

// Só vale o repositório cuja raiz é a própria pasta do projeto (nunca um repo da Mesa ou da home).
export async function localStatus(root: string, env: Record<string, string>): Promise<GitState> {
  const now = Date.now()
  const empty: GitState = { kind: 'none', ahead: 0, behind: 0, changed: 0, untracked: 0, files: [], incoming: [], outgoing: [], checkedAt: now }
  if (!existsSync(join(root, '.git'))) return empty
  const top = await git(root, ['rev-parse', '--show-toplevel'], env)
  if (!top.ok || canonicalDirectory(top.out.trim()) !== canonicalDirectory(root)) return empty
  const [status, remote] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z'], env),
    git(root, ['remote', 'get-url', 'origin'], env),
  ])
  if (!status.ok) return { ...empty, kind: 'local', error: 'Não consegui ler o estado do git.' }
  const st = parsePorcelain(status.out)
  const parsed = remote.ok ? parseRemote(remote.out) : null
  const state: GitState = { ...empty, ...st, kind: remote.ok ? 'remote' : 'local', repo: parsed?.repo, webUrl: parsed?.webUrl }
  if (st.upstream) {
    const fmt = `--format=%h%x1f%s%x1f%an%x1f%ct`
    const [inc, outg] = await Promise.all([
      st.behind ? git(root, ['log', fmt, `-n${MAX_COMMITS}`, 'HEAD..@{u}'], env) : null,
      st.ahead ? git(root, ['log', fmt, `-n${MAX_COMMITS}`, '@{u}..HEAD'], env) : null,
    ])
    if (inc?.ok) state.incoming = parseLog(inc.out)
    if (outg?.ok) state.outgoing = parseLog(outg.out)
  }
  return state
}

export async function fetchRemote(root: string, env: Record<string, string>): Promise<string | null> {
  const r = await git(root, ['fetch', '--quiet', '--prune', '--no-tags', 'origin'], env, 45_000)
  return r.ok ? null : fetchError(r.err)
}

// Nome de branch seguro para virar argumento digitado no terminal.
export function safeBranch(b: string | undefined): b is string {
  return !!b && /^[\w][\w./-]{0,200}$/.test(b) && !b.includes('..') && !b.endsWith('.lock')
}
