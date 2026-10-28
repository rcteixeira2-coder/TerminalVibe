// P1–P4: árvore de processos, quit sem órfãos, saída enorme, recarga da interface.
import { execFileSync } from 'node:child_process'
import { launch, openAgent, typeLine, buffer, waitFor, sessions, sleep } from './lib.mjs'

const pg = (pat) => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', pat]).toString().trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const marker = (name, ignoreTerm = false) =>
  `perl -e '${ignoreTerm ? '$SIG{TERM}="IGNORE"; ' : ''}$0="${name}"; sleep 300'`
const results = {}

// ---------- P1 ----------
{
  const { app, page } = await launch()
  const s = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, s.id)).includes('%'))
  await typeLine(page, `sh -c '${marker('cockpit-p1-a').replace(/'/g, `'\\''`)} & ${marker('cockpit-p1-b', true).replace(/'/g, `'\\''`)} & wait'`)
  await waitFor(() => pg('cockpit-p1-').length >= 2, { label: 'netos vivos' })
  const before = pg('cockpit-p1-').length
  await sleep(600) // árvore capturada a cada 0,4 s
  await page.getByRole('button', { name: 'Encerrar' }).click()
  await sleep(2500)
  const after = pg('cockpit-p1-').length
  const life = (await sessions(page)).find((x) => x.id === s.id)?.lifecycle
  results.P1 = { before, after, lifecycle: life, ok: before >= 2 && after === 0 }
  await app.close()
}

// ---------- P2 ----------
{
  const { app, page } = await launch()
  const a = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, a.id)).includes('%'))
  await typeLine(page, marker('cockpit-p2-a', true))
  await page.getByRole('button', { name: /Dividir/ }).first().click()
  await sleep(1500)
  await typeLine(page, marker('cockpit-p2-b'))
  await waitFor(() => pg('cockpit-p2-').length >= 2, { label: 'processos P2' })
  const before = pg('cockpit-p2-').length
  await sleep(600)
  const t0 = Date.now()
  await app.close() // dispara before-quit → stopAll
  await sleep(1500)
  results.P2 = { before, after: pg('cockpit-p2-').length, quitMs: Date.now() - t0, ok: before >= 2 && pg('cockpit-p2-').length === 0 }
}

// ---------- P3 + P4 ----------
{
  const { app, page, errors } = await launch()
  const s = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, s.id)).includes('%'))
  const t0 = Date.now()
  await typeLine(page, 'seq 1 300000; echo fim-seq')
  await waitFor(async () => (await page.evaluate((id) => window.__cockpitTest.text(id), s.id)).includes('fim-seq'), { timeout: 60000, label: 'fim-seq no xterm' })
  const seqMs = Date.now() - t0
  await typeLine(page, 'echo responde-depois')
  await waitFor(async () => (await page.evaluate((id) => window.__cockpitTest.text(id), s.id)).includes('responde-depois\n'), { label: 'eco pós-seq' })
  results.P3 = { seqMs, ok: true }

  // P4: recarrega a interface com saída rolando
  await typeLine(page, 'clear; for i in $(seq 1 300); do echo linha-$i; sleep 0.01; done; echo fim-loop')
  await sleep(700)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('mod://')).webContents.reload())
  await page.waitForSelector('.sidebar')
  await waitFor(async () => (await page.evaluate((id) => window.__cockpitTest?.text(id) ?? '', s.id)).includes('fim-loop'), { timeout: 30000, label: 'fim-loop após reload' })
  const text = await page.evaluate((id) => window.__cockpitTest.text(id), s.id)
  const nums = [...text.matchAll(/^linha-(\d+)$/gm)].map((m) => Number(m[1]))
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i)
  const missing = []
  const seen = new Set(nums)
  for (let i = Math.min(...nums); i <= 300; i++) if (!seen.has(i)) missing.push(i)
  await page.locator('.pane-body').first().click()
  await typeLine(page, 'echo vivo-apos-reload')
  await waitFor(async () => (await page.evaluate((id) => window.__cockpitTest.text(id), s.id)).includes('vivo-apos-reload\n'), { label: 'eco pós-reload' })
  const live = (await sessions(page)).find((x) => x.id === s.id)
  results.P4 = { lines: nums.length, first: Math.min(...nums), dup: dup.slice(0, 10), missing: missing.slice(0, 10), lifecycle: live.lifecycle, ok: dup.length === 0 && missing.length === 0 }
  results.errors = errors
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
