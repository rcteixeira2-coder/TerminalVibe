// Fechar um painel de shell rodando: ele some e não volta como "fantasma" (zsh ignora SIGTERM).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
const page = await app.firstWindow()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /^Terminal$/ }).first().click()
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /Dividir/ }).first().click()
await page.waitForTimeout(1500)
const before = (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).length
const panesBefore = await page.locator('.pane').count()
await page.locator('.pane').nth(1).getByTitle('Fechar painel').click()
await page.waitForTimeout(3500)
const after = (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).length
const panesAfter = await page.locator('.pane').count()
console.log(JSON.stringify({ before, panesBefore, after, panesAfter, ok: before === 2 && after === 1 && panesAfter === 1 }))
await app.close()
