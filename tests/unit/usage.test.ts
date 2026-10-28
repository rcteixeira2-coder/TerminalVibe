import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregate, claudeLine, listJsonl, localDay, scanFile } from '../../src/main/usage/scan'
import { costOf } from '../../src/main/usage/prices'

const root = mkdtempSync(join(tmpdir(), 'cockpit-usage-'))
const now = Date.parse('2026-10-27T15:00:00')
const ts = (d: string) => new Date(`${d}T12:00:00`).toISOString()

function claudeMsg(id: string, req: string, day: string, model: string, u: Record<string, unknown>, cwd = '/Users/x/Desktop/Projeto A') {
  return JSON.stringify({ type: 'assistant', timestamp: ts(day), cwd, requestId: req, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'segredo do usuário' }], usage: u } })
}

describe('uso: Claude Code', () => {
  const dir = join(root, 'claude', 'proj')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 's1.jsonl')
  const u = { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, output_tokens: 50 }
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'user', timestamp: ts('2026-10-27'), message: { content: 'oi' } }),
      claudeMsg('m1', 'r1', '2026-10-27', 'claude-opus-5-5', u),
      // A mesma resposta gravada de novo (streaming/retomada): conta uma vez só.
      claudeMsg('m1', 'r1', '2026-10-27', 'claude-opus-5-5', u),
      claudeMsg('m2', 'r2', '2026-10-20', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 10 }, '/Users/x/Desktop/Projeto B'),
      claudeMsg('m3', 'r3', '2026-10-27', '<synthetic>', { input_tokens: 999 }),
      '{"linha quebrada',
    ].join('\n') + '\n',
  )

  it('soma por dia, modelo e projeto sem repetir a mesma resposta', async () => {
    const st = await scanFile('claude', file, undefined)
    expect(st.entries).toHaveLength(3)
    const today = aggregate('claude', 'Claude Code', st.entries, 'today', now)
    expect(today.totals).toMatchObject({ input: 100, cacheWrite: 300, cacheRead: 1000, output: 50 })
    // 100×4 + 100×4×1,25 + 200×4×2 + 1000×0,2 + 50×20 = 400+500+1600+200+1000 = 3700 por milhão
    expect(today.totals.cost).toBeCloseTo(3700 / 1e6, 10)
    // A do dia 20 fica fora dos 7 dias (21 a 27) e entra nos 30.
    expect(aggregate('claude', 'Claude Code', st.entries, '7d', now).byModel.map((r) => r.key)).toEqual(['claude-opus-5-5'])
    const month = aggregate('claude', 'Claude Code', st.entries, '30d', now)
    expect(month.byModel.map((r) => r.key)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(month.byProject.map((r) => r.key).sort()).toEqual(['Projeto A', 'Projeto B'])
    expect(month.days).toHaveLength(30)
    expect(JSON.stringify(st)).not.toContain('segredo')
  })

  it('leitura incremental: só o que o arquivo ganhou', async () => {
    const st = await scanFile('claude', file, undefined)
    appendFileSync(file, claudeMsg('m4', 'r4', '2026-10-27', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }) + '\n')
    const st2 = await scanFile('claude', file, st)
    expect(st2.entries).toHaveLength(4)
    expect(st2.offset).toBeGreaterThan(st.offset)
    // Sem mudança: devolve o mesmo estado.
    expect(await scanFile('claude', file, st2)).toBe(st2)
  })

  it('linha incompleta fica para a próxima leitura', async () => {
    const f = join(dir, 's2.jsonl')
    const line = claudeMsg('m9', 'r9', '2026-10-27', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 5 })
    writeFileSync(f, line.slice(0, 40))
    const st = await scanFile('claude', f, undefined)
    expect(st.entries).toHaveLength(0)
    expect(st.offset).toBe(0)
    appendFileSync(f, line.slice(40) + '\n')
    expect((await scanFile('claude', f, st)).entries).toHaveLength(1)
  })

  it('ignora linhas sem uso e acha os arquivos', async () => {
    expect(claudeLine('{"type":"user"}')).toBeNull()
    expect((await listJsonl(join(root, 'claude'))).length).toBeGreaterThanOrEqual(1)
  })
})

describe('uso: Codex', () => {
  it('diferença do total acumulado, modelo da sessão e limite mais recente', async () => {
    const f = join(root, 'rollout.jsonl')
    const tc = (t: string, total: number[], rl?: object) =>
      JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], cache_write_input_tokens: 0, output_tokens: total[2] } }, rate_limits: rl ?? null } })
    writeFileSync(
      f,
      [
        JSON.stringify({ timestamp: '2026-10-27T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/Users/x/Desktop/Projeto C' } }),
        tc('2026-10-27T10:01:00Z', [1000, 400, 100], { plan_type: 'pro', primary: { used_percent: 10, window_minutes: 10080, resets_at: 1790000000 }, secondary: null }),
        tc('2026-10-27T10:02:00Z', [1000, 400, 100]),
        tc('2026-10-27T10:03:00Z', [3000, 2000, 300], { plan_type: 'pro', primary: { used_percent: 12, window_minutes: 10080, resets_at: 1790000000 } }),
      ].join('\n') + '\n',
    )
    const st = await scanFile('codex', f, undefined)
    expect(st.entries).toHaveLength(2)
    const a = aggregate('codex', 'Codex', st.entries, 'today', now)
    expect(a.totals).toMatchObject({ input: 1000, cacheRead: 2000, output: 300 })
    expect(a.totals.cost).toBeNull()
    expect(a.byModel[0].key).toBe('gpt-6.1-sol')
    expect(a.byProject[0].key).toBe('Projeto C')
    expect(st.limits).toMatchObject({ plan: 'pro', primary: { percent: 12, windowMinutes: 10080, resetsAt: 1790000000000 } })
  })
})

describe('preços', () => {
  it('modelo desconhecido não tem custo; dia local', () => {
    expect(costOf('gpt-6.1-sol', { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 })).toBeNull()
    expect(costOf('claude-sonnet-5-5', { input: 1e6, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1e6 })).toBe(12)
    expect(localDay(Date.parse('2026-10-27T12:00:00'))).toBe('2026-10-27')
  })
})
