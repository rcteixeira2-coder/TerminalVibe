import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { UpdateStep } from '@shared/types'

// "Atualizar Cockpit": port do AppUpdate.swift do Hermes. scripts/install-mac.sh compila, assina e instala em
// ~/Applications; o Cockpit reabre a cópia instalada no fim. Sem electron aqui, para os testes unitários.

// Gravados pelo electron.vite.config.ts no build (o equivalente ao HermesSourceRoot do Info.plist).
declare const __COCKPIT_SOURCE_ROOT__: string | undefined
declare const __COCKPIT_BUILT_AT__: number | undefined

export const BUILT_AT = typeof __COCKPIT_BUILT_AT__ === 'number' ? __COCKPIT_BUILT_AT__ : 0
const BUILD_SCRIPT = 'scripts/install-mac.sh'

/** Pasta do código-fonte de onde veio este build; null quando ela sumiu (ou o build não sabe). */
export function sourceRoot(root = typeof __COCKPIT_SOURCE_ROOT__ === 'string' ? __COCKPIT_SOURCE_ROOT__ : ''): string | null {
  return root && existsSync(join(root, BUILD_SCRIPT)) ? root : null
}

/** O que entra num build: se algo disso for mais novo que o build em execução, há o que atualizar. */
export const BUILD_INPUTS = [
  'src', 'resources', 'build', BUILD_SCRIPT, 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'electron-builder.yml',
]

/** Data de modificação (ms) mais nova entre as entradas do build; pula ocultos e node_modules. */
export function newestSource(root: string): number {
  let newest = 0
  const visit = (path: string): void => {
    let st
    try {
      st = statSync(path)
    } catch {
      return
    }
    if (st.isFile()) {
      newest = Math.max(newest, st.mtimeMs)
      return
    }
    if (!st.isDirectory()) return
    for (const name of readdirSync(path)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      visit(join(path, name))
    }
  }
  for (const input of BUILD_INPUTS) visit(join(root, input))
  return newest
}

/** Verdadeiro quando o código mudou depois que este build foi feito. */
export function isAvailable(root: string | null, builtAt = BUILT_AT): boolean {
  return !!root && builtAt > 0 && newestSource(root) > builtAt
}

/** A etapa mais adiantada que o log do install-mac.sh mostra até agora. */
export function stepFromLog(log: string): UpdateStep {
  if (log.includes('Instalado em')) return 'installing'
  if (/•\s*signing/.test(log) || log.includes('codesign')) return 'signing'
  if (/•\s*(packaging|building|electron-builder)/.test(log)) return 'packaging'
  return 'compiling'
}

/** Última linha com conteúdo, sem cores, caminhos reduzidos ao nome do arquivo, até 120 caracteres. */
export function lastLine(log: string): string | null {
  const lines = log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
  const line = lines.at(-1)
  if (!line) return null
  return line
    .split(' ')
    // Também `file=/var/…/Cockpit.app`, como o electron-builder escreve.
    .map((w) => w.replace(/^([\w-]+=)?[/~]\S*/, (path, key = '') => key + basename(path.slice(key.length))))
    .filter(Boolean)
    .join(' ')
    .slice(0, 120)
}

/**
 * Espera ninguém salvar uma entrada do build por `quietMs` (outras sessões editam o Cockpit ao mesmo tempo),
 * até `limitMs`. Devolve false quando a pasta nunca sossegou.
 */
export async function waitForQuiet(
  root: string,
  quietMs = 5000,
  limitMs = 120_000,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const start = now()
  while (now() - start < limitMs) {
    if (now() - newestSource(root) >= quietMs) return true
    await sleep(1000)
  }
  return false
}

/**
 * Roda scripts/install-mac.sh (compila, assina, instala). Devolve null se deu certo; senão, o fim do log.
 * `env` precisa do PATH do shell de login: o script chama npx.
 */
export async function runUpdate(
  root: string,
  env: Record<string, string>,
  progress: (step: UpdateStep, line: string | null) => void,
): Promise<string | null> {
  progress('waiting', null)
  await waitForQuiet(root)
  progress('compiling', null)
  return new Promise((resolve) => {
    let log = ''
    const child = spawn('/bin/sh', [BUILD_SCRIPT], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const take = (chunk: Buffer): void => {
      // Só o fim interessa (etapa e última linha); o log de um build inteiro não fica na memória.
      log = (log + chunk.toString('utf8')).slice(-200_000)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    // A cada meio segundo, a janela mostra a etapa real e a linha mais recente.
    const timer = setInterval(() => progress(stepFromLog(log), lastLine(log)), 500)
    const tail = (): string => log.split('\n').filter((l) => l.trim()).slice(-12).join('\n')
    child.on('error', (err) => {
      clearInterval(timer)
      resolve(err.message)
    })
    child.on('close', (code) => {
      clearInterval(timer)
      resolve(code === 0 ? null : tail() || `O build terminou com código ${code}.`)
    })
  })
}

/** Um shell solto espera este processo sair e abre o app indicado (a cópia instalada). */
export function scheduleRelaunch(pid: number, app: string): void {
  const child = spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; /usr/bin/open "$2"', 'cockpit-restart', String(pid), app], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}
