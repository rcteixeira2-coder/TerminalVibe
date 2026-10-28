// Ícone do GitHub por projeto: ↓ ↑ ● na barra lateral, painel com commits, "Baixar" num terminal e pasta sem git.
// Usa um remote bare local: sem rede e sem o GitHub de verdade.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '.'
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-gitfx-')))
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd }).toString()
const commit = (dir, file, msg) => { writeFileSync(join(dir, file), msg); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', msg) }
const bare = join(base, 'remote.git')
g(base, 'init', '-q', '--bare', bare)
const seed = join(base, 'seed')
g(base, 'clone', '-q', bare, seed)
commit(seed, 'a.txt', 'primeiro commit')
g(seed, 'push', '-q', '-u', 'origin', 'main')
const misto = join(base, 'Projeto Misto')
const baixar = join(base, 'Projeto Baixar')
g(base, 'clone', '-q', bare, misto)
g(base, 'clone', '-q', bare, baixar)
commit(seed, 'b.txt', 'Mudança feita no GitHub')
g(seed, 'push', '-q')
commit(misto, 'c.txt', 'Mudança local para subir')
writeFileSync(join(misto, 'rascunho.md'), 'x')
const semGit = join(base, 'Projeto Sem Git')
mkdirSync(semGit)
writeFileSync(join(userData, 'cockpit.json'), JSON.stringify({ added: [misto, baixar, semGit], meta: {} }))

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const badge = (name) => page.locator('.proj', { has: page.locator('.proj-name', { hasText: name }) }).locator('.git-badge')
// Espera o fetch inicial (remote local, rápido).
await page.waitForFunction(() => document.querySelector('.git-badge.in') !== null, null, { timeout: 20000 })
await page.waitForTimeout(500)
const result = {
  misto: await badge('Projeto Misto').innerText(),
  baixar: await badge('Projeto Baixar').innerText(),
  semGitClass: await badge('Projeto Sem Git').getAttribute('class'),
}
await page.screenshot({ path: join(out, 'shot-git-sidebar.png') })
await badge('Projeto Misto').click()
await page.waitForTimeout(300)
result.panelMisto = await page.locator('.git-panel').innerText()
await page.screenshot({ path: join(out, 'shot-git-panel.png') })
await page.keyboard.press('Escape')
await badge('Projeto Sem Git').click()
await page.waitForTimeout(300)
result.panelSemGit = await page.locator('.git-panel').innerText()
await page.keyboard.press('Escape')
// Baixar: abre um terminal com git pull --ff-only; o ícone volta a "em dia".
await page.locator('.proj-name', { hasText: 'Projeto Baixar' }).click()
await badge('Projeto Baixar').click()
await page.getByRole('button', { name: '↓ Baixar' }).click()
await page.waitForFunction(() => [...document.querySelectorAll('.proj')].some((p) => p.textContent.includes('Projeto Baixar') && p.querySelector('.git-badge.sync')), null, { timeout: 30000 })
result.baixarDepois = await badge('Projeto Baixar').getAttribute('class')
result.sessions = (await page.evaluate(() => window.cockpit.invoke('sessions:list'))).map((s) => s.title)
result.pulled = g(baixar, 'log', '-1', '--format=%s').trim()
await page.screenshot({ path: join(out, 'shot-git-after-pull.png') })
await app.close()
console.log(JSON.stringify({ ...result, errors }, null, 2))
