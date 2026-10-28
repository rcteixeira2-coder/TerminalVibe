import type { Activity, Agent, Lifecycle } from '@shared/types'
import { ACTIVITY_COLOR, ACTIVITY_LABEL } from '@shared/status'

export function StatusDot({ activity, lifecycle, size = 8 }: { activity: Activity; lifecycle?: Lifecycle; size?: number }) {
  const dead = lifecycle && lifecycle !== 'running' && lifecycle !== 'stopping'
  const color = dead ? 'var(--muted)' : ACTIVITY_COLOR[activity]
  const pulse = !dead && (activity === 'working' || activity === 'needs_approval')
  return (
    <span
      className={`dot ${pulse ? `pulse pulse-${activity}` : ''}`}
      style={{ width: size, height: size, background: dead ? 'transparent' : color, borderColor: color }}
      title={dead ? 'Parada' : ACTIVITY_LABEL[activity]}
    />
  )
}

export function ActivityBadge({ activity, lifecycle, source }: { activity: Activity; lifecycle: Lifecycle; source?: string }) {
  if (lifecycle === 'stopping') return <span className="badge badge-dead">Encerrando</span>
  if (lifecycle !== 'running') return <span className="badge badge-dead">{lifecycle === 'failed' ? 'Falhou' : 'Parada'}</span>
  if (activity === 'unknown') return null
  return (
    <span className={`badge badge-${activity}`} title={source === 'heuristic' ? 'Estimado pela atividade da tela' : undefined}>
      {ACTIVITY_LABEL[activity]}
      {source === 'heuristic' ? ' ·~' : ''}
    </span>
  )
}

// Estado do painel (cabeçalho das sessões): pílula curta + texto padrão quando o agente não mandou detalhe.
const PILL: Record<Activity, string> = {
  needs_approval: 'APROVAÇÃO', your_turn: 'SUA VEZ', error: 'ERRO', working: 'TRABALHANDO', done: 'TERMINOU', unknown: '',
}
const DEFAULT_TEXT: Partial<Record<Activity, string>> = {
  needs_approval: 'Precisa da sua aprovação', your_turn: 'Esperando você', error: 'Algo deu errado', done: 'Revisar o resultado',
}

export function StatePill({ activity, lifecycle, source }: { activity: Activity; lifecycle: Lifecycle; source?: string }) {
  if (lifecycle === 'stopping') return <span className="state-pill pill-dead">ENCERRANDO</span>
  if (lifecycle !== 'running') return <span className="state-pill pill-dead">{lifecycle === 'failed' ? 'FALHOU' : 'PARADA'}</span>
  if (activity === 'unknown') return null
  return (
    <span className={`state-pill pill-${activity}`} title={source === 'heuristic' ? 'Estimado pela atividade da tela' : ACTIVITY_LABEL[activity]}>
      {activity === 'done' ? '✓ ' : ''}{PILL[activity]}{source === 'heuristic' ? ' ·~' : ''}
    </span>
  )
}

export function stateText(activity: Activity, running: boolean, detail?: string, message?: string): string {
  if (!running) return message ?? ''
  return detail || DEFAULT_TEXT[activity] || ''
}

const AGENT_ICON: Record<Agent, string> = { claude: '✻', codex: '◎', shell: '›_' }

export function AgentIcon({ agent }: { agent: Agent }) {
  return <span className={`agent-icon agent-${agent}`}>{AGENT_ICON[agent]}</span>
}
