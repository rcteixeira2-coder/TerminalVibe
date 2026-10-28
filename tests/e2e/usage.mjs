// Painel 📊 Uso: HOME falso (registros do Claude Code e do Codex), limites do Claude pelo canal do plugin,
// e Admin APIs falsas (Anthropic e OpenAI). Nada sai para a rede e nenhum dado real é lido.
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, SHOTS, sleep } from './lib.mjs'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-home-')))
symlinkSync(join(homedir(), '.local'), join(home, '.local'))
const now = new Date()
const iso = (daysAgo, h = 12) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(h, 0, 0, 0); return d.toISOString() }
const cl = join(home, '.claude', 'projects', '-Users-x-Desktop-Projeto-A')
mkdirSync(cl, { recursive: true })
const msg = (id, ago, model, u, cwd = '/Users/x/Desktop/Projeto A') => JSON.stringify({ type: 'assistant', timestamp: iso(ago), cwd, requestId: `r${id}`, message: { id: `m${id}`, model, content: [{ type: 'text', text: 'conteúdo privado' }], usage: u } })
writeFileSync(join(cl, 's.jsonl'), [
  msg(1, 0, 'claude-opus-5-5', { input_tokens: 1000, cache_read_input_tokens: 2000000, cache_creation_input_tokens: 50000, cache_creation: { ephemeral_1h_input_tokens: 50000, ephemeral_5m_input_tokens: 0 }, output_tokens: 30000 }),
  msg(2, 2, 'claude-sonnet-5-5', { input_tokens: 500, output_tokens: 8000 }, '/Users/x/Desktop/Projeto B'),
  msg(3, 20, 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1000000 }),
].join('\n') + '\n')
const cx = join(home, '.codex', 'sessions', '2026', '10', '27')
mkdirSync(cx, { recursive: true })
writeFileSync(join(cx, 'rollout-x.jsonl'), [
  JSON.stringify({ timestamp: iso(0, 9), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/Users/x/Desktop/Projeto C' } }),
  JSON.stringify({ timestamp: iso(0, 10), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50000, cached_input_tokens: 40000, cache_write_input_tokens: 0, output_tokens: 2000 } }, rate_limits: { plan_type: 'pro', primary: { used_percent: 37, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 }, secondary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 7200 }, credits: { has_credits: false, unlimited: false, balance: '0' } } } }),
].join('\n') + '\n')

// Admin APIs falsas.
const seen = []
const server = createServer((q, r) => {
  seen.push({ path: q.url.split('?')[0], key: q.headers['x-api-key'] ?? q.headers.authorization })
  const day = { starting_at: iso(0, 0), ending_at: iso(-1, 0) }
  r.setHeader('content-type', 'application/json')
  if (q.url.startsWith('/v1/organizations/cost_report')) return r.end(JSON.stringify({ data: [{ ...day, results: [{ amount: '1234.5', currency: 'USD', model: 'claude-opus-5-5', description: 'x' }] }], has_more: false, next_page: null }))
  if (q.url.startsWith('/v1/organizations/usage_report/messages')) return r.end(JSON.stringify({ data: [{ ...day, results: [{ uncached_input_tokens: 100, cache_read_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens: 50 }] }], has_more: false, next_page: null }))
  const st = Math.floor(Date.now() / 1000)
  if (q.url.startsWith('/v1/organization/costs')) return r.end(JSON.stringify({ object: 'page', data: [{ object: 'bucket', start_time: st, end_time: st + 86400, results: [{ object: 'organization.costs.result', amount: { value: 3.5, currency: 'usd' }, line_item: 'gpt-6.1-sol, input' }] }], has_more: false, next_page: null }))
  if (q.url.startsWith('/v1/organization/usage/completions')) return r.end(JSON.stringify({ object: 'page', data: [{ object: 'bucket', start_time: st, end_time: st + 86400, results: [{ object: 'organization.usage.completions.result', input_tokens: 7000, output_tokens: 300, input_cached_tokens: 5000, num_model_requests: 3 }] }], has_more: false, next_page: null }))
  r.statusCode = 404
  r.end('{}')
})
await new Promise((res) => server.listen(0, '127.0.0.1', res))
const port = server.address().port
const base = JSON.stringify({ anthropic: `http://127.0.0.1:${port}`, openai: `http://127.0.0.1:${port}/v1` })

const fixture = join(home, 'Projeto Uso')
mkdirSync(fixture)
const { page, errors, close } = await launch({ store: { added: [fixture], meta: { [fixture]: { favorite: true } } }, env: { HOME: home, COCKPIT_USAGE_TEST_BASEURL: base } })
const r = {}
// Limites do Claude pelo canal real do plugin: report.sh dentro de um terminal do Cockpit (tem COCKPIT_SOCK/TOKEN).
await page.getByRole('button', { name: /Projeto Uso/ }).first().click()
await page.getByRole('button', { name: /Abrir Terminal/ }).click()
await sleep(1500)
const sid = (await page.evaluate(() => window.cockpit.invoke('sessions:list')))[0].id
const resets = new Date(Date.now() + 2 * 3600e3 + 10 * 60e3).toISOString()
const payload = JSON.stringify({ hook_event_name: 'CockpitUsage', rateLimits: [{ kind: 'five_hour', percentUsed: 76.5, resetsAt: resets }, { kind: 'seven_day', percentUsed: 21, resetsAt: new Date(Date.now() + 4 * 86400e3).toISOString() }] })
await page.evaluate(([id, text]) => window.cockpit.send('pty:write', id, text), [sid, `printf '%s' '${payload}' | sh "$(dirname "$COCKPIT_SOCK")/../claude-plugin/hooks/report.sh"; echo FEITO\r`])
await page.waitForFunction(() => document.querySelector('.usage-btn .usage-pct'), null, { timeout: 10000 })
r.sidebar = await page.locator('.usage-btn').innerText()
r.sidebarTitle = await page.locator('.usage-btn').getAttribute('title')
await page.locator('.usage-btn').click()
await page.waitForSelector('.usage-card', { timeout: 30000 })
await sleep(500)
r.plans = await page.locator('.usage-cards').innerText()
await page.screenshot({ path: join(SHOTS, 'shot-usage-plans.png') })
await page.getByRole('button', { name: 'Sessões' }).click()
await sleep(300)
r.sessions7d = await page.locator('.usage-source-head').allInnerTexts()
r.tableModels = await page.locator('.usage-source').first().locator('tbody tr').allInnerTexts()
await page.screenshot({ path: join(SHOTS, 'shot-usage-sessions.png') })
await page.getByRole('button', { name: '30 dias' }).click()
await sleep(1500)
r.sessions30d = await page.locator('.usage-source-head').allInnerTexts()
await page.getByRole('button', { name: 'API', exact: true }).click()
await sleep(300)
r.locked = await page.locator('.usage-locked').count()
// Chaves Admin (falsas) salvas pelo main; depois "Carregar uso da API".
await page.evaluate(() => Promise.all([window.cockpit.invoke('usage:setAdminKey', 'anthropic-admin', 'sk-ant-admin01-FALSA'), window.cockpit.invoke('usage:setAdminKey', 'openai-admin', 'sk-admin-FALSA')]))
await page.getByRole('button', { name: 'Carregar uso da API' }).click()
await page.waitForSelector('.usage-accounts', { timeout: 20000 })
await sleep(500)
r.accounts = await page.locator('.usage-accounts').innerText()
await page.screenshot({ path: join(SHOTS, 'shot-usage-api.png') })
r.adminCalls = seen.map((s) => `${s.path} ${s.key?.includes('FALSA') ? 'chave-ok' : 'SEM-CHAVE'}`)
r.keyLeakInDom = (await page.content()).includes('FALSA')
r.privateLeak = (await page.content()).includes('conteúdo privado')
await close()
server.close()
console.log(JSON.stringify({ ...r, errors: errors.filter((e) => !/Debugger|GPU|SharedImage/.test(e)) }, null, 2))
