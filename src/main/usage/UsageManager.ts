import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountUsage, AdminKeyId, AgentConversation, PlanCard, PlanWindow, UsagePeriod, UsageReport, UsageSource } from '@shared/types'
import type { AgentSecrets } from '../agent/secrets'
import createScanWorker from './scanWorker?nodeWorker'
import type { ScanInput, ScanOutput } from './scanWorker'
import { aggregate, localDay, type CodexLimits, type Entry } from './scan'
import { anthropicAccount, openaiAccount } from './admin'

const SCAN_MAX_AGE = 60_000
const ADMIN_MAX_AGE = 10 * 60_000

export interface ClaudeLimits {
  at: number
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

interface Deps {
  userData: string
  home: string
  secrets: AgentSecrets
  conversations(): Promise<AgentConversation[]>
  onLimits(card: PlanCard): void
  // Testes: endereços falsos das Admin APIs.
  adminBase?: { anthropic?: string; openai?: string }
}

const PROVIDER_LABEL: Record<string, string> = { xai: 'Grok (xAI)', anthropic: 'Claude (API)', openai: 'OpenAI (API)', ollama: 'Ollama', lmstudio: 'LM Studio' }

// Junta os limites dos planos, as sessões locais (Claude Code, Codex), o agente do Cockpit e a conta inteira das APIs.
export class UsageManager {
  private limitsFile: string
  private claude: ClaudeLimits | null = null
  private scan: { at: number; out: ScanOutput } | null = null
  private scanning: Promise<ScanOutput> | null = null
  private admin = new Map<string, { at: number; value: AccountUsage }>()

  constructor(private deps: Deps) {
    this.limitsFile = join(deps.userData, 'usage', 'limits.json')
    try {
      if (existsSync(this.limitsFile)) this.claude = JSON.parse(readFileSync(this.limitsFile, 'utf8')) as ClaudeLimits
    } catch {
      this.claude = null
    }
  }

  // Leitura que o plugin do Cockpit manda de dentro de cada sessão do Claude (a conta é uma só: vale a mais recente).
  setClaudeLimits(raw: unknown): void {
    if (!Array.isArray(raw)) return
    const rateLimits = raw
      .filter((r): r is { kind: string; percentUsed: number; resetsAt?: string } => !!r && typeof r.kind === 'string' && typeof r.percentUsed === 'number')
      .slice(0, 8)
      .map((r) => ({ kind: r.kind.slice(0, 40), percentUsed: Math.max(0, Math.min(1000, r.percentUsed)), resetsAt: typeof r.resetsAt === 'string' ? r.resetsAt.slice(0, 40) : undefined }))
    if (!rateLimits.length) return
    this.claude = { at: Date.now(), rateLimits }
    try {
      mkdirSync(join(this.deps.userData, 'usage'), { recursive: true, mode: 0o700 })
      writeFileSync(`${this.limitsFile}.tmp`, JSON.stringify(this.claude), { mode: 0o600 })
      renameSync(`${this.limitsFile}.tmp`, this.limitsFile)
    } catch {
      // vale só nesta abertura
    }
    this.deps.onLimits(this.claudeCard())
  }

  claudeCard(): PlanCard {
    const label = (k: string) => (k === 'five_hour' ? 'Sessão (5 h)' : k === 'seven_day' ? 'Semana' : k === 'spend_limit' ? 'Limite de gasto' : k)
    const windows: PlanWindow[] = (this.claude?.rateLimits ?? []).map((r) => {
      const t = r.resetsAt ? Date.parse(r.resetsAt) : NaN
      return { label: label(r.kind), percent: r.percentUsed, resetsAt: Number.isFinite(t) ? t : undefined }
    })
    return {
      id: 'claude',
      title: 'Claude (assinatura)',
      windows,
      readAt: this.claude?.at,
      note: windows.length ? undefined : 'Abra um Claude pelo Cockpit e mande uma mensagem: o próprio Claude informa os limites a cada resposta.',
    }
  }

  private codexCard(l: CodexLimits | undefined): PlanCard {
    const label = (m?: number) => (m === 300 ? 'Sessão (5 h)' : m === 10080 ? 'Semana' : m ? `Janela de ${m >= 1440 ? `${Math.round(m / 1440)} d` : `${Math.round(m / 60)} h`}` : 'Janela')
    const windows: PlanWindow[] = []
    for (const w of [l?.primary, l?.secondary]) if (w) windows.push({ label: label(w.windowMinutes), percent: w.percent, resetsAt: w.resetsAt })
    const plan = l?.plan ? `ChatGPT ${l.plan.charAt(0).toUpperCase()}${l.plan.slice(1)}` : undefined
    const bal = Number(l?.credits?.balance)
    const credits = l?.credits?.unlimited ? 'Créditos: ilimitados' : l?.credits?.hasCredits && Number.isFinite(bal) ? `Créditos: ${bal.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}` : undefined
    return {
      id: 'codex',
      title: 'Codex (ChatGPT)',
      plan,
      windows,
      readAt: l?.at,
      note: windows.length ? credits : 'Nenhuma leitura ainda: use o Codex uma vez para aparecer aqui.',
    }
  }

  private runScan(): Promise<ScanOutput> {
    this.scanning ??= new Promise<ScanOutput>((resolve, reject) => {
      const input: ScanInput = {
        claudeRoot: join(this.deps.home, '.claude', 'projects'),
        codexRoots: [join(this.deps.home, '.codex', 'sessions'), join(this.deps.home, '.codex', 'archived_sessions')],
        cacheFile: join(this.deps.userData, 'usage', 'scan-cache.json'),
      }
      const w = createScanWorker({ workerData: input })
      w.once('message', (m: { ok: boolean; out?: ScanOutput; error?: string }) => {
        void w.terminate()
        if (m.ok && m.out) resolve(m.out)
        else reject(new Error(m.error ?? 'falha na leitura'))
      })
      w.once('error', reject)
    })
      .then((out) => {
        this.scan = { at: Date.now(), out }
        return out
      })
      .finally(() => {
        this.scanning = null
      })
    return this.scanning
  }

  private async agentSource(period: UsagePeriod): Promise<UsageSource> {
    const entries: Entry[] = []
    try {
      for (const c of await this.deps.conversations()) {
        for (const m of c.messages) {
          if (m.role !== 'assistant' || !m.usage || !m.model) continue
          const cacheRead = m.usage.cacheRead ?? 0
          // Na API da Anthropic a entrada já vem sem o cache; nas compatíveis com OpenAI, inclui.
          const input = m.provider === 'anthropic' ? m.usage.input : Math.max(0, m.usage.input - cacheRead)
          entries.push([`${c.id}:${m.id}`, localDay(m.at), m.model, PROVIDER_LABEL[m.provider ?? ''] ?? m.provider ?? '—', input, 0, 0, cacheRead, m.usage.output])
        }
      }
    } catch {
      // histórico indisponível (Keychain negado): fica vazio
    }
    const src = aggregate('agent', 'Agente do Cockpit', entries, period)
    return { ...src, note: src.note ?? (entries.length ? undefined : 'O agente do Cockpit (✦) ainda não foi usado com um provedor de API.') }
  }

  private async account(id: AdminKeyId, period: UsagePeriod, force: boolean): Promise<AccountUsage> {
    const title = id === 'anthropic-admin' ? 'Anthropic (Console)' : 'OpenAI (Platform)'
    const accountId = id === 'anthropic-admin' ? 'anthropic' : 'openai'
    const key = await this.deps.secrets.get(id)
    if (!key) return { id: accountId, title, configured: false }
    const k = `${id}:${period}`
    const hit = this.admin.get(k)
    if (hit && !force && Date.now() - hit.at < ADMIN_MAX_AGE) return hit.value
    const value = id === 'anthropic-admin' ? await anthropicAccount(key, period, Date.now(), this.deps.adminBase?.anthropic) : await openaiAccount(key, period, Date.now(), this.deps.adminBase?.openai)
    if (!value.error) this.admin.set(k, { at: Date.now(), value })
    return value
  }

  async testAdmin(id: AdminKeyId): Promise<{ ok: boolean; message: string }> {
    const r = await this.account(id, 'today', true)
    if (!r.configured) return { ok: false, message: 'Cole a chave e salve primeiro.' }
    return r.error ? { ok: false, message: r.error } : { ok: true, message: `Conectado. Hoje: US$ ${(r.cost ?? 0).toFixed(2)}.` }
  }

  clearAdminCache(): void {
    this.admin.clear()
  }

  async report(period: UsagePeriod, force = false, secure = false): Promise<UsageReport> {
    let scanError: string | undefined
    let out = this.scan?.out
    if (force || !this.scan || Date.now() - this.scan.at > SCAN_MAX_AGE) {
      try {
        out = await this.runScan()
      } catch (e) {
        scanError = `Não consegui ler os registros locais: ${(e as Error).message}`
      }
    }
    // Sem o clique do usuário, nada que precise do Keychain (histórico do agente, chaves Admin) é lido.
    const locked: AccountUsage = { id: 'anthropic', title: '', configured: false }
    const [agent, anthropic, openai] = secure
      ? await Promise.all([this.agentSource(period), this.account('anthropic-admin', period, force), this.account('openai-admin', period, force)])
      : [aggregate('agent', 'Agente do Cockpit', [], period), { ...locked, title: 'Anthropic (Console)' }, { ...locked, id: 'openai' as const, title: 'OpenAI (Platform)' }]
    const xai: AccountUsage = {
      id: 'xai',
      title: 'xAI (Grok)',
      configured: false,
      note: 'A xAI não publica uma API de relatório de uso para contas comuns: veja o gasto em console.x.ai → Usage. O uso do Grok pelo agente do Cockpit aparece acima.',
    }
    return {
      period,
      plans: [this.claudeCard(), this.codexCard(out?.codexLimits)],
      sessions: out?.sessions[period] ?? [],
      agent,
      accounts: [anthropic, openai, xai],
      updatedAt: Date.now(),
      scanError,
      locked: !secure,
    }
  }
}
