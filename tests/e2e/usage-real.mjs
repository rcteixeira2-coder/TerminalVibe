// Verificação real (só leitura + 1 mensagem curta ao Claude): o módulo do plugin traz os limites do plano
// e os totais do painel batem com uma soma independente dos registros. Imprime só números.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, sleep } from './lib.mjs'

// Pasta já confiável no Claude (sem a pergunta de confiança): o próprio repositório do Cockpit.
const fixture = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const { page, errors, close, userData } = await launch({ store: { added: [fixture], meta: { [fixture]: { favorite: true } } } })
const r = {}
const t0 = Date.now()
const rep = await page.evaluate(() => window.cockpit.invoke('usage:report', '7d', true, false))
r.scanMs = Date.now() - t0
r.claude7d = rep.sessions.find((s) => s.id === 'claude')?.totals
r.codex7d = rep.sessions.find((s) => s.id === 'codex')?.totals
r.codexPlan = rep.plans.find((p) => p.id === 'codex')
const t1 = Date.now()
await page.evaluate(() => window.cockpit.invoke('usage:report', '7d', true, false))
r.rescanMs = Date.now() - t1
r.limitsBefore = (await page.evaluate(() => window.cockpit.invoke('usage:claudeCard'))).windows.length
await page.getByRole('button', { name: /^Terminal/ }).first().click()
await page.getByRole('button', { name: /Abrir Claude/ }).click()
await sleep(9000)
const sid = (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).find((s) => s.agent === 'claude').id
await page.evaluate((id) => window.cockpit.send('pty:write', id, 'responda apenas: ok'), sid)
await sleep(1200)
await page.evaluate((id) => window.cockpit.send('pty:write', id, '\r'), sid)
let card = null
for (let i = 0; i < 60; i++) {
  card = await page.evaluate(() => window.cockpit.invoke('usage:claudeCard'))
  if (card.windows.length) break
  await sleep(1000)
}
r.claudeCard = card
r.sidebar = await page.locator('.usage-btn').innerText()
r.screen = (await page.evaluate((id) => window.__cockpitTest?.text(id) ?? '', sid)).split('\n').filter((l) => l.trim()).slice(-25)
const { readdirSync, existsSync } = await import('node:fs')
r.pluginCopy = existsSync(join(userData, 'claude-plugin')) ? readdirSync(join(userData, 'claude-plugin'), { recursive: true }).filter((f) => !String(f).includes('types/claude-code')).slice(0, 20) : 'sem cópia'
await close()
console.log(JSON.stringify({ ...r, errors: errors.filter((e) => !/Debugger|GPU|SharedImage/.test(e)) }, null, 2))
