// ▶ Rodar → "Abrir em: Cockpit | Navegador": com Navegador, o servidor detectado abre fora (openExternal) e o browser lateral fica fechado.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Projeto Fora')
const { mkdirSync } = await import('node:fs')
mkdirSync(fixture)
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'fx', scripts: { dev: 'node server.js' } }))
writeFileSync(join(fixture, 'server.js'), "require('http').createServer((q,r)=>r.end('ok')).listen(48733,()=>console.log('  ➜  Local:   http://localhost:48733/'))")
writeFileSync(join(fixture, 'index.html'), '<h1>pagina</h1>')
writeFileSync(join(userData, 'cockpit.json'), JSON.stringify({ added: [fixture], meta: { [fixture]: { favorite: true } } }))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
// Não abre o navegador de verdade: registra as chamadas.
await app.evaluate(({ shell }) => {
  globalThis.__opened = []
  shell.openExternal = async (u) => { globalThis.__opened.push(u) }
})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /Projeto Fora/ }).first().click()
await page.getByRole('button', { name: /Rodar/ }).click()
await page.waitForTimeout(400)
const defaultOn = await page.locator('.dd-openin .seg button.on').innerText()
await page.getByRole('button', { name: /Navegador/ }).click()
await page.waitForTimeout(300)
const afterOn = await page.locator('.dd-openin .seg button.on').innerText()
await page.screenshot({ path: join(out, 'shot-openin-menu.png') })
await page.getByRole('button', { name: /dev — Projeto Fora/ }).click()
await page.waitForTimeout(4000)
const opened = await app.evaluate(() => globalThis.__opened)
const id = (await page.evaluate(() => window.cockpit.invoke('projects:list'))).find((p) => p.name === 'Projeto Fora').id
const browser = await page.evaluate((pid) => window.cockpit.invoke('browser:state', pid), id)
const dockOpen = await page.locator('.right-dock, .browser-dock').count()
await app.close()
const meta = JSON.parse(readFileSync(join(userData, 'cockpit.json'), 'utf8')).meta[fixture]
console.log(JSON.stringify({ defaultOn, afterOn, opened, browserUrl: browser?.url ?? null, dockOpen, savedOpenIn: meta.openIn, errors }, null, 2))
