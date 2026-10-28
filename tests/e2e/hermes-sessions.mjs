// Robô das sessões no Hermes: o canal de controle lista, lê, responde, foca e avisa "precisa de você".
// Uso: npm run build && node tests/e2e/hermes-sessions.mjs
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer, launch, openAgent, sleep, waitFor } from './lib.mjs'

const { page, userData, errors, close } = await launch()
const fail = (m) => {
  console.error(`FALHOU: ${m}`)
  process.exitCode = 1
}

// Cliente do Hermes: hello com o token e depois uma linha JSON por comando.
const sock = connect(join(userData, 'run', 'control.sock'))
await new Promise((r) => sock.once('connect', r))
const replies = new Map()
const events = []
let buf = ''
sock.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    if (m.id !== undefined) replies.set(m.id, m)
    else events.push(m)
  }
})
let next = 1
const call = async (body) => {
  const id = next++
  sock.write(`${JSON.stringify({ id, ...body })}\n`)
  return waitFor(() => replies.get(id), { label: `resposta de ${body.cmd}` })
}
const token = readFileSync(join(userData, 'run', 'control.token'), 'utf8')
if (!(await call({ cmd: 'hello', token, version: 1 })).ok) fail('hello')

const s = await openAgent(page, 'Terminal')
await sleep(1500)

// Um "claude" de mentira em primeiro plano (link para o sleep: uma cópia perde a assinatura e o macOS a mata) e, depois, o mesmo OSC 7501 do Claude Code pedindo aprovação.
const bin = mkdtempSync(join(tmpdir(), 'ck-fake-'))
symlinkSync('/bin/sleep', join(bin, 'claude'))
const msg = Buffer.from('Bash: npm test').toString('base64')
await page.keyboard.type(`clear; echo segredo sk-abcdefghijklmnopqrst; (sleep 4; printf '\\033]7501;state=blocked:app=claude-code:kind=permission:msg=${msg}\\033\\\\') & ${join(bin, 'claude')} 60\n`)

const attention = await waitFor(() => events.find((e) => e.event === 'attention' && e.sessionId === s.id), { timeout: 30000, label: 'evento attention' })
  .catch(async (e) => {
    console.error('estado:', JSON.stringify((await call({ cmd: 'sessions' })).sessions), JSON.stringify(events))
    console.error('tela:', (await buffer(page, s.id)).slice(-600))
    throw e
  })
console.log('attention:', JSON.stringify(attention))
if (attention.projectName !== 'Terminal' || attention.agent !== 'claude' || !/npm test/.test(attention.detail ?? '')) fail('dados do aviso')

const list = await call({ cmd: 'sessions' })
const mine = list.sessions?.find((x) => x.id === s.id)
console.log('sessions:', JSON.stringify(mine))
if (!mine?.needsMe || mine.activity !== 'needs_approval') fail('sessão listada como precisando de você')

const tail = await call({ cmd: 'tail', sessionId: s.id, lines: 40 })
if (!tail.ok || !tail.text.includes('segredo') || tail.text.includes('sk-abcdefghijklmnopqrst')) fail(`tail mascarado: ${tail.text}`)
else console.log('tail mascarado: ok')

const bad = await call({ cmd: 'send', sessionId: 'nao-existe', text: 'oi' })
if (bad.ok) fail('send em sessão inexistente deveria falhar')

// Sai do "claude" (Ctrl+C pelo teclado) e responde pelo canal: o texto chega colado e com Enter.
await page.keyboard.press('Control+C')
await sleep(800)
const sent = await call({ cmd: 'send', sessionId: s.id, text: 'echo resposta-do-hermes' })
if (!sent.ok) fail('send')
await waitFor(async () => (await buffer(page, s.id)).includes('\nresposta-do-hermes'), { label: 'texto do Hermes executado' })
console.log('send: ok')

const cleared = await waitFor(() => events.find((e) => e.event === 'attentionCleared' && e.sessionId === s.id), { timeout: 20000, label: 'attentionCleared' })
console.log('cleared:', JSON.stringify(cleared))

if (!(await call({ cmd: 'focus', sessionId: s.id })).ok) fail('focus')

// O robô antigo saiu: nada de botão 🤖 nem item no ⌘K.
if (await page.locator('.robot-btn').count()) fail('botão do robô ainda aparece')

// Erros do app até aqui (ao fechar, o Playwright escreve "Debugger ending" no stderr).
if (errors.length) fail(`erros: ${errors.join(' | ')}`)
sock.destroy()
await close()
console.log(process.exitCode ? 'FALHOU' : 'OK — canal do robô das sessões')
