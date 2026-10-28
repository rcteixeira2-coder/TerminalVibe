// S1–S4: Codex real, notificação + clique, grade não redimensiona pty, claude dentro de um shell.
import { join } from 'node:path'
import { launch, openAgent, openProject, waitFor, sessions, sleep, typeLine, buffer, command, SHOTS } from './lib.mjs'

const results = {}
const only = process.argv[2]
const act = async (page, id) => (await sessions(page)).find((x) => x.id === id)

// ---------- S1: Codex real ----------
if (!only || only === 'S1') {
  const { page, close } = await launch()
  const s = await openAgent(page, 'Terminal', 'Abrir Codex')
  const seen = []
  let last = ''
  const watch = async (ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const x = await act(page, s.id)
      const k = `${x.activity}|${x.activitySource ?? ''}`
      if (k !== last) seen.push({ t: Date.now(), k }), (last = k)
      await sleep(250)
    }
  }
  await watch(9000)
  const startText = await buffer(page, s.id)
  if (/trust|confia/i.test(startText.slice(-4000))) {
    await page.keyboard.press('Enter')
    await watch(4000)
  }
  await page.screenshot({ path: join(SHOTS, 'rl-s1-codex-start.png') })
  // O Codex trata digitação rápida + Enter como colagem (vira nova linha): pausa antes de enviar, como uma pessoa.
  await page.keyboard.type('Responda apenas com a palavra ok, sem usar ferramentas.', { delay: 25 })
  await sleep(1500)
  await page.keyboard.press('Enter')
  await watch(45000)
  await page.screenshot({ path: join(SHOTS, 'rl-s1-codex-end.png') })
  results.S1 = { transitions: seen.map((x) => x.k) }
  await page.evaluate((id) => window.cockpit.invoke('sessions:kill', id), s.id)
  await sleep(1200)
  await close()
}

// ---------- S2: notificação ----------
if (!only || only === 'S2') {
  const { app, page, close } = await launch()
  const s = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, s.id)).includes('%'))
  await app.evaluate(({ Notification }) => {
    globalThis.__shown = []
    const orig = Notification.prototype.show
    Notification.prototype.show = function () {
      globalThis.__shown.push({ title: this.title, body: this.body })
      globalThis.__lastN = this
      return orig.call(this)
    }
  })
  // Janela sem foco: o Cockpit deve avisar.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).hide())
  await sleep(400)
  const msg = Buffer.from('Bash: npm publish').toString('base64')
  await page.evaluate(([id, m]) => window.cockpit.send('pty:write', id, `printf '\\033]7501;state=blocked:app=claude-code:kind=permission:msg=${m}\\033\\\\'\r`), [s.id, msg])
  await sleep(1200)
  const shown = await app.evaluate(() => globalThis.__shown)
  // Clicar na notificação mostra a janela e foca o painel.
  await app.evaluate(() => globalThis.__lastN?.emit('click'))
  await sleep(800)
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).isVisible())
  const focusedPane = await page.locator('.pane.focused').count()
  // Com a janela visível e a sessão na tela, não avisa de novo.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).focus())
  await sleep(300)
  await page.evaluate((id) => window.cockpit.send('pty:write', id, `printf '\\033]7501;state=error:app=claude-code\\033\\\\'\r`), s.id)
  await sleep(1000)
  const shownAfterFocused = (await app.evaluate(() => globalThis.__shown)).length
  results.S2 = { shown, afterClick: { visible, focusedPane }, noNotifyWhenWatching: shownAfterFocused === shown.length }
  await close()
}

// ---------- S3: grade não redimensiona pty ----------
if (!only || only === 'S3') {
  const { app, page, close } = await launch()
  for (const proj of ['Terminal', 'Hermes', 'Brain']) {
    await openAgent(page, proj)
    await sleep(800)
    const n = proj === 'Terminal' ? 3 : proj === 'Hermes' ? 2 : 1
    for (let i = 0; i < n; i++) {
      await page.getByRole('button', { name: /Dividir/ }).first().click()
      await sleep(900)
    }
  }
  await sleep(800)
  const before = Object.fromEntries((await sessions(page)).map((x) => [x.id, `${x.cols}x${x.rows}`]))
  await command(app, 'grid')
  await sleep(2500)
  await page.screenshot({ path: join(SHOTS, 'rl-s3-grid8.png') })
  const cards = await page.locator('.card').count()
  const after = Object.fromEntries((await sessions(page)).map((x) => [x.id, `${x.cols}x${x.rows}`]))
  const changed = Object.keys(before).filter((k) => before[k] !== after[k])
  results.S3 = { sessions: Object.keys(before).length, cards, changed, ok: Object.keys(before).length === 9 && cards === 9 && changed.length === 0 }
  await close()
}

// ---------- S4: claude digitado num shell ----------
if (!only || only === 'S4') {
  const { page, close } = await launch()
  const s = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, s.id)).includes('%'))
  await typeLine(page, 'claude')
  const inside = await waitFor(async () => {
    const x = await act(page, s.id)
    return x.foreground === 'claude' && x.activity === 'your_turn' ? x : null
  }, { timeout: 30000, label: 'claude em primeiro plano com status' })
  const headerIcon = await page.locator('.pane .agent-icon').first().textContent()
  await typeLine(page, '/exit')
  const out = await waitFor(async () => {
    const x = await act(page, s.id)
    return !x.foreground ? x : null
  }, { timeout: 20000, label: 'claude saiu' })
  results.S4 = { inside: { fg: inside.foreground, activity: inside.activity, source: inside.activitySource, headerIcon }, afterExit: { fg: out.foreground ?? null, activity: out.activity } }
  await close()
}
console.log(JSON.stringify(results, null, 2))
