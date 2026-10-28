import { _electron as electron } from '@playwright/test'
import { ROOT } from './lib.mjs'
const dir = process.argv[2]
const app = await electron.launch({ args: [ROOT, `--user-data-dir=${dir}`], cwd: ROOT, env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
app.process().stderr?.on('data', (d) => process.stdout.write('[err] ' + d))
const page = await app.firstWindow()
await new Promise((r) => setTimeout(r, 4000))
const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible() })))
console.log('firstWindow url:', page.url())
console.log(JSON.stringify(wins))
console.log(await page.evaluate(() => document.body.innerHTML.slice(0, 300)).catch((e) => 'eval err ' + e.message))
await app.close()
