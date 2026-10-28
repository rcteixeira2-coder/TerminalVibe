// Abre o Cockpit real com userData isolado, captura tela e erros do console.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
const logs = []
app.process().stdout?.on('data', (d) => logs.push(`[main] ${d}`))
app.process().stderr?.on('data', (d) => logs.push(`[main:err] ${d}`))
const page = await app.firstWindow()
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.waitForTimeout(2500)
await page.screenshot({ path: join(out, 'shot-1-start.png') })
console.log(JSON.stringify({ userData, title: await page.title(), logs }, null, 2))
await app.close()
