// Visual do estado "precisa de aprovação": emite o mesmo OSC 7501 que o Claude Code envia.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
const page = await app.firstWindow()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /^Terminal$/ }).first().click()
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await page.waitForTimeout(1500)
const msg = Buffer.from('Bash: rm -rf node_modules').toString('base64')
await page.keyboard.type(`clear; printf '\\033]7501;state=blocked:app=claude-code:kind=permission:msg=${msg}\\033\\\\'\n`)
await page.waitForTimeout(1200)
await page.screenshot({ path: join(out, 'shot-14-approval.png') })
await page.getByTitle(/Grade de sessões/).click()
await page.waitForTimeout(1200)
await page.screenshot({ path: join(out, 'shot-15-approval-grid.png') })
const [s] = await page.evaluate(() => window.cockpit.invoke('sessions:list'))
console.log(JSON.stringify({ activity: s.activity, detail: s.activityDetail, source: s.activitySource }))
await app.close()
