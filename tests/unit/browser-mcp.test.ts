import { afterAll, describe, expect, it } from 'vitest'
import { launchArgs } from '../../src/main/pty/launch'
import { McpBridge } from '../../src/main/agent/mcpBridge'

describe('navegador do Cockpit nas sessões do Claude', () => {
  const mcp = JSON.stringify({ mcpServers: { cockpit_browser: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } })

  it('o Claude recebe o MCP e as ferramentas liberadas, sem engolir a primeira mensagem', () => {
    const args = launchArgs('claude', { newClaudeSessionId: 'abc', mcpConfig: mcp, initialPrompt: '/UploadNoGithub' })
    expect(args).toContain(`--mcp-config=${mcp}`)
    expect(args).toContain('--allowedTools=mcp__cockpit_browser')
    expect(args[args.length - 1]).toBe('/UploadNoGithub')
    expect(args).not.toContain('--strict-mcp-config')
  })

  it('Codex e shell não recebem nada', () => {
    expect(launchArgs('codex', { mcpConfig: mcp }).join(' ')).not.toContain('mcp')
    expect(launchArgs('shell', { mcpConfig: mcp }).join(' ')).not.toContain('mcp')
  })

  it('sem a ponte ligada, a sessão abre sem as ferramentas (nunca falha por isso)', () => {
    expect(new McpBridge().registerSync({ tools: [], runTool: async () => ({ ok: true, content: '', summary: '' }), onTool: () => {} })).toBeNull()
  })
})

describe('ponte MCP com imagem', () => {
  const bridge = new McpBridge()
  afterAll(() => bridge.close())

  it('print vai como conteúdo de imagem, com o nome de servidor pedido', async () => {
    await bridge.start()
    const h = bridge.registerSync(
      {
        tools: [{ name: 'browser_screenshot', description: 'print', schema: { type: 'object', properties: {}, required: [] } }],
        runTool: async () => ({ ok: true, content: 'Print de x', summary: 'print', image: { data: 'QUJD', mimeType: 'image/jpeg' } }),
        onTool: () => {},
      },
      'cockpit_browser',
    )!
    const { url, headers } = JSON.parse(h.config).mcpServers.cockpit_browser
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_screenshot', arguments: {} } }) })
    const { result } = (await res.json()) as { result: { content: unknown[] } }
    expect(result.content).toEqual([{ type: 'text', text: 'Print de x' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }])
    h.dispose()
  })
})
