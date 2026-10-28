// T1: Shift+Enter no Claude real = nova linha sem enviar.
import { join } from 'node:path'
import { launch, openAgent, buffer, waitFor, sessions, sleep, SHOTS } from './lib.mjs'

const { page, app, errors } = await launch()
const s = await openAgent(page, 'Terminal', 'Abrir Claude')
await waitFor(async () => (await sessions(page)).find((x) => x.id === s.id)?.activity === 'your_turn', { label: 'Claude pronto', timeout: 30000 })
await sleep(800)
await page.keyboard.type('linha um do teste')
await page.keyboard.press('Shift+Enter')
await page.keyboard.type('linha dois do teste')
await sleep(2500)
const after = (await sessions(page)).find((x) => x.id === s.id)
const b = await buffer(page, s.id)
const tail = b.slice(-3000)
await page.screenshot({ path: join(SHOTS, 'rl-t1-shift-enter.png') })
const result = {
  activity: after.activity,
  notSubmitted: after.activity !== 'working' && after.activity !== 'done',
  bothLines: /linha um do teste\s*\n[^\n]*linha dois do teste/.test(tail),
}
// limpa o rascunho e encerra sem enviar nada
await page.keyboard.press('Control+c')
await page.evaluate((id) => window.cockpit.invoke('sessions:kill', id), s.id)
await sleep(1500)
console.log(JSON.stringify({ result, errors }))
await app.close()
