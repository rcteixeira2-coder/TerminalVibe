// Divisões da barra lateral: favoritos no topo, divisões do usuário, criar/renomear, arrastar pasta, excluir.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, SHOTS, sleep } from './lib.mjs'

const base = mkdtempSync(join(tmpdir(), 'cockpit-fx-'))
const [fav, cli, solta] = ['Favorita', 'Cliente A', 'Solta'].map((n) => {
  const p = join(base, n)
  mkdirSync(p)
  return p
})
const store = {
  added: [fav, cli, solta],
  meta: { [fav]: { favorite: true }, [cli]: { group: 'g-cli' } },
  groups: [{ id: 'g-cli', name: 'Clientes' }],
}
const r = {}
const { page, errors, close } = await launch({ store })
const titles = () => page.$$eval('.side-section .side-title', (els) => els.map((e) => e.textContent.trim()))
const sectionOf = (name) =>
  page.$$eval('.side-section', (els, name) => els.find((s) => [...s.querySelectorAll('.proj-name')].some((n) => n.textContent === name))?.querySelector('.side-title')?.textContent.trim(), name)
await sleep(800)
r.initial = await titles()
r.cliIn = await sectionOf('Cliente A')
// + Divisão: nasce com o nome em edição.
await page.getByRole('button', { name: '+ Divisão' }).click()
await page.locator('.side-rename').fill('Pessoal')
await page.keyboard.press('Enter')
await sleep(300)
r.afterCreate = await titles()
// Arrasta "Solta" para a divisão nova (eventos de DOM: o dragTo do Playwright não solta no Electron).
await page.evaluate(() => {
  const src = [...document.querySelectorAll('.proj-row')].find((b) => b.textContent.includes('Solta'))
  const dst = [...document.querySelectorAll('.side-section')].find((s) => s.textContent.includes('Pessoal'))
  const dt = new DataTransfer()
  for (const [el, type] of [[src, 'dragstart'], [dst, 'dragenter'], [dst, 'dragover'], [dst, 'drop'], [src, 'dragend']])
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
})
await sleep(600)
r.soltaIn = await sectionOf('Solta')
await page.screenshot({ path: join(process.env.SHOTS ?? SHOTS, 'shot-sidebar-groups.png'), clip: { x: 0, y: 0, width: 300, height: 420 } })
// Excluir "Clientes" (o menu nativo não é clicável no teste: vai direto pelo IPC) devolve a pasta às seções automáticas.
const groups = await page.evaluate(() => window.cockpit.invoke('groups:list'))
r.afterDelete = (await page.evaluate((gs) => window.cockpit.invoke('groups:set', gs), groups.filter((g) => g.id !== 'g-cli'))).map((g) => g.name)
await sleep(600)
r.cliAfterDelete = await sectionOf('Cliente A')
r.errors = errors
console.log(JSON.stringify(r, null, 2))
await close()
