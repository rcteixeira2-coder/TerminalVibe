// Botão ✳ Mods no cabeçalho da sessão do Claude: abre a janela, liga um mod e "Reiniciar e retomar" mantém a conversa.
// HOME falso: o ~/.claude/settings.json real nunca é tocado.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, SHOTS, sleep } from './lib.mjs'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-home-')))
symlinkSync(join(homedir(), '.local'), join(home, '.local'))
const mod = join(home, '.claude', 'mods', 'mod-teste', '.claude-plugin')
mkdirSync(mod, { recursive: true })
writeFileSync(join(mod, 'plugin.json'), JSON.stringify({ name: 'mod-teste', version: '1.0.0', description: 'Mod de teste do Cockpit' }))
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
const fixture = join(home, 'Projeto Mods')
mkdirSync(fixture)
const { page, errors, close } = await launch({ store: { added: [fixture], meta: { [fixture]: { favorite: true } } }, env: { HOME: home } })
const r = {}
await page.getByRole('button', { name: /Projeto Mods/ }).first().click()
await page.getByRole('button', { name: /Abrir Claude/ }).click()
await sleep(2500)
const before = (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).find((s) => s.agent === 'claude')
r.btnInPane = await page.locator('.pane-head .claude-mods-btn').count()
await page.locator('.pane-head .claude-mods-btn').click()
await sleep(500)
r.sheet = await page.locator('.sheet').innerText()
await page.locator('.sheet label.pref', { hasText: 'mod-teste' }).locator('.switch span').click()
await sleep(500)
r.settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins
r.restartBox = await page.locator('.claude-mods-restart').innerText()
await page.screenshot({ path: join(SHOTS, 'shot-claude-mods-pane.png') })
await page.getByRole('button', { name: /Reiniciar e retomar/ }).click()
await page.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 15000 })
await sleep(2500)
const after = (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).filter((s) => s.agent === 'claude')
r.after = after.map((s) => ({ same: s.claudeSessionId === before.claudeSessionId, newPane: s.id !== before.id, lifecycle: s.lifecycle, resume: s.id !== before.id }))
r.panes = await page.locator('.slot .pane-title, .pane .pane-title').allInnerTexts()
await close()
console.log(JSON.stringify({ ...r, errors: errors.filter((e) => !/Debugger/.test(e)) }, null, 2))
