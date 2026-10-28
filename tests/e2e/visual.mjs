// V1: tema escuro com Claude + mods; V2: ⌘C (item de menu real) copia do browser lateral.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openAgent, openProject, waitFor, sessions, sleep, SHOTS } from './lib.mjs'

const results = {}
// ---------- V1 ----------
{
  const { page, close } = await launch()
  await page.emulateMedia({ colorScheme: 'dark' })
  const s = await openAgent(page, 'Terminal', 'Abrir Claude')
  await waitFor(async () => (await sessions(page)).find((x) => x.id === s.id)?.activity === 'your_turn', { timeout: 30000, label: 'claude pronto' })
  await sleep(1500)
  await page.screenshot({ path: join(SHOTS, 'rl-v1-dark.png') })
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  results.V1 = { bodyBg: bg }
  await page.evaluate((id) => window.cockpit.invoke('sessions:kill', id), s.id)
  await sleep(1200)
  await close()
}
// ---------- V2 ----------
{
  const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Copia Teste')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(fixture, { recursive: true })
  writeFileSync(join(fixture, 'index.html'), '<!doctype html><meta charset="utf-8"><p>texto-para-copiar-123</p>')
  const { app, page, close } = await launch({ store: { added: [fixture] } })
  await openProject(page, 'Copia Teste')
  await page.evaluate((p) => window.cockpit.invoke('browser:open', p, `${p}/index.html`), fixture)
  await sleep(2000)
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  const copied = await app.evaluate(async ({ BrowserWindow, Menu, clipboard }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('mod://'))
    const v = w.contentView.children[w.contentView.children.length - 1]
    w.focus()
    v.webContents.focus()
    v.webContents.selectAll()
    await new Promise((r) => setTimeout(r, 300))
    clipboard.writeText('antes')
    const edit = Menu.getApplicationMenu().items.find((i) => i.label === 'Editar')
    edit.submenu.items.find((i) => i.label === 'Copiar').click()
    await new Promise((r) => setTimeout(r, 500))
    return clipboard.readText()
  })
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), saved)
  results.V2 = { copied: copied.trim(), ok: copied.includes('texto-para-copiar-123') }
  await close()
}
console.log(JSON.stringify(results))
