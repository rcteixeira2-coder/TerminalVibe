// Servidores falsos (SSE) que imitam a API compatível com OpenAI e a Messages API da Anthropic.
// Rodada 1: pedem a ferramenta read_file(README.md). Rodada 2: respondem com texto citando o arquivo.
import { createServer } from 'node:http'

const sse = (res) => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

export function startFakeOpenAI({ status = 200, file = 'README.md' } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(status === 200 ? 200 : status, { 'content-type': 'application/json' })
        res.end(status === 200 ? JSON.stringify({ object: 'list', data: [{ id: 'grok-fake', object: 'model' }, { id: 'grok-fake-mini', object: 'model' }] }) : JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'erro falso' } }))
        return
      }
      const json = JSON.parse(body)
      calls.push({ auth: req.headers.authorization, body: json })
      const hasTool = json.messages.some((m) => m.role === 'tool')
      sse(res)
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: json.model }
      if (!hasTool) {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'vou ler o arquivo' } }] })
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] })
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `{"path":"${file}"` } }] } }] })
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ', "end_line": 3}' } }] } }] })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        const tool = json.messages.find((m) => m.role === 'tool')
        const first = (tool.content.split('\n')[0] || '').slice(0, 60)
        for (const piece of ['O arquivo ', '`README.md:1`', ' começa com: ', JSON.stringify(first)]) send({ ...base, choices: [{ index: 0, delta: { content: piece } }] })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` })))
}

export function startFakeAnthropic() {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const json = JSON.parse(body || '{}')
      calls.push({ key: req.headers['x-api-key'] ?? req.headers.authorization, beta: req.headers['anthropic-beta'], body: json })
      const last = json.messages[json.messages.length - 1]
      const hasTool = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')
      sse(res)
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 90, output_tokens: 1, cache_read_input_tokens: hasTool ? 80 : 0, cache_creation_input_tokens: 0 } } })
      if (!hasTool) {
        ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } })
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "README.md", ' } })
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"end_line": 2}' } })
        ev('content_block_stop', { index: 0 })
        ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 15 } })
      } else {
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        for (const t of ['Li o ', '`README.md:1`', '. Tudo certo.']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })
        ev('content_block_stop', { index: 0 })
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
      }
      ev('message_stop', {})
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })))
}
