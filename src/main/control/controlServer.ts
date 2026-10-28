import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { CONTROL_VERSION, MAX_LINE, parseCommand, tokenMatches, type ControlCommand, type ControlReply } from './protocol'

export interface ControlHandler {
  open(projectPath: string): Promise<ControlReply> | ControlReply
  request(projectPath: string, prompt: string, remoteName: string): Promise<ControlReply> | ControlReply
  finish(projectPath: string): Promise<ControlReply> | ControlReply
  interruptHermes(): Promise<ControlReply> | ControlReply
  sessions(): Promise<ControlReply> | ControlReply
  tail(sessionId: string, lines: number): Promise<ControlReply> | ControlReply
  send(sessionId: string, text: string, enter: boolean): Promise<ControlReply> | ControlReply
  focus(sessionId: string): Promise<ControlReply> | ControlReply
  // Cliente acabou de se autenticar: eventos que ele perdeu (ex.: sessões que já precisam de você).
  connected?(push: (event: Record<string, unknown>) => void): void
}

export interface ControlServer {
  server: Server
  // Evento para todo cliente autenticado (ex.: link do Remote Control).
  broadcast(event: Record<string, unknown>): void
}

// Socket do Hermes: só o usuário (0600, pasta 0700) e, além disso, o token desta execução gravado em
// control.token (0600). A primeira linha precisa ser `hello` com o token; sem isso a conexão cai.
export function startControlServer(sockPath: string, tokenPath: string, token: string, handler: ControlHandler): ControlServer {
  if (Buffer.byteLength(sockPath) >= 104) throw new Error(`caminho do socket longo demais: ${sockPath}`)
  const dir = dirname(sockPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (existsSync(sockPath)) rmSync(sockPath)
  writeFileSync(tokenPath, token, { mode: 0o600 })
  chmodSync(tokenPath, 0o600)
  const clients = new Set<Socket>()
  const server = createServer((conn) => {
    let authed = false
    // Já chegou um hello (ainda na fila): comandos seguintes na mesma leitura podem esperar por ele.
    let helloSeen = false
    let buf = ''
    // Comandos em ordem: o próximo só roda depois da resposta do anterior.
    let queue = Promise.resolve()
    const reply = (id: number, r: ControlReply) => {
      if (!conn.destroyed) conn.write(`${JSON.stringify({ id, ...r })}\n`)
    }
    const handle = async (c: ControlCommand) => {
      if (c.cmd === 'hello') {
        if (authed || !tokenMatches(c.token, token)) return conn.destroy()
        if (c.version !== CONTROL_VERSION) {
          reply(c.id, { ok: false, error: `Versão do protocolo incompatível (Cockpit ${CONTROL_VERSION}).` })
          return conn.end()
        }
        authed = true
        clients.add(conn)
        reply(c.id, { ok: true })
        handler.connected?.((event) => !conn.destroyed && conn.write(`${JSON.stringify(event)}\n`))
        return
      }
      if (!authed) return conn.destroy()
      let r: ControlReply
      try {
        if (c.cmd === 'open') r = await handler.open(c.projectPath)
        else if (c.cmd === 'request') r = await handler.request(c.projectPath, c.prompt, c.remoteName)
        else if (c.cmd === 'finish') r = await handler.finish(c.projectPath)
        else if (c.cmd === 'sessions') r = await handler.sessions()
        else if (c.cmd === 'tail') r = await handler.tail(c.sessionId, c.lines)
        else if (c.cmd === 'send') r = await handler.send(c.sessionId, c.text, c.enter)
        else if (c.cmd === 'focus') r = await handler.focus(c.sessionId)
        else r = await handler.interruptHermes()
      } catch (e) {
        r = { ok: false, error: (e as Error).message || 'Erro no Cockpit.' }
      }
      reply(c.id, r)
    }
    // Sem hello em 5 s, a conexão cai; autenticada, fica aberta para receber eventos.
    const helloTimer = setTimeout(() => !authed && conn.destroy(), 5000)
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (buf.length > MAX_LINE && !buf.includes('\n')) return conn.destroy()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const c = parseCommand(line)
        if (!c || (!helloSeen && c.cmd !== 'hello')) return conn.destroy()
        if (c.cmd === 'hello') helloSeen = true
        queue = queue.then(async () => void (await handle(c)))
      }
    })
    conn.on('close', () => {
      clearTimeout(helloTimer)
      clients.delete(conn)
    })
    conn.on('error', () => conn.destroy())
  })
  server.listen(sockPath, () => {
    try {
      chmodSync(sockPath, 0o600)
    } catch {
      // ignore
    }
  })
  return {
    server,
    broadcast: (event) => {
      const line = `${JSON.stringify(event)}\n`
      for (const c of clients) if (!c.destroyed) c.write(line)
    },
  }
}
