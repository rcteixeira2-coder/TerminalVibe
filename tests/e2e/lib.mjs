// Utilitários dos testes de ponta a ponta: app real, userData isolado.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SHOTS = '/private/tmp/claude-501/-Users-rodrigoteixeira-Desktop-Terminal/1fbd14b6-2863-4dbe-a1fc-80cd79a4898f/scratchpad'
export const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch({ store, userData, env = {} } = {}) {
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))
  if (store) writeFileSync(join(dir, 'cockpit.json'), JSON.stringify(store))
  const app = await electron.launch({ args: [ROOT, `--user-data-dir=${dir}`], cwd: ROOT, env: { ...process.env, ELECTRON_RENDERER_URL: '', ...env } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  app.process().stderr?.on('data', (d) => {
    const s = String(d)
    if (!/Gtk|DevTools|GPU|task queue|Autofill/.test(s)) errors.push(`[main] ${s.slice(0, 300)}`)
  })
  await page.waitForSelector('.sidebar')
  // close() que espera o processo terminar de verdade (o Cockpit encerra as sessões antes de sair).
  const proc = app.process()
  const close = async () => {
    const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)))
    await app.close().catch(() => {})
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
  }
  return { app, page, errors, userData: dir, close }
}

export const mainWin = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).id)

export async function command(app, cmd) {
  await app.evaluate(({ BrowserWindow }, c) => {
    BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).webContents.send('ui:command', c)
  }, cmd)
}

export async function openProject(page, name) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
}

export async function sessions(page) {
  return page.evaluate(() => window.cockpit.invoke('sessions:list'))
}

export async function buffer(page, id) {
  return clean(await page.evaluate((i) => window.cockpit.invoke('sessions:buffer', i), id))
}

export function clean(s) {
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\x1b[=>78]/g, '').replace(/\r/g, '')
}

export async function waitFor(fn, { timeout = 15000, every = 200, label = 'condição' } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(every)
  }
  throw new Error(`timeout esperando ${label}`)
}

// Abre um agente no projeto e devolve a sessão nova.
export async function openAgent(page, project, label = 'Abrir Terminal') {
  await openProject(page, project)
  const before = new Set((await sessions(page)).map((s) => s.id))
  await page.getByRole('button', { name: new RegExp(label) }).click()
  return waitFor(async () => (await sessions(page)).find((s) => !before.has(s.id)), { label: 'sessão nova' })
}

export async function typeLine(page, text) {
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

// Centro (px) de uma célula do terminal da sessão (usa cols/rows do pty, iguais aos do xterm visível).
export async function cellPoint(page, sessionId, col, row) {
  const box = await page.locator('.pane.focused .xterm-screen').boundingBox()
  const s = (await sessions(page)).find((x) => x.id === sessionId)
  const cw = box.width / s.cols
  const ch = box.height / s.rows
  return { x: box.x + cw * (col + 0.5), y: box.y + ch * (row + 0.5) }
}
