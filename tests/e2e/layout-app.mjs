// "+ App" num espaço do layout (site do projeto), ⤢ expandir/restaurar e divisórias (arrastar e duplo clique).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, SHOTS, sleep } from './lib.mjs'

const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Projeto App')
mkdirSync(fixture)
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'fx', scripts: { dev: 'node server.js' } }))
writeFileSync(join(fixture, 'server.js'), "require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<h1>App do Projeto</h1>')}).listen(48741,()=>console.log('  Local: http://localhost:48741/'))")
const { app, page, errors, close } = await launch({ store: { added: [fixture], meta: { [fixture]: { favorite: true } } } })
const r = {}
const view = () => app.evaluate(async ({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://'))
  const v = win.contentView.children[win.contentView.children.length - 1]
  if (!v) return null
  return { bounds: v.getBounds(), visible: v.getVisible(), text: await v.webContents.executeJavaScript('document.body?.innerText ?? ""').catch(() => '') }
})
const slotBox = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }

await page.getByRole('button', { name: /Projeto App/ }).first().click()
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await sleep(800)
await page.getByTitle('Layout dos terminais').click()
await page.getByRole('button', { name: /^1 grande \+ 2 empilhados/ }).click()
await sleep(400)
await page.locator('.empty-slot').first().getByRole('button', { name: '+ App' }).click()
await sleep(800)
r.appPanes = await page.locator('.app-pane').count()
r.dockOpen = await page.locator('.right-dock').count()
// ▶ Rodar dentro do App vazio → servidor sobe num terminal e a página carrega no espaço.
await page.getByRole('button', { name: /Rodar o projeto/ }).click()
await page.getByRole('button', { name: /dev — Projeto App/ }).click()
await page.waitForFunction(() => document.querySelector('.app-pane .pane-task')?.textContent?.includes('localhost:48741'), null, { timeout: 15000 })
await sleep(1200)
r.slots = await page.$$eval('.slot', (els) => els.map((e) => (e.querySelector('.pane-title')?.textContent ?? '(livre)')))
const v1 = await view()
r.viewText = v1?.text
r.viewBounds = v1?.bounds
r.appBox = await slotBox('.app-pane .browser-slot')
await page.screenshot({ path: join(SHOTS, 'shot-layout-app.png') })
// Divisória principal: arrasta para a direita (o App fica mais estreito) e a view acompanha.
const sash = page.locator('.pane-area .sash-vertical').first()
const sb = await sash.boundingBox()
await page.mouse.move(sb.x + sb.width / 2, sb.y + 300)
await page.mouse.down()
await page.mouse.move(sb.x + 250, sb.y + 300, { steps: 10 })
await page.mouse.up()
await sleep(500)
r.appBoxAfterDrag = await slotBox('.app-pane .browser-slot')
r.viewAfterDrag = (await view())?.bounds
// Duplo clique: volta à proporção do layout.
const sb2 = await page.locator('.pane-area .sash-vertical').first().boundingBox()
await page.mouse.dblclick(sb2.x + sb2.width / 2, sb2.y + 300)
await sleep(600)
r.appBoxAfterReset = await slotBox('.app-pane .browser-slot')
// ⤢ no terminal: aba toda, os outros seguem rodando; clicar na faixa volta.
await page.locator('.slot .pane:not(.app-pane) .max-btn').first().click()
await sleep(500)
r.maxSlots = await page.locator('.slot').count()
r.maxBar = await page.locator('.max-bar').innerText().catch(() => null)
r.viewWhileTermMax = (await view())?.visible
r.running = (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).map((s) => s.lifecycle)
await page.screenshot({ path: join(SHOTS, 'shot-layout-max.png') })
await page.locator('.max-bar').click()
await sleep(500)
r.restoredSlots = await page.locator('.slot').count()
// ⤢ no App: a view ocupa a área toda.
await page.locator('.app-pane .max-btn').click()
await sleep(700)
r.appMaxView = (await view())?.bounds
r.appMaxBox = await slotBox('.app-pane .browser-slot')
await page.locator('.app-pane .max-btn').click()
await sleep(400)
await close()
console.log(JSON.stringify({ ...r, errors: errors.filter((e) => !/Debugger/.test(e)) }, null, 2))
