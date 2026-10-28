// Mostra o aviso do Codex (F2) para saber se vem das flags do Cockpit.
import { join } from 'node:path'
import { launch, openAgent, sleep, SHOTS } from './lib.mjs'
const { page, close } = await launch()
const s = await openAgent(page, 'Terminal', 'Abrir Codex')
await sleep(7000)
await page.keyboard.press('F2')
await sleep(1500)
await page.screenshot({ path: join(SHOTS, 'rl-codex-warning.png') })
const text = await page.evaluate((id) => window.__cockpitTest.text(id), s.id)
console.log(text.split('\n').filter((l) => /warn|aviso|config|notif|deprecat/i.test(l)).slice(0, 15).join('\n'))
await page.evaluate((id) => window.cockpit.invoke('sessions:kill', id), s.id)
await sleep(1000)
await close()
