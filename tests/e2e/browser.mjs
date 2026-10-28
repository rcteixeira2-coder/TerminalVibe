// Projeto fixture com servidor HTTP: ▶ Rodar → painel do browser abre sozinho; árvore, prévia e paleta.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Projeto Teste')
mkdirSync(join(fixture, 'src'), { recursive: true })
mkdirSync(join(fixture, 'node_modules'))
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'fx', scripts: { dev: 'node server.js' } }))
writeFileSync(join(fixture, 'server.js'), `require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<h1 style="font:40px sans-serif;color:#2e5cd1">Servidor do Projeto Teste</h1>')}).listen(0,()=>{const p=require('http').globalAgent;console.log('  ➜  Local:   http://localhost:'+this_port())});function this_port(){return 0}`.replace("listen(0,()=>{const p=require('http').globalAgent;console.log('  ➜  Local:   http://localhost:'+this_port())});function this_port(){return 0}", "listen(48731,()=>console.log('  ➜  Local:   http://localhost:48731/'))"))
writeFileSync(join(fixture, 'src', 'app.ts'), 'export const ok = 1\n')
writeFileSync(join(fixture, 'index.html'), '<h1>pagina local</h1>')
writeFileSync(join(userData, 'cockpit.json'), JSON.stringify({ added: [fixture], meta: { [fixture]: { favorite: true } } }))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '', COCKPIT_SHOT_DIR: out } })
const logs = []
app.process().stderr?.on('data', (d) => logs.push(`[main:err] ${String(d).slice(0, 300)}`))
const page = await app.firstWindow()
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /Projeto Teste/ }).first().click()
await page.getByRole('button', { name: /Rodar/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, 'shot-8-launch-menu.png') })
await page.getByRole('button', { name: /dev — Projeto Teste/ }).click()
await page.waitForTimeout(4000)
const state = await page.evaluate((id) => window.cockpit.invoke('browser:state', id), (await page.evaluate(() => window.cockpit.invoke('projects:list'))).find((p) => p.name === 'Projeto Teste').id)
await page.screenshot({ path: join(out, 'shot-9-browser.png') })
// O WebContentsView do browser não aparece no screenshot da página: confere pelo main.
const viewRaw = await app.evaluate(async ({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://'))
  const views = win.contentView.children
  const v = views[views.length - 1]
  const text = await v.webContents.executeJavaScript('document.body.innerText')
  const img = await v.webContents.capturePage()
  return { count: views.length, bounds: v.getBounds(), visible: v.getVisible(), text, png: img.toPNG().toString('base64') }
})
// Árvore + prévia
const { png, ...view } = viewRaw
writeFileSync(join(out, 'shot-9b-browser-view.png'), Buffer.from(png, 'base64'))
await page.getByTitle(/Árvore de arquivos/).click()
await page.waitForTimeout(600)
await page.getByText('src', { exact: true }).click()
await page.waitForTimeout(400)
await page.getByText('app.ts', { exact: true }).dblclick()
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'shot-10-preview.png') })
await page.keyboard.press('Escape')
// Paleta (via comando, já que atalhos de menu nativo não chegam pelo Playwright)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).webContents.send('ui:command', 'palette'))
await page.waitForTimeout(400)
await page.keyboard.type('claude')
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, 'shot-11-palette.png') })
const sessions = await page.evaluate(() => window.cockpit.invoke('sessions:list'))
console.log(JSON.stringify({ browser: state, view, sessions: sessions.map((s) => ({ title: s.title, lifecycle: s.lifecycle })), logs }, null, 2))
await app.close()
