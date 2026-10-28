// Painéis em cartões: cor por estado, "Responder ↵", ações só no hover, e trocar de estado não muda o tamanho do terminal.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, SHOTS, sleep, waitFor, buffer } from './lib.mjs'

const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Projeto Estados')
mkdirSync(fixture)
const r = {}
const { app, page, errors, userData, close } = await launch({ store: { added: [fixture], meta: { [fixture]: { favorite: true } } } })
const report = join(userData, 'claude-plugin', 'hooks', 'report.sh')
const list = () => page.evaluate(() => window.cockpit.invoke('sessions:list'))
// Manda um evento de hook "como se" o Claude daquele painel tivesse mandado (mesmo caminho do plugin real).
const hook = async (id, payload) => {
  const line = `printf '%s' '${JSON.stringify(payload)}' | sh '${report}'; clear\r`
  await page.evaluate(([i, t]) => window.cockpit.send('pty:write', i, t), [id, line])
}
const paneOf = (i) => page.locator('.pane').nth(i)
// Contraste WCAG (texto pequeno precisa de 4,5:1) medido nas cores computadas de cada painel com estado.
const audit = () => page.$$eval('.pane', (panes) => {
  // rgb()/rgba() vêm em 0–255; color-mix devolve color(srgb r g b / a) em 0–1.
  const rgb = (c) => {
    const m = c.match(/[\d.]+/g).map(Number)
    const k = c.startsWith('color(') ? 255 : 1
    return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m[3] ?? 1 }
  }
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 })
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2) }
  const page = rgb(getComputedStyle(document.body).backgroundColor)
  return panes.map((pane) => {
    const cap = pane.querySelector('.pane-cap')
    const capBg = over(rgb(getComputedStyle(cap).backgroundColor), page)
    const urgent = pane.classList.contains('needs-me')
    const out = {}
    const text = (sel) => { const el = pane.querySelector(sel); if (el) out[sel] = ratio(rgb(getComputedStyle(el).color), capBg) }
    text('.pane-status-text')
    if (urgent) { text('.pane-title'); text('.pane-task') }
    const pill = pane.querySelector('.state-pill')
    if (pill) out.pill = ratio(rgb(getComputedStyle(pill).color), over(rgb(getComputedStyle(pill).backgroundColor), capBg))
    const cta = pane.querySelector('.pane-cta')
    if (cta) out.cta = ratio(rgb(getComputedStyle(cta).color), over(rgb(getComputedStyle(cta).backgroundColor), capBg))
    return { state: [...pane.classList].find((c) => c.startsWith('activity-')), min: Math.min(...Object.values(out)), ...out }
  })
})
const geometry = () => page.$$eval('.pane .pane-body', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
try {
  await page.getByRole('button', { name: /Projeto Estados/ }).first().click()
  await page.getByRole('button', { name: /Abrir Terminal/ }).click()
  await waitFor(async () => (await list()).length === 1, { label: 'terminal 1' })
  for (const n of [2, 3]) {
    await page.getByTitle(/Dividir com terminal/).click()
    await waitFor(async () => (await list()).length === n, { label: `terminal ${n}` })
  }
  const ids = (await list()).sort((a, b) => a.startedAt - b.startedAt).map((s) => s.id)
  for (const id of ids) await waitFor(async () => (await buffer(page, id)).includes('%'), { label: 'prompt' })
  await sleep(500)
  const order = await page.$$eval('.pane .pane-title', (els) => els.map((e) => e.textContent))
  r.order = order
  const geoBefore = await geometry()
  const ptyBefore = (await list()).map((s) => `${s.cols}x${s.rows}`)

  await hook(ids[0], { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Claude is waiting for your input' })
  await hook(ids[1], { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  await hook(ids[2], { hook_event_name: 'UserPromptSubmit' })
  await waitFor(async () => (await page.locator('.pane.needs-me').count()) === 2 && (await page.locator('.pane.activity-working').count()) === 1, { label: 'estados aplicados' })
  await page.mouse.move(5, 5)
  await sleep(700)
  r.classes = await page.$$eval('.pane', (els) => els.map((e) => [...e.classList].filter((c) => c !== 'pane').join(' ')))
  r.statusTexts = await page.$$eval('.pane .pane-status', (els) => els.map((e) => e.textContent))
  r.ctas = await page.$$eval('.pane .pane-cta .lbl-long', (els) => els.map((e) => e.textContent))
  r.capColors = await page.$$eval('.pane .pane-cap', (els) => els.map((e) => getComputedStyle(e).backgroundColor))
  r.frameWidths = await page.$$eval('.pane', (els) => els.map((e) => getComputedStyle(e, '::after').borderTopWidth))
  r.gutter = await page.$eval('.pane-area', (e) => getComputedStyle(e).backgroundColor)
  // Ações escondidas no painel sem foco e sem mouse; aparecem no hover.
  const focusedIdx = await page.$$eval('.pane', (els) => els.findIndex((e) => e.classList.contains('focused')))
  const other = [0, 1, 2].find((i) => i !== focusedIdx)
  r.actionsHidden = await paneOf(other).locator('.pane-actions').evaluate((e) => getComputedStyle(e).opacity)
  await paneOf(other).locator('.pane-head').hover()
  await sleep(250)
  r.actionsOnHover = await paneOf(other).locator('.pane-actions').evaluate((e) => getComputedStyle(e).opacity)
  await page.mouse.move(5, 5)
  await page.emulateMedia({ colorScheme: 'dark' })
  await sleep(400)
  await page.screenshot({ path: join(SHOTS, 'pane-states-dark.png') })

  // Terminou: verde, sem moldura.
  await hook(ids[2], { hook_event_name: 'Stop', last_assistant_message: 'Pronto, terminei.' })
  await waitFor(async () => (await page.locator('.pane.activity-done').count()) === 1, { label: 'terminou' })
  r.doneText = await page.locator('.pane.activity-done .pane-status').textContent()
  // A altura do terminal não mudou com nenhuma troca de estado.
  r.geoBefore = geoBefore
  r.geoAfter = await geometry()
  r.ptyBefore = ptyBefore
  r.ptyAfter = (await list()).map((s) => `${s.cols}x${s.rows}`)

  // "Responder ↵" no painel 1 passa o foco para ele.
  await paneOf(0).locator('.pane-cta').click()
  await sleep(300)
  r.focusAfterCta = await page.$$eval('.pane', (els) => els.findIndex((e) => e.classList.contains('focused')))

  // Contraste nos dois temas: sua vez, aprovação, terminou; depois o mesmo painel em erro.
  await page.mouse.move(5, 5)
  r.contrast = {}
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme })
    await sleep(300)
    r.contrast[scheme] = await audit()
  }
  await hook(ids[2], { hook_event_name: 'StopFailure', error: 'Falha de teste' })
  await waitFor(async () => (await page.locator('.pane.activity-error').count()) === 1, { label: 'erro' })
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme })
    await sleep(300)
    r.contrast[`${scheme}-erro`] = (await audit())[2]
  }
  r.minContrast = Math.min(...Object.values(r.contrast).flat().map((x) => x.min))
  await page.screenshot({ path: join(SHOTS, 'pane-states-light.png') })

  // Janela estreita (3 painéis de ~240px): ⤢ e × dentro do cartão, título visível, cabeçalho com 30px.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).setSize(820, 760))
  await sleep(800)
  await page.mouse.move(5, 5)
  await sleep(300)
  r.narrow = await page.$$eval('.pane', (els) => els.map((p) => {
    const box = p.getBoundingClientRect()
    const x = p.querySelector('.tab-x')?.getBoundingClientRect()
    const max = p.querySelector('.max-btn')?.getBoundingClientRect()
    return {
      width: Math.round(box.width),
      closeInside: !!x && x.right <= box.right + 0.5 && x.width > 0,
      maxInside: !!max && max.right <= box.right + 0.5,
      titleWidth: Math.round(p.querySelector('.pane-title').getBoundingClientRect().width),
      headHeight: Math.round(p.querySelector('.pane-head').getBoundingClientRect().height),
    }
  }))
  await page.locator('.pane').nth(1).locator('.pane-head').hover()
  await sleep(250)
  r.narrowHover = await page.locator('.pane').nth(1).evaluate((p) => {
    const box = p.getBoundingClientRect()
    const x = p.querySelector('.tab-x').getBoundingClientRect()
    return { closeInside: x.right <= box.right + 0.5, headHeight: Math.round(p.querySelector('.pane-head').getBoundingClientRect().height), actions: getComputedStyle(p.querySelector('.pane-actions')).opacity }
  })
  await page.screenshot({ path: join(SHOTS, 'pane-states-narrow.png') })
  r.errors = errors.filter((e) => !/Debugger (listening|ending) on ws:/.test(e))
} finally {
  await close()
}
console.log(JSON.stringify(r, null, 2))
const ok = r.classes[0].includes('needs-me') && r.classes[0].includes('activity-your_turn') && r.classes[1].includes('activity-needs_approval') && r.classes[2].includes('activity-working') &&
  r.statusTexts[0].includes('Esperando você') && r.statusTexts[1].includes('Pede permissão para usar Bash') && r.ctas.join('|') === 'Responder ↵|Ver aprovação ↵' &&
  r.frameWidths[0] === '3px' && r.frameWidths[2] === '0px' && r.actionsHidden === '0' && r.actionsOnHover === '1' && r.doneText.includes('TERMINOU') &&
  JSON.stringify(r.geoBefore) === JSON.stringify(r.geoAfter) && JSON.stringify(r.ptyBefore) === JSON.stringify(r.ptyAfter) && r.focusAfterCta === 0 && !r.errors.length &&
  r.minContrast >= 4.5 && r.narrow.every((n) => n.closeInside && n.maxInside && n.titleWidth > 20 && n.headHeight === 30) && r.narrowHover.closeInside && r.narrowHover.headHeight === 30
console.log(ok ? 'OK' : 'FALHOU')
process.exit(ok ? 0 : 1)
