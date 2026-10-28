// Mods: painel iframe sandbox ↔ main.js no host oculto (postToPanel / onPanelMessage) e ação declarativa.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
const page = await app.firstWindow()
const logs = []
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.waitForTimeout(2000)
const snap = await page.evaluate(() => window.cockpit.invoke('mods:snapshot'))
await page.getByTitle('Mods').click()
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, 'shot-12-mods.png') })
await page.getByRole('button', { name: /Abrir painel/ }).click()
await page.waitForTimeout(2500)
const frame = page.frames().find((f) => f.url().startsWith('mod://'))
const panelText = frame ? await frame.locator('body').innerText() : '(sem frame)'
// Uma sessão nova deve atualizar o painel via onSessionEvent → postToPanel.
await page.getByRole('button', { name: /^Terminal$/ }).first().click()
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await page.waitForTimeout(2000)
await page.screenshot({ path: join(out, 'shot-13-mod-panel.png') })
const host = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible() })))
console.log(JSON.stringify({ mods: snap.mods.map((m) => ({ id: m.id, enabled: m.enabled, error: m.error })), panelText, host, logs }, null, 2))
await app.close()
