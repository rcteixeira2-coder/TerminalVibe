import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEnv, isInside, quotePath, validateLink, FORBIDDEN_ARGS } from '../../src/main/security'
import { launchArgs } from '../../src/main/pty/launch'

const extra = { paneId: 'p', sock: '/s', token: 't', version: '0.1.0' }

describe('buildEnv', () => {
  const env = buildEnv(
    { PATH: '.:/usr/bin::relative/bin:/custom/bin', USER: 'u', CURSOR_TRACE_ID: 'x', VSCODE_GIT_ASKPASS_MAIN: 'y', NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'sk', TERM_PROGRAM: 'vscode', DYLD_INSERT_LIBRARIES: 'z', ELECTRON_RUN_AS_NODE: '1', SSH_AUTH_SOCK: '/agent' },
    extra,
    '/Users/h',
  )
  it('remove variáveis de IDE, tokens e injeção', () => {
    for (const k of ['CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'DYLD_INSERT_LIBRARIES', 'ELECTRON_RUN_AS_NODE']) expect(env[k]).toBeUndefined()
  })
  it('identifica o terminal como Cockpit', () => {
    expect(env.TERM_PROGRAM).toBe('Cockpit')
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.COCKPIT_PANE_ID).toBe('p')
  })
  it('PATH só com caminhos absolutos, fixos primeiro', () => {
    const parts = env.PATH.split(':')
    expect(parts).not.toContain('.')
    expect(parts).not.toContain('relative/bin')
    expect(parts).not.toContain('')
    expect(parts[0]).toBe('/Users/h/.local/bin')
    expect(parts).toContain('/custom/bin')
  })
  it('mantém SSH_AUTH_SOCK', () => expect(env.SSH_AUTH_SOCK).toBe('/agent'))
})

describe('isInside', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'cockpit-out-'))
  mkdirSync(join(root, 'a'))
  writeFileSync(join(root, 'a', 'f.txt'), 'x')
  writeFileSync(join(outside, 'secret.txt'), 'x')
  symlinkSync(outside, join(root, 'link-out'))
  it('aceita arquivos dentro', () => expect(isInside(root, join(root, 'a', 'f.txt'))).toBe(true))
  it('recusa ..', () => expect(isInside(root, join(root, 'a', '..', '..', 'etc'))).toBe(false))
  it('recusa link simbólico que sai da raiz', () => expect(isInside(root, join(root, 'link-out', 'secret.txt'))).toBe(false))
  it('recusa caminho inexistente', () => expect(isInside(root, join(root, 'nao-existe'))).toBe(false))
})

describe('quotePath', () => {
  it('aspas simples com escape', () => expect(quotePath("/a b/it's")).toBe(`'/a b/it'\\''s'`))
})

describe('validateLink', () => {
  it('aceita http/https', () => expect(validateLink('https://example.com/x')).toBe('https://example.com/x'))
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'cockpit://x', '/tmp/x', 'https://user:pw@example.com', 'http://'])('bloqueia %s', (u) =>
    expect(validateLink(u)).toBeNull(),
  )
})

describe('launchArgs', () => {
  it('nunca usa flags que pulam permissões', () => {
    for (const agent of ['claude', 'codex', 'shell'] as const)
      for (const resume of [false, true]) {
        const args = launchArgs(agent, { resume, newClaudeSessionId: 'id', claudeSessionId: 'old', pluginDir: '/p' })
        for (const f of FORBIDDEN_ARGS) expect(args).not.toContain(f)
      }
  })
  it('claude novo usa --session-id e plugin do app', () => {
    expect(launchArgs('claude', { newClaudeSessionId: 'abc', pluginDir: '/p' })).toEqual(['--session-id', 'abc', '--plugin-dir', '/p'])
  })
  it('claude retomado usa o id exato', () => {
    expect(launchArgs('claude', { resume: true, claudeSessionId: 'abc' })).toEqual(['--resume', 'abc'])
  })
  it('codex sem overrides -c (status vem por OSC 7501)', () => {
    expect(launchArgs('codex', {})).toEqual([])
    expect(launchArgs('codex', { resume: true })).toEqual(['resume'])
  })
  it('shell é login interativo', () => expect(launchArgs('shell', {})).toEqual(['-il']))
})

import { hasControlChars } from '../../src/main/security'
describe('hasControlChars', () => {
  it('detecta ESC, quebra de linha e C1', () => {
    expect(hasControlChars('/tmp/a\nrm -rf ~')).toBe(true)
    expect(hasControlChars('/tmp/\x1b[201~x')).toBe(true)
    expect(hasControlChars('/tmp/\x9bx')).toBe(true)
    expect(hasControlChars("/tmp/Projeto Teste/it's ok — ç.png")).toBe(false)
  })
})
