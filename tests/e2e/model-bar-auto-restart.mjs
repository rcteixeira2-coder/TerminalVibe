// Auto com o mod auto-modelo desligado: um clique liga o mod no settings.json, reinicia a sessão retomando a
// mesma conversa (--resume) no mesmo painel e digita /auto-modelo on nela. HOME falso: nada real é tocado.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, ROOT, sleep, waitFor } from './lib.mjs'

const SHOTS = process.env.COCKPIT_SHOTS ?? tmpdir()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-home-')))
const mod = join(home, '.claude', 'mods', 'auto-modelo', '.claude-plugin')
mkdirSync(mod, { recursive: true })
writeFileSync(join(mod, 'plugin.json'), JSON.stringify({ name: 'auto-modelo', version: '0.2.0' }))
writeFileSync(join(mod, 'marketplace.json'), JSON.stringify({ name: 'auto-modelo' }))
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', enabledPlugins: { 'auto-modelo@auto-modelo': false } }))
const fake = join(ROOT, 'tests/fixtures/fakeClaudeTui.mjs')
chmodSync(fake, 0o755)
const lines = (f) => (existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8').trim().split('\n').filter(Boolean) : [])
const fixture = join(home, 'Projeto Auto')
mkdirSync(fixture)

const { page, errors, close } = await launch({
  store: { added: [fixture], meta: { [fixture]: { favorite: true } } },
  env: { HOME: home, COCKPIT_TEST_CLAUDE_BIN: fake },
})
await page.emulateMedia({ colorScheme: 'dark' })
const r = {}
const claudes = async () => (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).filter((s) => s.agent === 'claude')
await page.getByRole('button', { name: /Projeto Auto/ }).first().click()
await page.getByRole('button', { name: /Abrir Claude/ }).click()
await page.waitForSelector('.pane-foot .ui-seg')
await sleep(1500)
const [before] = await claudes()
r.beforeAutoModelo = before.autoModelo
const foot = page.locator('.pane-foot').first()
r.switchBefore = await foot.getByRole('switch').getAttribute('aria-checked')

await foot.getByRole('switch').click()
const after = await waitFor(async () => {
  const list = await claudes()
  return list.length === 1 && list[0].id !== before.id && list[0].lifecycle === 'running' && list[0]
}, { label: 'sessão reiniciada' }).catch(() => null)
r.typed = await waitFor(() => lines('fake-tui.log').includes('/auto-modelo on') && lines('fake-tui.log'), { label: '/auto-modelo on', timeout: 20000 }).catch(() => lines('fake-tui.log'))
await sleep(500)
r.settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins
r.args = lines('fake-tui-args.log')
r.sameConversation = after?.claudeSessionId === before.claudeSessionId
r.afterAutoModelo = after?.autoModelo
r.panes = await page.locator('.pane-foot').count()
r.switchAfter = await foot.getByRole('switch').getAttribute('aria-checked')
r.toasts = await page.locator('.toasts').innerText().catch(() => '')
await foot.screenshot({ path: join(SHOTS, 'model-bar-auto-restart.png') })
await close()

const ok = r.beforeAutoModelo === false && r.settings['auto-modelo@auto-modelo'] === true && !!after && r.sameConversation
  && r.afterAutoModelo === true && r.args.length === 2 && r.args[1].startsWith(`--resume ${before.claudeSessionId}`)
  && r.typed.join('|') === '/auto-modelo on' && r.panes === 1 && r.switchAfter === 'true'
console.log(JSON.stringify({ ok, ...r, errors: errors.filter((e) => !/Debugger/.test(e)) }, null, 2))
process.exit(ok ? 0 : 1)
