import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAvailable, lastLine, newestSource, sourceRoot, stepFromLog, waitForQuiet } from '../../src/main/appUpdate'

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-update-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'src', 'main'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'install-mac.sh'), '#!/bin/sh\n')
  writeFileSync(join(root, 'src', 'main', 'index.ts'), '')
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '')
  const old = new Date('2026-01-01T00:00:00Z')
  for (const f of ['scripts/install-mac.sh', 'src/main/index.ts', 'node_modules/x/index.js']) utimesSync(join(root, f), old, old)
  return root
}

describe('atualizar Cockpit', () => {
  it('acha a etapa pelo log do install-mac.sh', () => {
    expect(stepFromLog('vite v7 building for production...')).toBe('compiling')
    expect(stepFromLog('ok\n  • electron-builder  version=26\n  • packaging       platform=darwin')).toBe('packaging')
    expect(stepFromLog('  • packaging\n  • signing         file=Cockpit.app')).toBe('signing')
    expect(stepFromLog('• signing\nInstalado em /Users/x/Applications/Cockpit.app')).toBe('installing')
  })

  it('mostra só a última linha, sem cores e com o nome do arquivo no lugar do caminho', () => {
    expect(lastLine('a\n\x1b[32mtransforming /Users/x/Desktop/Terminal/src/main/index.ts\x1b[0m\n\n')).toBe('transforming index.ts')
    expect(lastLine('  • signing         file=/var/folders/T/cockpit-release/mac-arm64/Cockpit.app platform=darwin')).toBe(
      '• signing file=Cockpit.app platform=darwin',
    )
    expect(lastLine('\n  \n')).toBeNull()
    expect(lastLine('x'.repeat(300))).toHaveLength(120)
  })

  it('só aceita a pasta do código se o script de build estiver lá', () => {
    const root = project()
    expect(sourceRoot(root)).toBe(root)
    expect(sourceRoot(join(root, 'src'))).toBeNull()
    expect(sourceRoot('')).toBeNull()
  })

  it('há atualização quando o código é mais novo que o build (node_modules não conta)', () => {
    const root = project()
    const built = new Date('2026-06-01T00:00:00Z').getTime()
    expect(isAvailable(root, built)).toBe(false)
    const later = new Date('2026-07-01T00:00:00Z')
    utimesSync(join(root, 'node_modules', 'x', 'index.js'), later, later)
    expect(isAvailable(root, built)).toBe(false)
    utimesSync(join(root, 'src', 'main', 'index.ts'), later, later)
    expect(newestSource(root)).toBe(later.getTime())
    expect(isAvailable(root, built)).toBe(true)
    expect(isAvailable(null, built)).toBe(false)
  })

  it('espera as edições pararem, até o limite', async () => {
    const root = project()
    const edited = newestSource(root)
    let clock = edited + 1000
    const sleep = async (ms: number) => void (clock += ms)
    expect(await waitForQuiet(root, 5000, 120_000, () => clock, sleep)).toBe(true)
    expect(clock).toBe(edited + 5000)
    // Alguém salvando sem parar: desiste no limite.
    const busy = async (ms: number) => {
      clock += ms
      const now = new Date(clock)
      utimesSync(join(root, 'src', 'main', 'index.ts'), now, now)
    }
    await busy(0)
    expect(await waitForQuiet(root, 5000, 10_000, () => clock, busy)).toBe(false)
  })
})
