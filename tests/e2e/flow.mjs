// Fluxo real: abre Terminal no projeto, roda comandos, divide, confere ambiente/descritores e status.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const project = process.argv[3] ?? 'Terminal'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '', CURSOR_TRACE_ID: 'fake-cursor', VSCODE_GIT_ASKPASS_MAIN: '/x', NODE_OPTIONS: '--no-warnings' } })
const logs = []
app.process().stderr?.on('data', (d) => logs.push(`[main:err] ${d}`))
const page = await app.firstWindow()
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.waitForTimeout(1500)
await page.getByRole('button', { name: new RegExp(`^${project}$`) }).first().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await page.waitForTimeout(2500)
await page.keyboard.type('echo cockpit-$((40+2)); /usr/sbin/lsof -a -p $$ -d 0-255 -F fn | tr "\\n" " "; echo; env | grep -E "^(TERM|COLORTERM|TERM_PROGRAM|COCKPIT_PANE_ID|CURSOR|VSCODE|NODE_OPTIONS|ELECTRON)" | sort\n')
await page.waitForTimeout(1500)
const sessions = await page.evaluate(() => window.cockpit.invoke('sessions:list'))
const buf = await page.evaluate((id) => window.cockpit.invoke('sessions:buffer', id), sessions[0].id)
await page.screenshot({ path: join(out, 'shot-2-terminal.png') })
// Divisão com shell
await page.getByRole('button', { name: /Dividir/ }).first().click()
await page.waitForTimeout(2000)
await page.keyboard.type('printf "\\e]52;c;?\\a"; echo fim-osc52\n')
await page.waitForTimeout(800)
const after = await page.evaluate(() => window.cockpit.invoke('sessions:list'))
await page.screenshot({ path: join(out, 'shot-3-split.png') })
// Grade
await page.getByTitle(/Grade de sessões/).click()
await page.waitForTimeout(1500)
await page.screenshot({ path: join(out, 'shot-4-grid.png') })
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, '')
console.log(JSON.stringify({ sessions: after.map((s) => ({ title: s.title, agent: s.agent, lifecycle: s.lifecycle, activity: s.activity })), bufferTail: clean(buf).split('\n').slice(-14), logs }, null, 2))
await app.close()
