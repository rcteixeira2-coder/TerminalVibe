// ▶ Rodar sempre abre no Cockpit; o Claude (falso) usa o navegador do projeto pelo MCP da sessão.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { command, launch, SHOTS, sleep, waitFor } from './lib.mjs'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-ba-')))
const proj = join(base, 'Projeto Navegador')
const other = join(base, 'Outro Projeto')
mkdirSync(join(proj, 'docs'), { recursive: true })
mkdirSync(other)
const PORT = 41000 + Math.floor(Math.random() * 2000)
writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'nav', scripts: { dev: 'node server.js' } }))
writeFileSync(join(proj, 'server.js'), `
const http = require('node:http')
const page = \`<!doctype html><title>Teste Navegador</title>
<h1>Painel de teste</h1>
<label>Nome <input id="nome" placeholder="seu nome"></label>
<button id="salvar" onclick="document.getElementById('out').textContent='clicou ' + document.getElementById('nome').value">Salvar</button>
<p id="out"></p>
<script>console.error('erro-de-teste'); fetch('/api/status')</script>\`
http.createServer((req, res) => {
  if (req.url === '/api/status') { res.writeHead(503); return res.end('fora') }
  if (req.url === '/reprint') { console.log('  - Local: http://127.0.0.1:${PORT}/'); return res.end('ok') }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(${PORT}, '127.0.0.1', () => console.log('  - Local: http://127.0.0.1:${PORT}/'))
`)
writeFileSync(join(proj, 'docs', 'index.html'), '<!doctype html><title>Docs</title><h1>Documentação</h1>')
// `claude` falso: grava os argumentos e fica vivo.
const argsFile = join(base, 'claude-args.json')
const fake = join(base, 'fake-claude')
writeFileSync(fake, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${argsFile}" "$@"\nexec sleep 600\n`)
chmodSync(fake, 0o755)

const r = {}
const { app, page, errors, close } = await launch({ store: { added: [proj, other], meta: { [proj]: { favorite: true } } }, env: { COCKPIT_TEST_CLAUDE_BIN: fake } })
const invoke = (ch, ...a) => page.evaluate(([c, args]) => window.cockpit.invoke(c, ...args), [ch, a])
const urlShown = () => page.locator('.browser input.url').first().inputValue().catch(() => '')
const browserVisible = () => page.locator('.browser').first().isVisible().catch(() => false)
try {
  const projects = await invoke('projects:list')
  const pid = projects.find((p) => p.path === proj).id
  const otherId = projects.find((p) => p.path === other).id
  await page.getByRole('button', { name: /Projeto Navegador/ }).first().click()
  const targets = await invoke('launch:targets', pid)
  const dev = targets.find((t) => t.kind === 'server')
  const doc = targets.find((t) => t.kind === 'page')

  // 1) ▶ Rodar servidor: o painel aparece com o app.
  await page.evaluate(([p, t]) => window.cockpit.invoke('launch:run', p, t, 100, 30), [pid, dev.id])
  await waitFor(async () => (await urlShown()).includes(String(PORT)), { label: 'app no painel', timeout: 45000 })
  r.devShown = await browserVisible()
  // Rodar de novo: não abre outro servidor.
  await page.evaluate(([p, t]) => window.cockpit.invoke('launch:run', p, t, 100, 30), [pid, dev.id])
  await sleep(800)
  r.devSessions = (await invoke('sessions:list')).filter((s) => s.title.startsWith('▶')).length

  // 2) ▶ Rodar numa página com o app já aberto: troca para ela.
  await page.evaluate(([p, t]) => window.cockpit.invoke('launch:run', p, t, 100, 30), [pid, doc.id])
  await waitFor(async () => (await urlShown()).includes('docs/index.html'), { label: 'página docs', timeout: 10000 })
  r.pageSwitched = true

  // 3) Caso do print: painel escondido (sem fechar o browser) e ▶ Rodar → dev com o servidor já rodando:
  //    não sobe outro, o painel volta com o endereço que ele já imprimiu.
  await command(app, 'browser')
  await sleep(400)
  r.hiddenBefore = !(await browserVisible())
  await page.evaluate(([p, t]) => window.cockpit.invoke('launch:run', p, t, 100, 30), [pid, dev.id])
  await waitFor(async () => (await browserVisible()) && (await urlShown()).includes(String(PORT)), { label: 'painel volta com o app', timeout: 10000 })
  r.reappeared = true
  r.devSessionsAfter = (await invoke('sessions:list')).filter((s) => s.title.startsWith('▶')).length

  // 4) Claude (falso) com o MCP do navegador.
  await invoke('sessions:spawn', { projectId: pid, agent: 'claude', cols: 100, rows: 30 })
  await waitFor(() => existsSync(argsFile), { label: 'claude falso' })
  const args = JSON.parse(readFileSync(argsFile, 'utf8'))
  r.allowed = args.includes('--allowedTools=mcp__cockpit_browser')
  const server = JSON.parse(args.find((a) => a.startsWith('--mcp-config=')).slice('--mcp-config='.length)).mcpServers.cockpit_browser
  let id = 0
  const call = async (name, a = {}) => {
    const res = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: a } }) })
    return (await res.json()).result
  }
  const text = (res) => res.content.find((c) => c.type === 'text')?.text ?? ''
  r.open = text(await call('browser_open', { url: `127.0.0.1:${PORT}/` }))
  r.badge = await page.locator('.browser-by').first().innerText().catch(() => null)
  const shot = await call('browser_screenshot')
  r.screenshotJpeg = shot.content.some((c) => c.type === 'image' && c.data.startsWith('/9j/') && c.data.length > 2000)
  const read = text(await call('browser_read'))
  r.readHasButton = /\[\d+\] button "Salvar"/.test(read)
  r.type = text(await call('browser_type', { selector: '#nome', value: 'Rodrigo' }))
  r.click = text(await call('browser_click', { text: 'Salvar' }))
  r.afterClick = text(await call('browser_eval', { code: "document.getElementById('out').textContent" }))
  r.console = text(await call('browser_console'))
  r.network = text(await call('browser_network'))
  r.evalBlock = text(await call('browser_eval', { code: 'const a = 2; return a * 21' }))
  r.blocked = (await call('browser_open', { url: 'https://example.com' })).isError
  await page.screenshot({ path: join(SHOTS, 'browser-agent-1.png') })

  // Outro projeto na tela: o Claude continua usando o navegador do projeto dele (desenhado fora da vista).
  await page.getByRole('button', { name: /Outro Projeto/ }).first().click()
  await sleep(500)
  const bg = await call('browser_screenshot')
  r.backgroundShot = bg.content.some((c) => c.type === 'image' && c.data.length > 2000)
  r.stayedOnOther = (await page.locator('.ph-name').first().innerText()) === 'Outro Projeto'
  void otherId
  r.errors = errors.filter((e) => !/Debugger (listening|ending) on ws:/.test(e))
} finally {
  await close()
}
console.log(JSON.stringify(r, null, 2))
const ok = r.devShown && r.devSessions === 1 && r.devSessionsAfter === 1 && r.pageSwitched && r.hiddenBefore && r.reappeared && r.allowed && r.screenshotJpeg && r.readHasButton &&
  r.afterClick === 'clicou Rodrigo' && r.console.includes('erro-de-teste') && r.network.includes('503') && r.evalBlock === '42' && r.blocked &&
  r.badge?.includes('Claude') && r.backgroundShot && r.stayedOnOther && !r.errors.length
console.log(ok ? 'OK' : 'FALHOU')
process.exit(ok ? 0 : 1)
