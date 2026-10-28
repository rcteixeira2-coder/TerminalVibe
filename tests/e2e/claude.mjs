// Claude real no Cockpit: transições de status (OSC 7501 + hooks), mods do Claude na tela.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
const logs = []
app.process().stderr?.on('data', (d) => logs.push(`[main:err] ${String(d).slice(0, 300)}`))
const page = await app.firstWindow()
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /^Terminal$/ }).first().click()
await page.getByRole('button', { name: /Abrir Claude/ }).click()
const t0 = Date.now()
const seen = []
let last = ''
const poll = async (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const [s] = await page.evaluate(() => window.cockpit.invoke('sessions:list'))
    const key = s ? `${s.activity}|${s.activitySource}|${s.taskTitle ?? ''}|${s.activityDetail ?? ''}` : 'none'
    if (key !== last) { seen.push({ t: Date.now() - t0, key }); last = key }
    await page.waitForTimeout(150)
  }
}
await poll(9000)
await page.screenshot({ path: join(out, 'shot-5-claude-idle.png') })
await page.keyboard.type('Liste os arquivos da pasta src/shared com a ferramenta de listar arquivos e responda em uma linha.')
await page.keyboard.press('Enter')
await poll(4000)
await page.screenshot({ path: join(out, 'shot-6-claude-working.png') })
await poll(40000)
await page.screenshot({ path: join(out, 'shot-7-claude-done.png') })
const [s] = await page.evaluate(() => window.cockpit.invoke('sessions:list'))
console.log(JSON.stringify({ transitions: seen, final: { activity: s.activity, source: s.activitySource, claudeSessionId: s.claudeSessionId, lifecycle: s.lifecycle }, logs }, null, 2))
await app.close()
