// P5–P7: retomar a MESMA conversa (painel parado e depois de reabrir o app); reinício numa aba cheia.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openAgent, waitFor, sessions, sleep, typeLine, buffer, openProject, SHOTS } from './lib.mjs'

const claudeArgs = () => {
  try {
    return execFileSync('/bin/ps', ['-axo', 'args=']).toString().split('\n').filter((l) => /\.local\/bin\/claude\b|\/claude --/.test(l) && l.includes('cockpit') === false)
  } catch {
    return []
  }
}
const activity = async (page, id) => (await sessions(page)).find((x) => x.id === id)?.activity
const results = {}
const userData = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'))

// ---------- P5 ----------
{
  const { app, page, close } = await launch({ userData })
  const s = await openAgent(page, 'Terminal', 'Abrir Claude')
  await waitFor(async () => (await activity(page, s.id)) === 'your_turn', { timeout: 30000, label: 'claude pronto' })
  await sleep(500)
  await typeLine(page, 'Responda apenas: ok')
  await waitFor(async () => (await activity(page, s.id)) === 'done', { timeout: 60000, label: 'resposta' })
  const original = (await sessions(page)).find((x) => x.id === s.id).claudeSessionId
  await page.getByRole('button', { name: 'Encerrar' }).click()
  await waitFor(async () => (await sessions(page)).find((x) => x.id === s.id)?.lifecycle === 'exited', { label: 'encerrado' })
  await page.getByRole('button', { name: /Retomar conversa/ }).click()
  const resumed = await waitFor(async () => (await sessions(page)).find((x) => x.id !== s.id && x.lifecycle === 'running'), { label: 'retomada' })
  await sleep(2500)
  const args = claudeArgs().find((l) => l.includes('--resume'))
  await waitFor(async () => ['your_turn', 'done'].includes(await activity(page, resumed.id)), { timeout: 30000, label: 'retomada pronta' })
  const info = (await sessions(page)).find((x) => x.id === resumed.id)
  const panes = await page.locator('.pane').count()
  const text = await page.evaluate((id) => window.__cockpitTest.text(id), resumed.id)
  results.P5 = {
    original,
    resumeArgsHasId: !!args && args.includes(`--resume ${original}`),
    sessionIdAfter: info.claudeSessionId,
    sameConversation: info.claudeSessionId === original,
    oldPaneRemoved: panes === 1,
    historyVisible: /Responda apenas: ok/.test(text),
  }
  // Deixa este Claude aberto para o P6 (o app salva openSessions no quit).
  await close()
  results.P6pre = { claudeSessionId: info.claudeSessionId }
}

// ---------- P6 ----------
{
  const { app, page, close } = await launch({ userData })
  await openProject(page, 'Terminal')
  await sleep(500)
  const btn = page.getByRole('button', { name: /Retomar conversa — Claude/ })
  const shown = await btn.count()
  await page.screenshot({ path: join(SHOTS, 'rl-p6-restore.png') })
  await btn.first().click()
  const s = await waitFor(async () => (await sessions(page))[0], { label: 'sessão retomada' })
  await sleep(2500)
  const args = claudeArgs().find((l) => l.includes('--resume'))
  await waitFor(async () => ['your_turn', 'done'].includes(await activity(page, s.id)), { timeout: 30000, label: 'pronto' })
  const info = (await sessions(page)).find((x) => x.id === s.id)
  results.P6 = {
    buttonShown: shown,
    resumeArgsHasId: !!args && args.includes(`--resume ${results.P6pre.claudeSessionId}`),
    sameConversation: info.claudeSessionId === results.P6pre.claudeSessionId,
  }
  await page.evaluate((id) => window.cockpit.invoke('sessions:kill', id), s.id)
  await sleep(1500)
  await close()
}

// ---------- P7 ----------
{
  const { app, page, close } = await launch()
  const first = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, first.id)).includes('%'))
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: /Dividir/ }).first().click()
    await sleep(1200)
  }
  const list = await sessions(page)
  const third = list.sort((a, b) => a.startedAt - b.startedAt)[2]
  const orderBefore = await page.locator('.pane .pane-title').allTextContents()
  await page.evaluate((id) => window.cockpit.invoke('sessions:kill', id), third.id)
  await waitFor(async () => (await sessions(page)).find((x) => x.id === third.id)?.lifecycle === 'exited', { label: 'terceiro parado' })
  await page.locator('.pane').nth(2).getByRole('button', { name: 'Nova sessão' }).click()
  await sleep(2000)
  const orderAfter = await page.locator('.pane .pane-title').allTextContents()
  const tabs = await page.locator('.tab').count()
  results.P7 = { orderBefore, orderAfter, tabs, panes: orderAfter.length, ok: tabs === 1 && orderAfter.length === 4 }
  await close()
}
console.log(JSON.stringify(results, null, 2))
