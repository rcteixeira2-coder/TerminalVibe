// Agente no app real, com o Grok apontado para um servidor falso local.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openAgent, openProject, command, waitFor, buffer, sleep, SHOTS } from './lib.mjs'
import { startFakeOpenAI } from '../fixtures/fakeLLM.mjs'

const fake = await startFakeOpenAI()
const env = { COCKPIT_AGENT_TEST_BASEURL: JSON.stringify({ xai: fake.url }) }
const r = {}
let userData
{
  const l = await launch({ env })
  userData = l.userData
  const { app, page, close, errors } = l
  // Terminal aberto no projeto (destino do "Enviar para a sessão").
  const s = await openAgent(page, 'Terminal')
  await waitFor(async () => (await buffer(page, s.id)).includes('%'))
  // Chave pela tela de Preferências.
  await command(app, 'prefs')
  // Preferências não abre o Keychain sozinha: só ao pedir as chaves.
  r.prefsLazy = (await page.locator('.provider-row').count()) === 0
  await page.getByRole('button', { name: 'Mostrar chaves' }).click()
  await page.locator('.provider-row').filter({ hasText: 'Grok' }).locator('input').fill('xai-chave-de-teste')
  await page.locator('.provider-row').filter({ hasText: 'Grok' }).getByRole('button', { name: 'Salvar' }).click()
  const testMsg = await waitFor(async () => (await page.locator('.provider-row').filter({ hasText: 'Grok' }).locator('.ok-text, .error').textContent().catch(() => null)), { label: 'teste da chave' })
  r.keyUiShowsKey = (await page.content()).includes('xai-chave-de-teste')
  await page.keyboard.press('Escape')
  // Abre o agente (⌘L) e escolhe o modelo.
  await command(app, 'agent')
  await page.waitForSelector('.agent')
  await page.locator('.model-btn').click()
  await page.getByRole('button', { name: 'grok-fake', exact: true }).click()
  await page.locator('.composer textarea').fill('O que tem no README?')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await page.locator('.msg.assistant:not(.streaming) .md').count()) > 0, { label: 'resposta', timeout: 20000 })
  await sleep(300)
  await page.screenshot({ path: join(SHOTS, 'agent-1-answer.png') })
  r.answer = await page.locator('.msg.assistant .md').first().innerText()
  r.chip = await page.locator('.tool-chip').first().innerText()
  r.meta = await page.locator('.msg-meta').first().innerText()
  r.authSent = fake.calls[0].auth
  r.toolResultReachedModel = JSON.stringify(fake.calls[1].body.messages).includes('# Cockpit')
  // Caminho clicável → prévia.
  await page.locator('.md code', { hasText: 'README.md:1' }).first().click()
  r.previewTitle = await waitFor(async () => page.locator('.preview h3').textContent().catch(() => null), { label: 'prévia' })
  await page.keyboard.press('Escape')
  await sleep(300)
  // Enviar para a sessão: cola no shell sem executar.
  await page.locator('.pane-body').first().click()
  await sleep(200)
  await page.getByRole('button', { name: 'Enviar para a sessão' }).first().click()
  await sleep(800)
  const b = await buffer(page, s.id)
  r.pasted = b.includes('O arquivo') && !/command not found|não encontrado/i.test(b)
  await page.keyboard.press('Control+c')
  r.errors = errors
  await close()
}
// O histórico em disco é criptografado (nenhum texto legível).
const histDir = join(userData, 'agent', 'history')
const files = readdirSync(histDir)
r.historyPlaintext = files.some((f) => readFileSync(join(histDir, f)).toString('latin1').includes('README'))
r.keysPlaintext = readFileSync(join(userData, 'agent', 'keys.bin')).toString('latin1').includes('xai-chave')
// Reabre: a conversa continua na lista e abre com as mensagens.
{
  const { page, close, app } = await launch({ userData, env })
  await openProject(page, 'Terminal')
  await command(app, 'agent')
  await page.waitForSelector('.agent-head')
  await page.locator('.agent-head .menu-wrap').last().getByRole('button').first().click()
  await page.getByRole('button', { name: /O que tem no README/ }).first().click()
  await waitFor(async () => (await page.locator('.msg.assistant .md').count()) > 0, { label: 'conversa reaberta' })
  r.reopened = await page.locator('.msg.user .msg-text').first().innerText()
  await page.screenshot({ path: join(SHOTS, 'agent-2-reopened.png') })
  await close()
}
fake.server.close()
console.log(JSON.stringify(r, null, 2))
