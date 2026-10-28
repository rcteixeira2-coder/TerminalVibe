// × no "Espaço livre": tira o espaço do layout (vizinhos crescem); escolher o layout de novo devolve.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, SHOTS, sleep } from './lib.mjs'

const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Projeto Espacos')
mkdirSync(fixture)
const r = {}
const { page, errors, close } = await launch({ store: { added: [fixture], meta: { [fixture]: { favorite: true } } } })
try {
  await page.getByRole('button', { name: /Projeto Espacos/ }).first().click()
  await page.getByRole('button', { name: /Abrir Terminal/ }).click()
  await sleep(800)
  const pick = async (name) => {
    await page.getByTitle('Layout dos terminais').click()
    await sleep(200)
    await page.getByRole('button', { name }).click()
    await sleep(500)
  }
  await pick(/^Grade 3 × 2/)
  r.slotsBefore = await page.locator('.slot').count()
  const termWidth = async () => Math.round((await page.locator('.slot').filter({ has: page.locator('.pane-head') }).first().boundingBox()).width)
  r.widthBefore = await termWidth()
  // Tira os 3 espaços de baixo e um de cima.
  for (let i = 0; i < 4; i++) {
    await page.locator('.empty-slot-x').last().click()
    await sleep(300)
  }
  r.slotsAfter = await page.locator('.slot').count()
  r.widthAfter = await termWidth()
  r.xLeft = await page.locator('.empty-slot-x').count()
  await page.screenshot({ path: join(SHOTS, 'layout-remove-1.png') })
  // Último espaço livre: tirar deixa só o terminal; aí não há mais ×.
  await page.locator('.empty-slot-x').first().click()
  await sleep(300)
  r.slotsOnlyTerminal = await page.locator('.slot').count()
  r.xWhenFull = await page.locator('.empty-slot-x').count()
  // Escolher o layout de novo devolve os 6 espaços.
  await pick(/^Grade 3 × 2/)
  r.slotsRestored = await page.locator('.slot').count()
  r.errors = errors.filter((e) => !/Debugger (listening|ending) on ws:/.test(e))
} finally {
  await close()
}
console.log(JSON.stringify(r, null, 2))
const ok = r.slotsBefore === 6 && r.slotsAfter === 2 && r.widthAfter > r.widthBefore && r.xLeft === 1 && r.slotsOnlyTerminal === 1 && r.xWhenFull === 0 && r.slotsRestored === 6 && !r.errors.length
console.log(ok ? 'OK' : 'FALHOU')
process.exit(ok ? 0 : 1)
