// Segunda instância no mesmo userData: sai sozinha e não apaga o socket de hooks da primeira.
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { launch, ROOT, sleep } from './lib.mjs'

const { page, userData, close } = await launch()
await sleep(1500)
const sock = join(userData, 'run', 'hooks.sock')
const inode = statSync(sock).ino
const electronBin = (await import('electron')).default
const t0 = Date.now()
const second = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`], { env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
const code = await new Promise((r) => second.on('exit', r))
const exitMs = Date.now() - t0
await sleep(800)
let inodeAfter = null
try { inodeAfter = statSync(sock).ino } catch {}
const windows = await page.evaluate(() => document.querySelectorAll('.sidebar').length)
console.log(JSON.stringify({ secondExitCode: code, exitMs, socketIntact: inodeAfter === inode, firstStillOk: windows === 1 }))
await close()
