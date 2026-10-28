import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { descendants, parsePs } from '../../src/main/pty/processTree'
import { resolveTerminalPath, previewUrl, resolvePreviewRequest } from '../../src/main/files'
import { scanLaunchTargets, preferredPage } from '../../src/main/launchTargets'

// mods.ts importa electron; testamos a validação isoladamente via import dinâmico com mock.
import { vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {}, session: {} }))
const { validateManifest, sanitizeModText } = await import('../../src/main/mods')

describe('árvore de processos', () => {
  const ps = [
    '  1     0 Mon Oct 27 08:00:00 2026 /sbin/launchd',
    ' 100     1 Mon Oct 27 08:01:00 2026 /bin/zsh',
    ' 101   100 Mon Oct 27 08:01:01 2026 node',
    ' 102   101 Mon Oct 27 08:01:02 2026 esbuild',
    ' 200     1 Mon Oct 27 08:02:00 2026 other',
  ].join('\n')
  const rows = parsePs(ps)
  it('lê pid, ppid, início e comando', () => expect(rows[2]).toEqual({ pid: 101, ppid: 100, start: 'Mon Oct 27 08:01:01 2026', command: 'node' }))
  it('coleta netos', () => expect(descendants(rows, 100).map((r) => r.pid).sort()).toEqual([101, 102]))
})

describe('arquivos', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-files-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'x.ts'), 'x')
  writeFileSync(join(root, 'index.html'), '<p>')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')
  it('resolve link de caminho com linha', () => expect(resolveTerminalPath(root, root, 'src/x.ts:12:3')).toEqual({ path: join(root, 'src', 'x.ts'), line: 12 }))
  it('recusa fora do projeto', () => expect(resolveTerminalPath(root, root, '/etc/hosts')).toBeNull())
  it('preview:// ida e volta, sem escapar da raiz', () => {
    const url = previewUrl(root, root, join(root, 'src', 'x.ts'))
    expect(resolvePreviewRequest(url, () => root)).toEqual({ file: join(root, 'src', 'x.ts') })
    const evil = url.replace('src/x.ts', '..%2F..%2Fetc%2Fhosts')
    expect(resolvePreviewRequest(evil, () => root)).toBeNull()
  })
  it('preview:// nunca serve arquivos ocultos', () => {
    writeFileSync(join(root, '.env'), 'SEGREDO=1')
    const url = previewUrl(root, root, join(root, 'src', 'x.ts')).replace('src/x.ts', '.env')
    expect(resolvePreviewRequest(url, () => root)).toBeNull()
  })
  it('alvos: servidor com pnpm e página', () => {
    const t = scanLaunchTargets(root)
    const server = t.find((x) => x.kind === 'server')!
    expect(server.command).toBe('pnpm install && pnpm dev')
    expect(t.some((x) => x.kind === 'page' && x.title === 'index.html')).toBe(true)
  })
  it('página preferida: index.html', () => expect(preferredPage(root, [join(root, 'a.html'), join(root, 'index.html')])).toBe(join(root, 'index.html')))
})

describe('mods', () => {
  it('valida manifesto', () => {
    expect(validateManifest({ id: 'ok-mod', name: 'Ok' }, 'ok-mod').manifest?.id).toBe('ok-mod')
    expect(validateManifest({ id: 'Bad Id', name: 'x' }, 'Bad Id').error).toBeTruthy()
    expect(validateManifest({ id: 'a', name: 'x' }, 'b').error).toContain('nome da pasta')
    expect(validateManifest({ id: 'a', name: 'x', permissions: ['fs.write'] }, 'a').error).toContain('permissão desconhecida')
    expect(validateManifest({ id: 'a', name: 'x', main: '../evil.js' }, 'a').error).toBeTruthy()
  })
  it('texto de mod sem sequências de controle', () => {
    expect(sanitizeModText('ok\x1b[31m\x03\x9b\r\n\tfim')).toBe('ok[31m\r\n\tfim')
    expect(sanitizeModText('x'.repeat(5000)).length).toBe(4096)
  })
})
