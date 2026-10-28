import type { Activity } from './types'

// Ordem de urgência para selos agregados (projeto, Dock, grade).
export const URGENCY: Record<Activity, number> = {
  needs_approval: 5,
  error: 4,
  your_turn: 3,
  working: 2,
  done: 1,
  unknown: 0,
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  needs_approval: 'Precisa de aprovação',
  error: 'Erro',
  your_turn: 'Sua vez',
  working: 'Trabalhando',
  done: 'Terminou',
  unknown: '—',
}

export const ACTIVITY_COLOR: Record<Activity, string> = {
  needs_approval: '#ff9e3b',
  error: '#f7768e',
  your_turn: '#e0af68',
  working: '#7aa2f7',
  done: '#9ece6a',
  unknown: '#565f89',
}

export function mostUrgent(list: Activity[]): Activity {
  let best: Activity = 'unknown'
  for (const a of list) if (URGENCY[a] > URGENCY[best]) best = a
  return best
}

export function needsMe(a: Activity): boolean {
  return a === 'needs_approval' || a === 'your_turn' || a === 'error'
}

// ---- Camada A: OSC 7501 (program status do Claude Code) ----

export interface ProgramStatus {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'clear' | string
  app?: string
  id?: string
  kind?: string
  progress?: number
  title?: string
  msg?: string
}

const decodeB64 = (v: string): string => {
  try {
    return typeof Buffer !== 'undefined' ? Buffer.from(v, 'base64').toString('utf8') : atob(v)
  } catch {
    return ''
  }
}

// Formato observado: `state=working:app=claude-code[:id=…][:kind=…][:progress=N][:title=<b64>][:msg=<b64>]`
export function parseProgramStatus(data: string): ProgramStatus | null {
  if (!data || data.startsWith('?')) return null
  const out: Record<string, string> = {}
  for (const part of data.split(':')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  if (!out.state) return null
  const status: ProgramStatus = { state: out.state }
  if (out.app) status.app = out.app
  if (out.id) status.id = out.id
  if (out.kind) status.kind = out.kind
  if (out.progress && /^\d+$/.test(out.progress)) status.progress = Number(out.progress)
  if (out.title) status.title = decodeB64(out.title).slice(0, 200)
  if (out.msg) status.msg = decodeB64(out.msg).slice(0, 2000)
  return status
}

// Mapeia o status do programa para a atividade. Entradas com `id` são tarefas em segundo plano: ignoradas
// para o estado principal (só a sessão em si importa para "de quem é a vez").
// `idle`/`done` não dizem se o Claude perguntou algo: quem decide é `resolveIdle`, com o estado anterior.
export function activityFromProgramStatus(s: ProgramStatus): Activity | 'clear' | 'idle' | null {
  if (s.id) return null
  switch (s.state) {
    case 'working':
      return 'working'
    case 'blocked':
      // Sem `kind` = um diálogo qualquer aberto (pesquisa, aviso, /config): não é pergunta, mantém o estado.
      if (s.kind === 'permission') return 'needs_approval'
      return s.kind === 'question' || s.kind === 'auth' ? 'your_turn' : null
    case 'done':
    case 'idle':
      return 'idle'
    case 'error':
      return 'error'
    case 'clear':
      return 'clear'
    default:
      return null
  }
}

// ---- Camada B: hooks do Claude Code ----

export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  tool_name?: string
  notification_type?: string
  message?: string
  background_tasks?: unknown[]
  error?: unknown
  source?: string
  reason?: string
  [k: string]: unknown
}

export interface HookActivity {
  activity?: Activity | 'idle'
  detail?: string
  ended?: boolean
}

// Avisos do Claude Code chegam em inglês: os conhecidos viram pt-BR, o resto passa igual.
export function ptDetail(message: string): string {
  const m = message.trim()
  if (/^Claude is waiting for your input\.?$/i.test(m)) return 'Esperando você'
  const perm = /^Claude needs your permission to use (.+?)\.?$/i.exec(m)
  if (perm) return `Pede permissão para usar ${perm[1]}`
  return m
}

// Textos herdados do DevRemote.swift (Hermes) para avisos de "sua vez".
export function activityFromHook(p: HookPayload): HookActivity {
  const ev = p.hook_event_name
  switch (ev) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { activity: 'working' }
    case 'PreToolUse':
      if (p.tool_name === 'AskUserQuestion') return { activity: 'your_turn', detail: 'O Claude tem uma pergunta para você' }
      if (p.tool_name === 'ExitPlanMode') return { activity: 'your_turn', detail: 'Plano pronto para revisão' }
      return { activity: 'working' }
    case 'PermissionRequest':
      return { activity: 'needs_approval', detail: p.tool_name ? `Permissão: ${p.tool_name}` : 'Pedido de permissão' }
    case 'Notification': {
      const t = p.notification_type
      if (t === 'permission_prompt') return { activity: 'needs_approval', detail: ptDetail(str(p.message)) || 'Pedido de permissão' }
      if (t === 'idle_prompt') return { activity: 'idle' }
      if (t === 'agent_needs_input' || t === 'elicitation_dialog')
        return { activity: 'your_turn', detail: ptDetail(str(p.message)) || 'Aguardando você' }
      return {}
    }
    case 'Stop': {
      const bg = Array.isArray(p.background_tasks) ? p.background_tasks.length : 0
      if (bg > 0) return { activity: 'working', detail: `${bg} em segundo plano` }
      return endsWithQuestion(typeof p.last_assistant_message === 'string' ? p.last_assistant_message.slice(-20000) : '')
        ? { activity: 'your_turn', detail: 'O Claude te fez uma pergunta' }
        : { activity: 'done' }
    }
    case 'StopFailure':
      return { activity: 'error', detail: str(p.error) || 'A resposta falhou' }
    case 'SessionEnd':
      return { ended: true }
    default:
      return {}
  }
}

// "Parado" depois de trabalhar = terminou. Não apaga Terminou/Sua vez/erro.
// Aba nova parada e aprovação pendente que vira "parado" (ex.: Esc no pedido) = sua vez.
export function resolveIdle(prev: Activity): Activity {
  if (prev === 'working') return 'done'
  if (prev === 'needs_approval' || prev === 'unknown') return 'your_turn'
  return prev
}

// Mesma regra do mod atividade-agora: o último parágrafo antes do bloco de resumo termina perguntando algo.
export function endsWithQuestion(text: string): boolean {
  const corpo = text.split(/^-{3,}\s*$\s*TOPICO\s*:/im)[0] ?? text
  const paragrafos = corpo.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
  const ultimo = paragrafos[paragrafos.length - 1] ?? ''
  return /\?/.test(ultimo.split('\n').slice(-2).join(' '))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 300) : ''
}
