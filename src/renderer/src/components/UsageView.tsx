import { useEffect, useState } from 'react'
import type { AccountUsage, PlanCard, TokenTotals, UsageDay, UsagePeriod, UsageReport, UsageRow, UsageSource } from '@shared/types'
import { actions, useStore } from '../state/store'
import { useModal } from './useModal'

type Tab = 'plans' | 'sessions' | 'api'

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${nf.format(n / 1e9)} bi`
  if (n >= 1e6) return `${nf.format(n / 1e6)} mi`
  if (n >= 1e3) return `${nf.format(n / 1e3)} mil`
  return String(Math.round(n))
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function until(t?: number, now = Date.now()): string {
  if (!t) return ''
  const m = Math.max(0, Math.round((t - now) / 60_000))
  if (m < 60) return `${m} min`
  if (m < 24 * 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

function ago(t?: number): string {
  if (!t) return 'nunca lido'
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'lido agora' : m < 60 ? `lido há ${m} min` : m < 1440 ? `lido há ${Math.round(m / 60)} h` : `lido há ${Math.round(m / 1440)} d`
}

export function level(p: number): string {
  return p >= 90 ? 'hot' : p >= 70 ? 'warm' : 'ok'
}

export function UsageView() {
  const [period, setPeriod] = useState<UsagePeriod>('7d')
  const [tab, setTab] = useState<Tab>('plans')
  const [report, setReport] = useState<UsageReport | null>(null)
  const [busy, setBusy] = useState(false)
  // Agente e contas pedem o Keychain: só depois do clique (ou se as chaves já foram abertas nesta sessão).
  const keysOpen = useStore((s) => s.agentConfig.loaded)
  const [secure, setSecure] = useState(!!keysOpen)
  const close = () => actions.set({ overlay: null })
  const dialog = useModal<HTMLDivElement>(close)
  const load = async (force = false) => {
    setBusy(true)
    try {
      setReport(await window.cockpit.invoke('usage:report', period, force, secure))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, secure])

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="sheet usage-sheet" ref={dialog} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Uso dos modelos</h2>
          <div className="seg usage-period">
            {(['today', '7d', '30d'] as UsagePeriod[]).map((p) => (
              <button key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{p === 'today' ? 'Hoje' : p === '7d' ? '7 dias' : '30 dias'}</button>
            ))}
          </div>
          <span className="spacer" />
          <button className="ghost-btn small" disabled={busy} onClick={() => void load(true)}>{busy ? 'Lendo…' : '↻ Atualizar'}</button>
          <button className="icon-btn" onClick={close}>×</button>
        </div>
        <div className="usage-tabs">
          {([['plans', 'Planos'], ['sessions', 'Sessões'], ['api', 'API']] as [Tab, string][]).map(([t, l]) => (
            <button key={t} className={`dock-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
        {!report ? (
          <div className="dd-empty">Lendo os registros do Claude Code e do Codex…</div>
        ) : (
          <div className="usage-body">
            {report.scanError && <div className="error small">{report.scanError}</div>}
            {tab === 'plans' && <Plans plans={report.plans} />}
            {tab === 'sessions' && (
              <>
                <p className="muted small">
                  Tokens das suas sessões, lidos dos registros locais do Claude Code e do Codex. O valor em US$ é o <b>equivalente em API</b> (estimativa):
                  a assinatura não cobra por token.
                </p>
                {report.sessions.map((s) => <Source key={s.id} s={s} />)}
              </>
            )}
            {tab === 'api' && (
              report.locked ? (
                <div className="usage-locked">
                  <p>O uso do agente do Cockpit e o da conta inteira (chaves Admin) ficam guardados com o Keychain do Mac.</p>
                  <p className="muted small">O macOS pode pedir a senha ("Cockpit Safe Storage").</p>
                  <button className="ghost-btn small send" onClick={() => setSecure(true)}>Carregar uso da API</button>
                </div>
              ) : (
                <>
                  <Source s={report.agent} />
                  <h3 className="usage-h3">Conta inteira</h3>
                  <div className="usage-accounts">
                    {report.accounts.map((a) => <Account key={a.id} a={a} />)}
                  </div>
                </>
              )
            )}
            <div className="muted small usage-foot">Atualizado {new Date(report.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function Plans({ plans }: { plans: PlanCard[] }) {
  return (
    <div className="usage-cards">
      {plans.map((p) => (
        <div key={p.id} className="usage-card">
          <div className="usage-card-head">
            <b>{p.title}</b>
            {p.plan && <span className="badge">{p.plan}</span>}
            <span className="spacer" />
            <span className="muted small">{ago(p.readAt)}</span>
          </div>
          {p.windows.map((w) => (
            <div key={w.label} className="usage-window">
              <div className="row">
                <span>{w.label}</span>
                <span className="spacer" />
                <b className={`usage-pct ${level(w.percent)}`}>{nf.format(w.percent)}%</b>
              </div>
              <div className="usage-bar"><i className={level(w.percent)} style={{ width: `${Math.min(100, w.percent)}%` }} /></div>
              {w.resetsAt && <div className="muted small">{w.resetsAt > Date.now() ? `renova em ${until(w.resetsAt)}` : 'já renovou — atualiza na próxima resposta'}</div>}
            </div>
          ))}
          {p.note && <div className="muted small">{p.note}</div>}
        </div>
      ))}
    </div>
  )
}

const tokenSum = (t: TokenTotals) => t.input + t.cacheWrite + t.cacheRead + t.output

function Source({ s }: { s: UsageSource }) {
  const [by, setBy] = useState<'model' | 'project'>('model')
  const priced = s.totals.cost !== null && s.totals.cost > 0
  return (
    <section className="usage-source">
      <div className="usage-source-head">
        <h3>{s.title}</h3>
        <span className="spacer" />
        <span className="usage-total">{fmtTokens(tokenSum(s.totals))} tokens</span>
        {priced && <span className="usage-cost" title="Equivalente em API (estimativa)">{fmtUsd(s.totals.cost)}</span>}
      </div>
      <div className="usage-split muted small">
        entrada {fmtTokens(s.totals.input)} · escrita de cache {fmtTokens(s.totals.cacheWrite)} · leitura de cache {fmtTokens(s.totals.cacheRead)} · saída {fmtTokens(s.totals.output)}
      </div>
      {s.days.length > 1 && <Chart days={s.days} money={priced} />}
      {(s.byModel.length > 0 || s.byProject.length > 0) && (
        <>
          <div className="seg usage-by">
            <button className={by === 'model' ? 'on' : ''} onClick={() => setBy('model')}>Por modelo</button>
            <button className={by === 'project' ? 'on' : ''} onClick={() => setBy('project')}>{s.id === 'agent' ? 'Por provedor' : 'Por projeto'}</button>
          </div>
          <Table rows={(by === 'model' ? s.byModel : s.byProject).slice(0, 10)} />
        </>
      )}
      {!tokenSum(s.totals) && !s.note && <div className="muted small">Nada usado neste período.</div>}
      {s.note && <div className="muted small">{s.note}</div>}
    </section>
  )
}

// Barras por dia: custo (quando há preço) ou tokens sem a leitura de cache (que domina e esconde o resto).
function Chart({ days, money }: { days: UsageDay[]; money: boolean }) {
  const value = (d: UsageDay) => (money ? (d.cost ?? 0) : d.input + d.cacheWrite + d.output)
  const max = Math.max(...days.map(value), 0)
  const W = 640
  const H = 90
  const gap = days.length > 20 ? 2 : 4
  const bw = (W - gap * (days.length - 1)) / days.length
  return (
    <div className="usage-chart">
      <svg viewBox={`0 0 ${W} ${H + 16}`} preserveAspectRatio="none" role="img" aria-label="Uso por dia">
        {days.map((d, i) => {
          const v = value(d)
          const h = max ? Math.max(v ? 2 : 0, (v / max) * H) : 0
          const x = i * (bw + gap)
          return (
            <g key={d.day}>
              <rect x={x} y={H - h} width={bw} height={h} rx={2}>
                <title>{`${d.day.split('-').reverse().slice(0, 2).join('/')}: ${money ? fmtUsd(v) : `${fmtTokens(v)} tokens`}`}</title>
              </rect>
              {(days.length <= 8 || i % Math.ceil(days.length / 8) === 0) && (
                <text x={x + bw / 2} y={H + 12} textAnchor="middle">{d.day.slice(8)}/{d.day.slice(5, 7)}</text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="muted small">{money ? 'Equivalente em API por dia' : 'Tokens por dia (sem leitura de cache)'} · máx. {money ? fmtUsd(max) : fmtTokens(max)}</div>
    </div>
  )
}

function Table({ rows }: { rows: UsageRow[] }) {
  return (
    <table className="usage-table">
      <thead>
        <tr><th>Nome</th><th>Entrada</th><th>Cache (escr./leit.)</th><th>Saída</th><th>US$</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td title={r.label}>{r.label}</td>
            <td>{fmtTokens(r.input)}</td>
            <td>{fmtTokens(r.cacheWrite)} / {fmtTokens(r.cacheRead)}</td>
            <td>{fmtTokens(r.output)}</td>
            <td>{fmtUsd(r.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Account({ a }: { a: AccountUsage }) {
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <b>{a.title}</b>
        <span className="spacer" />
        {a.configured && !a.error && <span className="usage-cost">{fmtUsd(a.cost ?? 0)}</span>}
      </div>
      {a.error && <div className="error small">{a.error}</div>}
      {a.configured && !a.error && (
        <>
          {a.tokens && <div className="muted small">entrada {fmtTokens(a.tokens.input)} · cache {fmtTokens(a.tokens.cacheRead)} · saída {fmtTokens(a.tokens.output)}</div>}
          {a.byItem?.slice(0, 6).map((i) => (
            <div key={i.label} className="row small"><span className="usage-item">{i.label}</span><span className="spacer" /><span>{fmtUsd(i.cost)}</span></div>
          ))}
          {!a.byItem?.length && <div className="muted small">Sem gasto neste período.</div>}
        </>
      )}
      {!a.configured && a.id !== 'xai' && (
        <div className="row">
          <span className="muted small">Cole a chave Admin (só leitura de uso) nas Preferências.</span>
          <span className="spacer" />
          <button className="ghost-btn small" onClick={() => actions.set({ overlay: 'prefs' })}>Configurar</button>
        </div>
      )}
      {a.note && <div className="muted small">{a.note}</div>}
    </div>
  )
}
