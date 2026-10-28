import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startControlServer, type ControlHandler } from '../../src/main/control/controlServer'
import { AttentionTracker, asksTrust, maskSecrets, parseCommand, pasteText, remoteControlName, RemoteScan, sessionUrl, UNTRUSTED } from '../../src/main/control/protocol'
import { launchArgs } from '../../src/main/pty/launch'

const TOKEN = 'a'.repeat(48)

function setup(handler: Partial<ControlHandler> = {}) {
  // Caminho curto: sockets Unix aceitam até 104 bytes.
  const dir = mkdtempSync(join('/tmp', 'ck-'))
  const sock = join(dir, 'run', 'c.sock')
  const tokenPath = join(dir, 'run', 'c.token')
  const calls: string[] = []
  const ok = { ok: true as const }
  const srv = startControlServer(sock, tokenPath, TOKEN, {
    open: (p) => (calls.push(`open ${p}`), ok),
    request: (p, prompt, name) => (calls.push(`request ${p} ${prompt} ${name}`), ok),
    finish: (p) => (calls.push(`finish ${p}`), ok),
    interruptHermes: () => (calls.push('interrupt'), ok),
    sessions: () => ({ ok: true as const, sessions: [] }),
    tail: (id, n) => ({ ok: true as const, text: `${id}:${n}` }),
    send: (id, text, enter) => (calls.push(`send ${id} ${text} ${enter}`), ok),
    focus: (id) => (calls.push(`focus ${id}`), ok),
    ...handler,
  })
  return { srv, sock, tokenPath, calls }
}

// Manda linhas e junta as respostas até `want` linhas ou o socket fechar.
function talk(sock: string, lines: unknown[], want: number): Promise<{ replies: Record<string, unknown>[]; closed: boolean }> {
  return new Promise((resolve) => {
    const c = connect(sock)
    let buf = ''
    const replies: Record<string, unknown>[] = []
    const done = (closed: boolean) => {
      c.destroy()
      resolve({ replies, closed })
    }
    c.on('connect', () => c.write(lines.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join('')))
    c.on('data', (d) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buf.slice(0, nl)))
        buf = buf.slice(nl + 1)
      }
      if (replies.length >= want) done(false)
    })
    c.on('close', () => done(true))
    c.on('error', () => done(true))
  })
}

const hello = { id: 1, cmd: 'hello', token: TOKEN, version: 1 }
let current: ReturnType<typeof setup> | null = null
afterEach(() => {
  current?.srv.server.close()
  current = null
})

describe('canal de controle do Hermes', () => {
  it('grava o token só para o usuário', async () => {
    current = setup()
    await new Promise((r) => current!.srv.server.once('listening', r))
    expect(readFileSync(current.tokenPath, 'utf8')).toBe(TOKEN)
    expect(statSync(current.tokenPath).mode & 0o777).toBe(0o600)
    expect(statSync(current.sock).mode & 0o777).toBe(0o600)
  })

  it('recusa token errado e comando antes do hello', async () => {
    current = setup()
    const bad = await talk(current.sock, [{ ...hello, token: 'b'.repeat(48) }, { id: 2, cmd: 'interruptHermes' }], 1)
    expect(bad.closed).toBe(true)
    expect(bad.replies).toEqual([])
    const early = await talk(current.sock, [{ id: 2, cmd: 'open', projectPath: '/x' }], 1)
    expect(early.closed).toBe(true)
    expect(current.calls).toEqual([])
  })

  it('aceita comandos na mesma leitura do hello, em ordem', async () => {
    current = setup()
    const r = await talk(current.sock, [
      hello,
      { id: 2, cmd: 'open', projectPath: '/p' },
      { id: 3, cmd: 'request', projectPath: '/p', prompt: 'faça X', remoteName: 'Proj' },
      { id: 4, cmd: 'finish', projectPath: '/p' },
    ], 4)
    expect(r.replies.map((x) => x.id)).toEqual([1, 2, 3, 4])
    expect(r.replies.every((x) => x.ok === true)).toBe(true)
    expect(current.calls).toEqual(['open /p', 'request /p faça X Proj', 'finish /p'])
  })

  it('versão diferente responde com erro', async () => {
    current = setup()
    const r = await talk(current.sock, [{ ...hello, version: 9 }], 1)
    expect(r.replies[0]).toMatchObject({ id: 1, ok: false })
  })

  it('erro do handler vira resposta, sem derrubar o canal', async () => {
    current = setup({ open: () => Promise.reject(new Error('falhou')) })
    const r = await talk(current.sock, [hello, { id: 2, cmd: 'open', projectPath: '/p' }, { id: 3, cmd: 'interruptHermes' }], 3)
    expect(r.replies[1]).toEqual({ id: 2, ok: false, error: 'falhou' })
    expect(r.replies[2]).toEqual({ id: 3, ok: true })
  })

  it('eventos chegam aos clientes autenticados', async () => {
    current = setup()
    const got = new Promise<string>((resolve) => {
      const c = connect(current!.sock)
      let buf = ''
      c.on('connect', () => c.write(`${JSON.stringify(hello)}\n`))
      c.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('"ok":true')) {
          current!.srv.broadcast({ event: 'remote', projectPath: '/p', message: 'https://claude.ai/code/session_abc12345' })
          buf = buf.slice(buf.indexOf('\n') + 1)
        }
        if (buf.includes('"event"')) {
          c.destroy()
          resolve(buf.trim())
        }
      })
    })
    expect(JSON.parse(await got)).toEqual({ event: 'remote', projectPath: '/p', message: 'https://claude.ai/code/session_abc12345' })
  })
})

describe('robô das sessões', () => {
  it('lista, lê, responde e foca pelo canal', async () => {
    current = setup()
    const r = await talk(current.sock, [
      hello,
      { id: 2, cmd: 'sessions' },
      { id: 3, cmd: 'tail', sessionId: 's1', lines: 9999 },
      { id: 4, cmd: 'send', sessionId: 's1', text: 'aprova o plano' },
      { id: 5, cmd: 'focus', sessionId: 's1' },
    ], 5)
    expect(r.replies[1]).toEqual({ id: 2, ok: true, sessions: [] })
    expect(r.replies[2]).toEqual({ id: 3, ok: true, text: 's1:200' })
    expect(current.calls).toEqual(['send s1 aprova o plano true', 'focus s1'])
  })

  it('evento perdido chega a quem conecta depois', async () => {
    current = setup({ connected: (push) => push({ event: 'attention', sessionId: 's1' }) })
    const r = await talk(current.sock, [hello], 2)
    expect(r.replies[1]).toEqual({ event: 'attention', sessionId: 's1' })
  })

  it('confere tipos e tamanhos', () => {
    expect(parseCommand('{"id":1,"cmd":"send","sessionId":"s","text":"   "}')).toBeNull()
    expect(parseCommand(JSON.stringify({ id: 1, cmd: 'send', sessionId: 's', text: 'x'.repeat(1001) }))).toBeNull()
    expect(parseCommand('{"id":1,"cmd":"send","sessionId":"s","text":"ok","enter":false}')).toEqual({ id: 1, cmd: 'send', sessionId: 's', text: 'ok', enter: false })
    expect(parseCommand('{"id":1,"cmd":"tail","sessionId":"s"}')).toEqual({ id: 1, cmd: 'tail', sessionId: 's', lines: 60 })
    expect(parseCommand('{"id":1,"cmd":"tail","sessionId":"s","lines":0}')).toMatchObject({ lines: 1 })
    expect(parseCommand('{"id":1,"cmd":"focus"}')).toBeNull()
  })

  it('segredos da saída saem mascarados', () => {
    expect(maskSecrets('export OPENAI=sk-abcdefghijklmnop ok')).toBe('export OPENAI=[oculto] ok')
    expect(maskSecrets('senha: hunter22222')).toBe('[oculto]')
    expect(maskSecrets('Rodar os testes? (y/n)')).toBe('Rodar os testes? (y/n)')
  })

  it('avisa só quando o estado dura e uma vez por entrada', () => {
    vi.useFakeTimers()
    const events: Record<string, unknown>[] = []
    const t = new AttentionTracker((e) => events.push(e), (id) => ({ sessionId: id }), 1000)
    t.update('a', true)
    t.update('a', false) // passou rápido por your_turn: nada
    vi.advanceTimersByTime(2000)
    expect(events).toEqual([])
    t.update('a', true)
    t.update('a', true)
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([{ event: 'attention', sessionId: 'a' }])
    expect(t.current()).toEqual(['a'])
    t.update('a', false)
    expect(events[1]).toEqual({ event: 'attentionCleared', sessionId: 'a' })
    vi.useRealTimers()
  })
})

describe('protocolo', () => {
  it('ignora campos e tipos inesperados', () => {
    expect(parseCommand('{"id":1,"cmd":"rm"}')).toBeNull()
    expect(parseCommand('{"id":"1","cmd":"interruptHermes"}')).toBeNull()
    expect(parseCommand('{"id":1,"cmd":"request","projectPath":"/p","prompt":"  ","remoteName":"x"}')).toBeNull()
    expect(parseCommand('nada')).toBeNull()
    expect(parseCommand('{"id":1,"cmd":"open","projectPath":"/p","extra":1}')).toEqual({ id: 1, cmd: 'open', projectPath: '/p' })
  })

  it('nome do Remote Control sem controle nem cara de opção', () => {
    expect(remoteControlName('--yolo\nProj')).toBe('yolo Proj · Hermes')
    expect(remoteControlName('')).toBe('Projeto · Hermes')
  })

  it('colagem sem caracteres que encerram a colagem', () => {
    expect(pasteText('a\x1b[201~b\nc\r')).toBe('\x1b[200~a[201~b\nc\x1b[201~')
    expect(pasteText('x'.repeat(5000)).length).toBe(1000 + 12)
  })

  it('acha o link e o aviso de confiança na saída', () => {
    expect(sessionUrl('\x1b[1mRemote: https://claude.ai/code/session_01AbCdEf\x1b[0m')).toBe('https://claude.ai/code/session_01AbCdEf')
    expect(asksTrust('Quick safety\r\ncheck: Is this a project you trust?')).toBe(true)
    const scan = new RemoteScan(0, 1000)
    expect(scan.feed('carregando...')).toBeNull()
    expect(scan.feed('https://claude.ai/code/ses')).toBeNull()
    expect(scan.feed('sion_0123456789 ')).toBe('https://claude.ai/code/session_0123456789')
    expect(new RemoteScan(0, 1000).feed('Yes, I trust this folder')).toBe(UNTRUSTED)
    expect(scan.expired(2000)).toBe(true)
  })

  it('pedido do Hermes: Remote Control em modo plano, pedido depois de --', () => {
    const args = launchArgs('claude', { newClaudeSessionId: 'id', remoteControl: 'Proj · Hermes', initialPrompt: '-faça X' })
    expect(args).toEqual(['--session-id', 'id', '--remote-control=Proj · Hermes', '--permission-mode=plan', '--', '-faça X'])
    // Sem Hermes, nada muda.
    expect(launchArgs('claude', { initialPrompt: '/UploadNoGithub' })).toEqual(['/UploadNoGithub'])
  })
})
