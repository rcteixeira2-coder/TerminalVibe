// Menu ▦ de layouts: escolher layout, abrir terminal num espaço vazio, arrastar pelo cabeçalho, divisória salva e lembrada.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, SHOTS, sleep } from './lib.mjs'

const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Projeto Layout')
mkdirSync(fixture)
const store = { added: [fixture], meta: { [fixture]: { favorite: true } } }
const r = {}
let { page, errors, userData, close } = await launch({ store })
const titles = () => page.$$eval('.slot', (els) => els.map((e) => e.querySelector('.pane-title')?.textContent ?? '(livre)'))
await page.getByRole('button', { name: /Projeto Layout/ }).first().click()
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await sleep(800)
await page.getByTitle(/Dividir com terminal/).click()
await sleep(800)
r.autoSlots = await titles()
// Menu ▦
await page.getByTitle('Layout dos terminais').click()
await sleep(300)
await page.screenshot({ path: join(SHOTS, 'shot-layout-menu.png') })
r.menuItems = await page.$$eval('.layout-item', (els) => els.map((e) => `${e.textContent}${e.disabled ? ' (off)' : ''}`))
await page.getByRole('button', { name: /^1 grande \+ 2 empilhados/ }).click()
await sleep(600)
r.mainLeftSlots = await titles()
// Abre um Claude? Não: um terminal no espaço livre (sem gastar nada).
await page.locator('.empty-slot').first().getByRole('button', { name: /Terminal/ }).click()
await sleep(1000)
r.afterSpawnSlots = await titles()
await page.screenshot({ path: join(SHOTS, 'shot-layout-3.png') })
// Arrasta o 1º terminal (espaço grande) para o centro do 3º: trocam de lugar.
const heads = page.locator('.slot .pane-head')
const before = await titles()
await heads.nth(0).dragTo(page.locator('.slot').nth(2), { targetPosition: { x: 150, y: 120 } })
await sleep(500)
r.dragBefore = before
r.dragAfter = await titles()
// Divisória: arrasta a vertical principal para a esquerda.
const sash = page.locator('.sash-vertical, .sash.sash-vertical').first()
const box = await sash.boundingBox()
const widthBefore = (await page.locator('.slot').nth(0).boundingBox()).width
await page.mouse.move(box.x + box.width / 2, box.y + 200)
await page.mouse.down()
await page.mouse.move(box.x - 200, box.y + 200, { steps: 8 })
await page.mouse.up()
await sleep(400)
r.widthBefore = Math.round(widthBefore)
r.widthAfter = Math.round((await page.locator('.slot').nth(0).boundingBox()).width)
r.saved = await page.evaluate(() => localStorage.getItem('cockpit.arrange'))
await close()

// Reabre o app: o projeto volta com o mesmo layout e a mesma divisória.
;({ page, errors: r.errors2, close } = await launch({ userData }))
await page.getByRole('button', { name: /Projeto Layout/ }).first().click()
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await sleep(1000)
r.reopenSlots = await titles()
r.reopenWidth = Math.round((await page.locator('.slot').nth(0).boundingBox()).width)
await page.screenshot({ path: join(SHOTS, 'shot-layout-reopen.png') })
await close()
console.log(JSON.stringify({ ...r, errors }, null, 2))
