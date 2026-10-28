import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentToolCall } from '@shared/types'
import type { ToolDef, ToolResult } from './tools'

// Servidor MCP (HTTP, JSON-RPC) só em 127.0.0.1 que entrega ao Claude Code as ferramentas da conversa
// em andamento. Cada resposta registra um token aleatório; sem ele (ou vindo de um navegador) nada passa.
// A chamada fica aberta enquanto o usuário decide Aplicar/Recusar, então o Claude espera.

const MAX_BODY = 1024 * 1024

export interface BridgeRun {
  tools: ToolDef[]
  runTool(name: string, input: Record<string, unknown>): Promise<ToolResult>
  onTool(call: AgentToolCall): void
}

export interface BridgeHandle {
  config: string
  dispose(): void
}

export class McpBridge {
  private server: Server | null = null
  private port: Promise<number> | null = null
  private portNow: number | null = null
  private runs = new Map<string, BridgeRun>()

  // O main liga a ponte na abertura: sessões do Claude são criadas de forma síncrona e precisam da porta.
  start(): Promise<number> {
    this.port ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.requestTimeout = 0
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.portNow = (server.address() as { port: number }).port
        resolve(this.portNow)
      })
      this.server = server
    })
    return this.port
  }

  // Devolve a config `--mcp-config` (servidor `name`) e a função que a desfaz.
  async register(run: BridgeRun, name = 'cockpit'): Promise<BridgeHandle> {
    await this.start()
    return this.registerSync(run, name)!
  }

  // Sem a ponte ligada ainda: null (a sessão abre sem as ferramentas, nunca falha por isso).
  registerSync(run: BridgeRun, name = 'cockpit'): BridgeHandle | null {
    if (this.portNow === null) return null
    const token = randomBytes(24).toString('hex')
    this.runs.set(token, run)
    const config = JSON.stringify({
      mcpServers: { [name]: { type: 'http', url: `http://127.0.0.1:${this.portNow}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
    })
    return { config, dispose: () => this.runs.delete(token) }
  }

  close(): void {
    this.server?.close()
    this.server = null
    this.port = null
    this.portNow = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    // Navegadores mandam Origin; DNS rebinding troca o Host. O Claude Code não faz nenhum dos dois.
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) return json(403)
    const token = /^Bearer ([0-9a-f]{48})$/.exec(req.headers.authorization ?? '')?.[1]
    const run = token ? this.runs.get(token) : undefined
    if (!run) return json(401)
    if (req.method !== 'POST') return json(405)
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > MAX_BODY) return json(413)
    }
    let msg: { id?: string | number; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(body)
    } catch {
      return json(400)
    }
    // Notificações (sem id) não têm resposta.
    if (msg.id === undefined) return json(202)
    const reply = (result: unknown) => json(200, { jsonrpc: '2.0', id: msg.id, result })
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'cockpit', version: '1.0.0' },
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: run.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) })
      case 'tools/call': {
        const name = String(msg.params?.name ?? '')
        const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? (msg.params.arguments as Record<string, unknown>) : {}
        const meta = msg.params?._meta as Record<string, unknown> | undefined
        const id = typeof meta?.['claudecode/toolUseId'] === 'string' ? (meta['claudecode/toolUseId'] as string) : randomUUID()
        if (!run.tools.some((t) => t.name === name)) return reply({ content: [{ type: 'text', text: `Ferramenta desconhecida: ${name}` }], isError: true })
        run.onTool({ id, name, summary: name })
        const r = await run.runTool(name, args)
        run.onTool({ id, name, summary: r.summary, ok: r.ok, detail: r.ok ? undefined : r.content.slice(0, 300) })
        const content: unknown[] = [{ type: 'text', text: r.content }]
        if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType })
        return reply({ content, isError: !r.ok })
      }
      default:
        return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Método não suportado: ${msg.method}` } })
    }
  }
}
