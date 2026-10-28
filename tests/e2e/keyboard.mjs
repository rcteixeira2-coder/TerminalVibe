// T2–T6: teclado Mac, links de caminho, arrastar arquivo, busca e Esc na prévia.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openAgent, typeLine, buffer, waitFor, command, cellPoint, sleep, SHOTS, ROOT } from './lib.mjs'

const results = {}
const { app, page, errors } = await launch()
const s = await openAgent(page, 'Terminal')
const id = s.id
await waitFor(async () => (await buffer(page, id)).includes('%'), { label: 'prompt' })
await sleep(500)

// T2 — edição estilo Mac e acentos
await page.keyboard.type('echo um dois')
await page.keyboard.press('Alt+Backspace')
await typeLine(page, 'tres')
await page.keyboard.type('lixo qualquer')
await page.keyboard.press('Meta+Backspace')
await typeLine(page, 'echo limpo')
await page.keyboard.type('echo B')
await page.keyboard.press('Alt+ArrowLeft')
await typeLine(page, 'A')
await page.keyboard.type('echo fim')
await page.keyboard.press('Meta+ArrowLeft')
await page.keyboard.type('X=1 ')
await page.keyboard.press('Meta+ArrowRight')
await typeLine(page, ' ok')
await typeLine(page, 'echo acentos: é ç ã õ ü')
await sleep(1200)
const b2 = await buffer(page, id)
results.T2 = {
  altBackspace: /\num tres\n/.test(b2),
  cmdBackspace: /\nlimpo\n/.test(b2),
  altLeft: /\nAB\n/.test(b2),
  cmdLeftRight: /\nfim ok\n/.test(b2),
  acentos: b2.includes('acentos: é ç ã õ ü\n'),
}

// T3 — link de caminho clicável abre a prévia
await typeLine(page, 'clear; echo src/main/index.ts:10')
await sleep(900)
const p = await cellPoint(page, id, 4, 0)
await page.mouse.move(p.x, p.y)
await sleep(700)
await page.mouse.move(p.x + 2, p.y)
await sleep(500)
const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('.pane.focused .xterm-screen')).cursor)
await page.mouse.click(p.x + 2, p.y)
await sleep(900)
const previewTitle = await page.locator('.preview h3').textContent().catch(() => null)
await page.screenshot({ path: join(SHOTS, 'rl-t3-link-preview.png') })
results.T3 = { cursorOnLink: cursor, previewTitle }

// T6 — Esc com a prévia aberta: fecha e não chega ao pty (cat -v mostraria ^[)
await page.keyboard.press('Escape')
await sleep(400)
const previewOpenAfterEsc = await page.locator('.preview').count()
await page.locator('.pane-body').first().click()
await typeLine(page, 'cat -v')
await sleep(500)
await typeLine(page, '')
await typeLine(page, 'z')
await sleep(300)
// reabre a prévia via link e aperta Esc com cat -v rodando
await typeLine(page, '')
const b6a = await buffer(page, id)
await page.keyboard.press('Control+c')
await typeLine(page, 'clear; echo src/main/index.ts:10; cat -v')
await sleep(900)
const p2 = await cellPoint(page, id, 4, 0)
await page.mouse.move(p2.x, p2.y)
await sleep(600)
await page.mouse.move(p2.x + 2, p2.y)
await sleep(400)
await page.mouse.click(p2.x + 2, p2.y)
await sleep(800)
const reopened = await page.locator('.preview').count()
await page.keyboard.press('Escape')
await sleep(400)
const closed = (await page.locator('.preview').count()) === 0
const focusBack = await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
await typeLine(page, 'depois-do-esc')
await sleep(500)
const b6 = await buffer(page, id)
await page.keyboard.press('Control+c')
results.T6 = { previewClosedFirst: previewOpenAfterEsc === 0, reopened, closed, focusBack, escLeaked: b6.includes('^['), catEcho: b6.includes('depois-do-esc') }
void b6a

// T4 — arrastar arquivo: interno (árvore) e do Finder (com e sem \n no nome)
await sleep(300)
await typeLine(page, 'clear')
await sleep(300)
const dir = mkdtempSync(join(tmpdir(), 'cockpit-drop-'))
const good = join(dir, "print da tela (1)'s.png")
const bad = join(dir, 'mal\nvado.txt')
writeFileSync(good, 'x')
writeFileSync(bad, 'x')
const drop = async (path) =>
  page.evaluate((pp) => {
    const dt = new DataTransfer()
    dt.setData('application/x-cockpit-path', pp)
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    document.querySelector('.pane.focused .pane-body').dispatchEvent(ev)
  }, path)
// O shell recebe os caminhos como argumentos: printf mostra exatamente o que chegou.
await page.keyboard.type("printf '[%s]\\n' ")
await drop(join(ROOT, 'README.md'))
await sleep(400)
await drop(good)
await sleep(400)
await drop(bad)
await sleep(800)
const toastText = await page.locator('.toast').allTextContents()
const beforeEnter = await buffer(page, id)
await page.keyboard.press('Enter')
await sleep(600)
const b4 = await buffer(page, id)
results.T4 = {
  noAutoEnter: !beforeEnter.includes(`[${ROOT}/README.md]`),
  readmeArg: b4.includes(`[${ROOT}/README.md]\n`),
  goodArg: b4.includes(`[${good}]\n`),
  badRejected: !b4.includes('vado.txt') && toastText.some((t) => t.includes('controle')),
}

// T5 — busca ⌘F
await typeLine(page, 'clear; echo agulha-no-palheiro')
await sleep(500)
await command(app, 'find')
await sleep(300)
await page.keyboard.type('agulha')
await sleep(300)
const hitMiss = await page.locator('.findbar input').getAttribute('class')
await page.locator('.findbar input').fill('nao-existe-xyz')
await sleep(300)
const missClass = await page.locator('.findbar input').getAttribute('class')
await page.keyboard.press('Escape')
await sleep(300)
results.T5 = {
  found: !(hitMiss ?? '').includes('miss'),
  missMarked: (missClass ?? '').includes('miss'),
  closed: (await page.locator('.findbar').count()) === 0,
  focusBack: await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
}

console.log(JSON.stringify({ results, errors }, null, 2))
await app.close()
