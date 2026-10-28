// Rodapé de modelo com o Codex REAL: troca modelo e esforço pelo menu /model, só nesta sessão (tecla `s`).
// Usa o HOME real (o Codex precisa do login) e confere que ~/.codex/config.toml continua igual.
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer, launch, ROOT, sessions, sleep, waitFor } from './lib.mjs'

const SHOTS = process.env.COCKPIT_SHOTS ?? tmpdir()
const config = join(homedir(), '.codex', 'config.toml')
const before = readFileSync(config, 'utf8')
const { page, errors, close } = await launch({ store: { added: [ROOT], meta: { [ROOT]: { favorite: true } } } })
await page.emulateMedia({ colorScheme: 'dark' })
const r = {}
try {
  await page.getByRole('button', { name: /^Terminal/ }).first().click()
  await page.getByRole('button', { name: /Abrir Codex/ }).click()
  const foot = page.locator('.pane-foot').first()
  // O rodapé lê o modelo no rodapé do próprio Codex.
  await waitFor(async () => /GPT/i.test(await foot.innerText()), { timeout: 30000, label: 'modelo do Codex no rodapé' })
  r.initial = await foot.innerText()

  // Esforço (segmentado): Medium.
  await foot.getByRole('radio', { name: 'Medium' }).click()
  await waitFor(async () => /Medium/.test(await foot.locator('[aria-checked="true"]').allInnerTexts().then((t) => t.join())) && !(await foot.locator('.pf-pending').count()), { timeout: 20000, label: 'esforço aplicado' })
  await sleep(2500)
  r.afterEffort = await foot.locator('[aria-checked="true"]').allInnerTexts()

  // Modelo (lista): GPT-6-Astra com Max, que mora no submenu "More reasoning…".
  await foot.locator('.pf-text-btn').first().click()
  await page.locator('.dropdown .dd-item', { hasText: /^GPT-6-Astra$/ }).click()
  await waitFor(async () => !(await foot.locator('.pf-pending').count()), { timeout: 20000, label: 'modelo aplicado' })
  await foot.getByRole('radio', { name: 'Max' }).click()
  await waitFor(async () => !(await foot.locator('.pf-pending').count()), { timeout: 20000, label: 'max aplicado' })
  await sleep(2500)
  r.afterModel = { model: await foot.locator('.pf-text-btn').first().innerText(), checked: await foot.locator('[aria-checked="true"]').allInnerTexts() }
  const sid = (await sessions(page)).find((s) => s.agent === 'codex').id
  // As confirmações do próprio Codex (o texto vem sem espaços depois de limpar os escapes).
  r.confirmations = [...(await buffer(page, sid)).replace(/\s+/g, '').matchAll(/Modelchangedto([\w.-]+?)(low|medium|high|xhigh|max|ultra)forthissessiononly/g)].map((m) => `${m[1]} ${m[2]}`)
  r.toast = await page.locator('.toasts').innerText().catch(() => '')
  await page.screenshot({ path: join(SHOTS, 'model-bar-codex.png') })
} finally {
  await close()
}
r.configUnchanged = readFileSync(config, 'utf8') === before
const ok = r.configUnchanged && !r.toast && r.afterEffort.includes('Medium')
  && /GPT-6-Astra/.test(r.afterModel.model) && r.afterModel.checked.includes('Max')
  && r.confirmations.at(-1) === 'gpt-6-astra max'
console.log(JSON.stringify({ ok, ...r, errors: errors.filter((e) => !/Debugger/.test(e)) }, null, 2))
process.exit(ok ? 0 : 1)
