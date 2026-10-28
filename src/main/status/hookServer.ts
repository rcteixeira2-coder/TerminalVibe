import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import type { HookPayload } from '@shared/status'

const MAX_PAYLOAD = 256 * 1024

// Recebe `token paneId bytes\n<json do hook>` de resources/claude-plugin/hooks/report.sh.
// O tamanho no cabeçalho permite responder sem esperar EOF (o nc do macOS não faz half-close).
export function expectedLength(buf: Buffer): number | null {
  const nl = buf.indexOf(0x0a)
  if (nl < 0) return null
  const n = Number(buf.subarray(0, nl).toString('utf8').trim().split(' ')[2])
  return Number.isInteger(n) && n >= 0 ? nl + 1 + n : null
}

export function parseHookMessage(raw: string, token: string): { paneId: string; payload: HookPayload } | null {
  const nl = raw.indexOf('\n')
  if (nl < 0) return null
  const [tok, paneId] = raw.slice(0, nl).trim().split(' ')
  if (!tok || !paneId || !safeEqual(tok, token)) return null
  if (!/^[0-9a-f-]{36}$/i.test(paneId)) return null
  try {
    const payload = JSON.parse(raw.slice(nl + 1)) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    return { paneId, payload: payload as HookPayload }
  } catch {
    return null
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function startHookServer(
  sockPath: string,
  token: string,
  onMessage: (paneId: string, payload: HookPayload) => void,
): Server {
  if (Buffer.byteLength(sockPath) >= 104) throw new Error(`caminho do socket longo demais: ${sockPath}`)
  const dir = dirname(sockPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (existsSync(sockPath)) rmSync(sockPath)
  const server = createServer((conn) => {
    let size = 0
    let done = false
    const chunks: Buffer[] = []
    const finish = () => {
      if (done) return
      done = true
      const msg = parseHookMessage(Buffer.concat(chunks).toString('utf8'), token)
      if (msg) onMessage(msg.paneId, msg.payload)
      conn.end()
    }
    conn.setTimeout(3000, () => conn.destroy())
    conn.on('data', (c) => {
      size += c.length
      if (size > MAX_PAYLOAD) {
        done = true
        conn.destroy()
        return
      }
      chunks.push(c)
      const want = expectedLength(Buffer.concat(chunks))
      if (want !== null && size >= want) finish()
    })
    conn.on('end', finish)
    conn.on('error', () => conn.destroy())
  })
  server.listen(sockPath, () => {
    try {
      chmodSync(sockPath, 0o600)
    } catch {
      // ignore
    }
  })
  return server
}
