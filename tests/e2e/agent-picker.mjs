// Seletor de modelos com provedores locais fechados: sem avisos flutuantes, erro claro dentro do menu.
import { join } from 'node:path'
import { launch, openProject, command, sleep, SHOTS } from './lib.mjs'
const { app, page, close } = await launch()
await openProject(page, 'Terminal')
await command(app, 'agent')
await page.waitForSelector('.agent')
await page.locator('.model-btn').click()
await sleep(2500)
await page.screenshot({ path: join(SHOTS, 'agent-3-picker.png') })
const toasts = await page.locator('.toast').count()
const empties = await page.locator('.dropdown .dd-empty').allInnerTexts()
console.log(JSON.stringify({ toasts, empties }))
await close()
