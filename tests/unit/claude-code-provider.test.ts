import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentToolCall } from '../../src/shared/types'
import { McpBridge } from '../../src/main/agent/mcpBridge'
import { ClaudeCodeProvider, transcriptPrompt } from '../../src/main/agent/providers/claudeCode'
import { runTool as runProjectTool, TOOL_DEFS, type ToolContext } from '../../src/main/agent/tools'
import { systemPrompt } from '../../src/main/agent/prompt'
import { buildEnv } from '../../src/main/security'

const FAKE = new URL('../fixtures/fakeClaude.mjs', import.meta.url).pathname
chmodSync(FAKE, 0o755)
const bridge = new McpBridge()
afterAll(() => bridge.close())

const dir = mkdtempSync(join(tmpdir(), 'cockpit-cc-'))
writeFileSync(join(dir, 'LEIA.md'), '# Olá do projeto\n')

function provider(binary: string | null, extra: Record<string, string> = {}) {
  return new ClaudeCodeProvider({ binary: () => binary, env: () => ({ PATH: process.env.PATH ?? '', HOME: dir, ...extra }), bridge })
}

function turn(p: ClaudeCodeProvider, tools = TOOL_DEFS, runTool = (n: string, i: Record<string, unknown>) => runProjectTool(ctx(), n, i)) {
  let text = ''
  const calls: AgentToolCall[] = []
  const done = p.run({
    model: 'haiku', system: 'teste', history: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }, { role: 'user', content: 'leia o LEIA.md' }],
    tools, signal: new AbortController().signal, maxRounds: 5,
    onText: (d) => (text += d), onThinking: () => {}, onTool: (c) => calls.push(c), onNotice: () => {}, runTool,
  })
  return { done, get text() { return text }, calls }
}

const ctx = (): ToolContext => ({ root: dir, sessions: () => [], tail: () => '' })

describe('ponte MCP', () => {
  it('recusa sem token, com Origin ou Host estranho', async () => {
    const { config, dispose } = await bridge.register({ tools: [], runTool: async () => ({ ok: true, content: '', summary: '' }), onTool: () => {} })
    const { url, headers } = JSON.parse(config).mcpServers.cockpit
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect((await fetch(url, { method: 'POST', body })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', body, headers: { ...headers, Origin: 'http://evil.test' } })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(200)
    dispose()
    expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(401)
  })
})

describe('Claude (assinatura)', () => {
  it('transcreve o histórico antes da mensagem atual', () => {
    expect(transcriptPrompt([{ role: 'user', content: 'só isso' }])).toBe('só isso')
    const t = transcriptPrompt([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }])
    expect(t).toContain('<usuario>\na\n</usuario>')
    expect(t.endsWith('Mensagem atual do usuário:\nc')).toBe(true)
  })

  it('roda o claude -p isolado e usa as ferramentas do Cockpit pela ponte', async () => {
    const argsFile = join(dir, 'args.json')
    const p = provider(FAKE, { FAKE_CLAUDE_ARGS: argsFile, FAKE_CLAUDE_TOOL: 'read_file', FAKE_CLAUDE_TOOL_ARGS: JSON.stringify({ path: 'LEIA.md' }) })
    const t = turn(p)
    const r = await t.done
    expect(t.text).toContain('Vou olhar.\n\nFerramenta: 1| # Olá do projeto')
    expect(t.calls.at(-1)).toMatchObject({ id: 'toolu_fake', name: 'read_file', ok: true })
    expect(r.usage).toEqual({ input: 15, output: 7, cacheRead: 5 })
    const { args, env } = JSON.parse(readFileSync(argsFile, 'utf8'))
    // Sem ferramentas próprias, sem configurações/hooks/plugins do usuário, sem gravar sessão.
    for (const f of ['-p', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) expect(args).toContain(f)
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__cockpit')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(Number(env)).toBeGreaterThan(60_000)
  })

  it('falha da ferramenta chega ao Claude como erro', async () => {
    const p = provider(FAKE, { FAKE_CLAUDE_TOOL: 'read_file', FAKE_CLAUDE_TOOL_ARGS: JSON.stringify({ path: '../fora-do-projeto.txt' }) })
    const t = turn(p)
    await t.done
    expect(t.text).toContain('(erro)')
  })

  it('erros em português: sem login e sem Claude Code', async () => {
    await expect(turn(provider(FAKE, { FAKE_CLAUDE_FAIL: '1' })).done).rejects.toThrow(/não está logado/)
    await expect(turn(provider(null)).done).rejects.toThrow(/Não encontrei o Claude Code/)
    expect(await provider(FAKE).status()).toEqual({ ok: true, message: 'Conectado pela sua assinatura (max).' })
  })

  // Usa a assinatura de verdade (haiku, poucas centenas de tokens): COCKPIT_LIVE_CLAUDE=1 npx vitest run tests/unit/claude-code-provider.test.ts
  it.skipIf(!process.env.COCKPIT_LIVE_CLAUDE)('ao vivo: o Claude real chama list_dir pela ponte', async () => {
    const env = buildEnv(process.env, { paneId: '', sock: '', token: '', version: 'test' })
    const real = new ClaudeCodeProvider({ binary: () => '/Users/rodrigoteixeira/.local/bin/claude', env: () => env, bridge })
    let text = ''
    const calls: AgentToolCall[] = []
    await real.run({
      model: 'haiku', system: systemPrompt('Proj', dir), history: [{ role: 'user', content: 'Quais arquivos há na raiz? Use a ferramenta e responda só os nomes.' }],
      tools: TOOL_DEFS, signal: new AbortController().signal, maxRounds: 5,
      onText: (d) => (text += d), onThinking: () => {}, onTool: (c) => calls.push(c), onNotice: () => {},
      runTool: (n, i) => runProjectTool(ctx(), n, i),
    })
    expect(calls.some((c) => c.name === 'list_dir' && c.ok)).toBe(true)
    expect(text).toContain('LEIA.md')
  }, 120_000)
})
