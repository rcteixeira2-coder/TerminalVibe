import OpenAI from 'openai'
import type { AccountUsage, UsagePeriod } from '@shared/types'
import { localDay, periodStart } from './scan'

// Uso da conta inteira nas APIs, com chaves Admin (só leitura de relatórios; nenhum token de modelo é gasto).

function startOf(period: UsagePeriod, now: number): Date {
  return new Date(`${periodStart(period, now)}T00:00:00`)
}

function friendly(e: unknown, name: string): string {
  const status = (e as { status?: number })?.status
  if (status === 401 || status === 403) return `Chave Admin da ${name} recusada (inválida ou sem permissão de leitura de uso).`
  if (status === 404) return `A ${name} não ofereceu o relatório para esta conta (contas individuais não têm a Admin API).`
  if (status === 429) return `A ${name} pediu para esperar (muitas consultas). Tente de novo em 1 minuto.`
  const msg = String((e as Error)?.message ?? e)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(msg)) return `Sem conexão com a ${name}.`
  return `Não consegui ler o uso da ${name}.`
}

type Bucket<T> = { starting_at: string; results: T[] }
type Page<T> = { data: Bucket<T>[]; has_more: boolean; next_page: string | null }

// Anthropic: Usage & Cost Admin API por HTTP (o SDK não tem esses relatórios). Valores do custo em centavos.
export async function anthropicAccount(key: string, period: UsagePeriod, now = Date.now(), base = 'https://api.anthropic.com'): Promise<AccountUsage> {
  const out: AccountUsage = { id: 'anthropic', title: 'Anthropic (Console)', configured: true }
  try {
    const starting = startOf(period, now).toISOString()
    const get = async <T,>(path: string, params: Record<string, string | string[]>): Promise<Bucket<T>[]> => {
      const buckets: Bucket<T>[] = []
      let page: string | null = null
      for (let i = 0; i < 10; i++) {
        const u = new URL(path, base)
        for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) u.searchParams.append(k, x)
        if (page) u.searchParams.set('page', page)
        const r = await fetch(u, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': 'Cockpit/1.0' } })
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })
        const j = (await r.json()) as Page<T>
        buckets.push(...j.data)
        if (!j.has_more || !j.next_page) break
        page = j.next_page
      }
      return buckets
    }
    const [cost, usage] = await Promise.all([
      get<{ amount: string; model: string | null; description: string | null }>('/v1/organizations/cost_report', { starting_at: starting, limit: '31', 'group_by[]': 'description' }),
      get<{ uncached_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; output_tokens: number }>(
        '/v1/organizations/usage_report/messages',
        { starting_at: starting, bucket_width: '1d', limit: '31' },
      ),
    ])
    const byItem = new Map<string, number>()
    out.days = cost.map((b) => {
      let c = 0
      for (const r of b.results) {
        const usd = Number(r.amount) / 100
        if (!Number.isFinite(usd)) continue
        c += usd
        const label = r.model ?? r.description ?? 'Outros'
        byItem.set(label, (byItem.get(label) ?? 0) + usd)
      }
      return { day: localDay(Date.parse(b.starting_at) + 12 * 3600e3), cost: c }
    })
    out.cost = out.days.reduce((a, d) => a + d.cost, 0)
    out.byItem = [...byItem].map(([label, cost]) => ({ label, cost })).sort((a, b) => b.cost - a.cost)
    const t = { input: 0, output: 0, cacheRead: 0 }
    for (const b of usage) for (const r of b.results) {
      t.input += (r.uncached_input_tokens ?? 0) + (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0)
      t.output += r.output_tokens ?? 0
      t.cacheRead += r.cache_read_input_tokens ?? 0
    }
    out.tokens = t
  } catch (e) {
    out.error = friendly(e, 'Anthropic')
  }
  return out
}

// OpenAI: Admin API do SDK oficial (`client.admin.organization.usage`).
export async function openaiAccount(key: string, period: UsagePeriod, now = Date.now(), baseURL?: string): Promise<AccountUsage> {
  const out: AccountUsage = { id: 'openai', title: 'OpenAI (Platform)', configured: true }
  try {
    const client = new OpenAI({ apiKey: 'nao-usada', adminAPIKey: key, baseURL, maxRetries: 1 })
    const start_time = Math.floor(startOf(period, now).getTime() / 1000)
    const byItem = new Map<string, number>()
    const days = new Map<string, number>()
    let page: string | undefined
    for (let i = 0; i < 10; i++) {
      const r = await client.admin.organization.usage.costs({ start_time, bucket_width: '1d', group_by: ['line_item'], limit: 31, page })
      for (const b of r.data) {
        const day = localDay(b.start_time * 1000 + 12 * 3600e3)
        for (const x of b.results) {
          const v = 'amount' in x ? (x.amount?.value ?? 0) : 0
          days.set(day, (days.get(day) ?? 0) + v)
          const label = ('line_item' in x && x.line_item) || 'Outros'
          byItem.set(label, (byItem.get(label) ?? 0) + v)
        }
      }
      if (!r.has_more || !r.next_page) break
      page = r.next_page
    }
    out.days = [...days].map(([day, cost]) => ({ day, cost })).sort((a, b) => a.day.localeCompare(b.day))
    out.cost = out.days.reduce((a, d) => a + d.cost, 0)
    out.byItem = [...byItem].map(([label, cost]) => ({ label, cost })).sort((a, b) => b.cost - a.cost)
    const t = { input: 0, output: 0, cacheRead: 0 }
    page = undefined
    for (let i = 0; i < 10; i++) {
      const r = await client.admin.organization.usage.completions({ start_time, bucket_width: '1d', limit: 31, page })
      for (const b of r.data) for (const x of b.results) {
        if (x.object !== 'organization.usage.completions.result') continue
        t.input += x.input_tokens ?? 0
        t.output += x.output_tokens ?? 0
        t.cacheRead += x.input_cached_tokens ?? 0
      }
      if (!r.has_more || !r.next_page) break
      page = r.next_page
    }
    out.tokens = t
  } catch (e) {
    out.error = friendly(e, 'OpenAI')
  }
  return out
}
