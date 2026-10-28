#!/usr/bin/env node
// `claude -p` falso: confere as flags, chama a 1ª ferramenta pelo MCP do --mcp-config e responde em stream-json.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }))
  process.exit(0)
}
if (process.env.FAKE_CLAUDE_ARGS) writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ args, env: process.env.MCP_TOOL_TIMEOUT }))
const prompt = readFileSync(0, 'utf8')
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })

if (process.env.FAKE_CLAUDE_FAIL) {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} })
  process.exit(1)
}

const server = JSON.parse(flag('--mcp-config')).mcpServers.cockpit
const rpc = async (method, params, id = 1) => {
  const r = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  return (await r.json()).result
}
await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} })
const { tools } = await rpc('tools/list', {})
out({ type: 'system', subtype: 'init', tools: tools.map((t) => `mcp__cockpit__${t.name}`) })
out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
delta('Vou olhar.')
const call = await rpc('tools/call', { name: process.env.FAKE_CLAUDE_TOOL ?? tools[0].name, arguments: JSON.parse(process.env.FAKE_CLAUDE_TOOL_ARGS ?? '{}'), _meta: { 'claudecode/toolUseId': 'toolu_fake' } }, 2)
out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } })
delta(`Ferramenta: ${call.content[0].text.slice(0, 60)}${call.isError ? ' (erro)' : ''} | prompt: ${prompt.length}`)
out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } })
