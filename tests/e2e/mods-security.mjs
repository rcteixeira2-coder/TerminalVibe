// M1–M2: mod travado é isolado e o app segue; mods sem rede e sem session.write.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openAgent, waitFor, buffer, sleep, typeLine } from './lib.mjs'

const modsDir = mkdtempSync(join(tmpdir(), 'cockpit-mods-'))
const mod = (id, manifest, main) => {
  mkdirSync(join(modsDir, id))
  writeFileSync(join(modsDir, id, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', main: 'main.js', ...manifest }))
  writeFileSync(join(modsDir, id, 'main.js'), main)
}
mod('trava', { permissions: [] }, 'setTimeout(() => { while (true) {} }, 1500)')
mod('curioso', {
  permissions: ['session.events', 'notify'],
  buttons: [{ id: 'testar', label: 'Testar limites', location: 'sidebar', action: { type: 'script' } }],
}, `
cockpit.onAction(async () => {
  const out = {}
  try { const r = await fetch('https://example.com'); out.fetch = 'PASSOU ' + r.status } catch (e) { out.fetch = 'bloqueado' }
  try { await fetch('http://127.0.0.1:9/'); out.local = 'PASSOU' } catch (e) { out.local = 'bloqueado' }
  out.ws = await new Promise((res) => { try { const w = new WebSocket('wss://echo.websocket.events'); w.onopen = () => res('PASSOU'); w.onerror = () => res('bloqueado'); setTimeout(() => res('bloqueado'), 4000) } catch (e) { res('bloqueado') } })
  try { const [s] = await cockpit.listSessions(); await cockpit.sendToSession(s.sessionId, 'echo invadido'); out.write = 'PASSOU' } catch (e) { out.write = 'erro: ' + e.message }
  out.node = typeof require === 'undefined' && typeof process === 'undefined' ? 'sem node' : 'TEM NODE'
  out.parent = (() => { try { return parent.cockpitHost ? 'ACESSOU HOST' : 'sem acesso' } catch (e) { return 'sem acesso' } })()
  await cockpit.notify('resultado', JSON.stringify(out))
})
`)

const { app, page, close, errors } = await launch({ env: { COCKPIT_MODS_DIR: modsDir } })
await app.evaluate(({ Notification }) => {
  globalThis.__shown = []
  Notification.prototype.show = function () { globalThis.__shown.push({ title: this.title, body: this.body }) }
})
const s = await openAgent(page, 'Terminal')
await waitFor(async () => (await buffer(page, s.id)).includes('%'))
// Espera o "trava" travar e o host perceber (ping a cada 3 s, 3 perdidos; ou heartbeat do host 12 s).
const t0 = Date.now()
const hung = await waitFor(async () => {
  const snap = await page.evaluate(() => window.cockpit.invoke('mods:snapshot'))
  return snap.mods.find((m) => m.id === 'trava' && m.error) ?? null
}, { timeout: 60000, every: 1000, label: 'mod travado detectado' })
const detectMs = Date.now() - t0
// O app continua respondendo durante tudo isso.
await typeLine(page, 'echo app-responde')
await waitFor(async () => (await buffer(page, s.id)).includes('app-responde\n'), { label: 'eco' })
// O outro mod ainda funciona depois do isolamento.
await sleep(2500)
await page.getByRole('button', { name: 'Testar limites' }).click()
const res = await waitFor(async () => (await app.evaluate(() => globalThis.__shown)).find((n) => n.title === 'resultado'), { timeout: 30000, label: 'resultado do mod' })
const typed = (await buffer(page, s.id)).includes('invadido')
console.log(JSON.stringify({ M1: { detectMs, error: hung.error }, M2: { ...JSON.parse(res.body), typedIntoTerminal: typed }, errors }, null, 2))
await close()
