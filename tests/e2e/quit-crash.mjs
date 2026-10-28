// Regressão: sair com sessões que mudam de status no exit (janela já destruída) não pode dar erro.
import { launch, openAgent, waitFor, buffer, sessions, sleep } from './lib.mjs'

const runs = []
for (let i = 0; i < 3; i++) {
  const { app, page, errors } = await launch()
  const a = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, a.id)).includes('%'))
  // Status ativo: no exit, a atividade muda (your_turn → unknown) e emite 'activity'.
  await page.evaluate((id) => window.cockpit.send('pty:write', id, "printf '\\033]7501;state=idle:app=claude-code\\033\\\\'\r"), a.id)
  await page.getByRole('button', { name: /Dividir/ }).first().click()
  await sleep(1200)
  const b = (await sessions(page)).find((x) => x.id !== a.id)
  await page.evaluate((id) => window.cockpit.send('pty:write', id, "printf '\\033]7501;state=working:app=claude-code\\033\\\\'\r"), b.id)
  await sleep(800)
  const acts = (await sessions(page)).map((x) => x.activity)
  const proc = app.process()
  const exited = new Promise((r) => proc.once('exit', (code) => r(code)))
  const t0 = Date.now()
  await app.close().catch(() => {})
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 10000))])
  if (code === 'TIMEOUT') proc.kill('SIGKILL')
  runs.push({ activitiesBeforeQuit: acts, exit: code, ms: Date.now() - t0, destroyedErrors: errors.filter((e) => /destroyed|erro não tratado|promessa rejeitada/.test(e)) })
}
console.log(JSON.stringify(runs, null, 2))
