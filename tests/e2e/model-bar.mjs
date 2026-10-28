// Rodapé de modelo: Auto / modelo / esforço digitam os comandos certos no Claude, nunca por cima de um
// rascunho, e o visual "Claude warm" (largo, estreito, claro, vitrine). HOME falso: nada real é tocado.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { command, launch, ROOT, sleep, waitFor } from './lib.mjs'

const SHOTS = process.env.COCKPIT_SHOTS ?? tmpdir()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-home-')))
const mod = join(home, '.claude', 'mods', 'auto-modelo', '.claude-plugin')
mkdirSync(mod, { recursive: true })
writeFileSync(join(mod, 'plugin.json'), JSON.stringify({ name: 'auto-modelo', version: '0.2.0' }))
writeFileSync(join(mod, 'marketplace.json'), JSON.stringify({ name: 'auto-modelo' }))
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'xhigh', enabledPlugins: { 'auto-modelo@auto-modelo': true } }))
const realCache = join(homedir(), '.codex', 'models_cache.json')
if (existsSync(realCache)) {
  mkdirSync(join(home, '.codex'))
  copyFileSync(realCache, join(home, '.codex', 'models_cache.json'))
}
const fake = join(ROOT, 'tests/fixtures/fakeClaudeTui.mjs')
chmodSync(fake, 0o755)
const logFile = join(home, 'fake-tui.log')
const typed = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [])
const fixture = join(home, 'Projeto Modelo')
mkdirSync(fixture)

const { app, page, errors, close } = await launch({
  store: { added: [fixture], meta: { [fixture]: { favorite: true } } },
  env: { HOME: home, COCKPIT_TEST_CLAUDE_BIN: fake },
})
// O Playwright emula tema claro por padrão; o Cockpit segue o prefers-color-scheme.
await page.emulateMedia({ colorScheme: 'dark' })
const r = {}
await page.getByRole('button', { name: /Projeto Modelo/ }).first().click()
await page.getByRole('button', { name: /Abrir Claude/ }).click()
await page.waitForSelector('.pane-foot .ui-seg')
await sleep(1500)
const foot = page.locator('.pane-foot').first()
r.initial = await foot.innerText()
await page.screenshot({ path: join(SHOTS, 'model-bar-wide.png') })
await foot.screenshot({ path: join(SHOTS, 'model-bar-foot.png') })

// Auto começa ligado (mod ligado, nada gravado): escolher Sonnet desliga o Auto e troca o modelo.
await foot.getByRole('radio', { name: 'Sonnet' }).click()
await foot.getByRole('radio', { name: 'Low' }).click()
await waitFor(() => typed().length >= 3, { label: 'comandos digitados' }).catch(async (e) => {
  const sid = (await page.evaluate(() => window.cockpit.invoke('sessions:list')))[0]?.id
  console.log(JSON.stringify({
    typed: typed(),
    toast: await page.locator('.toasts').innerText().catch(() => ''),
    buffer: JSON.stringify(await page.evaluate((i) => window.cockpit.invoke('sessions:buffer', i), sid)).slice(-600),
    foot: await foot.innerText(),
    session: (await page.evaluate(() => window.cockpit.invoke('sessions:list')))[0],
    pending: await page.locator('.pf-pending').count(),
    errors,
  }, null, 2))
  await close()
  throw e
})
r.afterPick = typed()
r.checked = await foot.locator('[aria-checked="true"]').allInnerTexts()
await foot.getByRole('switch').click()
await waitFor(() => typed().length >= 4, { label: '/auto-modelo on' })
r.afterAuto = typed()

// Rascunho no prompt: não digita nada e avisa.
await page.locator('.pane-body').click()
await page.keyboard.type('rascunho')
await sleep(300)
await foot.getByRole('radio', { name: 'Haiku' }).click()
// Digitar faz a heurística marcar "trabalhando": a troca espera e, ociosa, vê o rascunho e avisa.
r.toast = await waitFor(async () => {
  const t = await page.locator('.toasts').innerText().catch(() => '')
  return /texto no prompt/i.test(t) && t
}, { label: 'aviso de rascunho' }).catch(() => '')
r.draftTyped = typed().length
await foot.screenshot({ path: join(SHOTS, 'model-bar-auto.png') })

// Painel estreito: vira "Opus 5.5 ▾" / "Extra high ▾".
// Dois Claudes lado a lado: cada painel fica estreito.
await command(app, 'split:claude')
await page.waitForFunction(() => document.querySelectorAll('.pane-foot').length === 2, null, { timeout: 10000 })
await sleep(1500)
r.paneWidth = await page.locator('.pane').first().evaluate((el) => el.clientWidth)
r.narrow = await foot.innerText()
await page.screenshot({ path: join(SHOTS, 'model-bar-narrow.png') })
await foot.locator('.pf-text-btn').last().click()
await sleep(300)
await page.screenshot({ path: join(SHOTS, 'model-bar-narrow-open.png') })
await page.keyboard.press('Escape')

// Vitrine e tema claro.
await page.emulateMedia({ colorScheme: 'dark' })
await command(app, 'components')
await page.waitForSelector('.sheet.showcase')
await sleep(500)
await page.screenshot({ path: join(SHOTS, 'components-dark.png') })
await page.emulateMedia({ colorScheme: 'light' })
await sleep(600)
await page.screenshot({ path: join(SHOTS, 'components-light.png') })
await page.keyboard.press('Escape')
await sleep(300)
await page.screenshot({ path: join(SHOTS, 'model-bar-light.png') })

await close()
const ok = r.afterPick.join('|') === '/auto-modelo off|/model sonnet|/effort low'
  && r.afterAuto[3] === '/auto-modelo on' && r.draftTyped === 4 && /texto no prompt/i.test(r.toast)
console.log(JSON.stringify({ ok, ...r, errors: errors.filter((e) => !/Debugger/.test(e)) }, null, 2))
process.exit(ok ? 0 : 1)
