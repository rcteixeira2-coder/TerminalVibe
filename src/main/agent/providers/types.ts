import type { AgentToolCall, AgentUsage } from '@shared/types'
import type { ToolDef } from '../tools'

export interface TurnInput {
  model: string
  system: string
  history: { role: 'user' | 'assistant'; content: string }[]
  tools: ToolDef[]
  signal: AbortSignal
  maxRounds: number
  onText(delta: string): void
  onThinking(delta: string): void
  onTool(call: AgentToolCall): void
  onNotice(text: string): void
  runTool(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; content: string; summary: string }>
}

export interface TurnResult {
  usage: AgentUsage
}

export interface Provider {
  run(input: TurnInput): Promise<TurnResult>
  models(): Promise<string[]>
}

// Erros de API em português, sem vazar a chave.
export function friendlyError(e: unknown, provider: string): string {
  const err = e as { status?: number; name?: string; message?: string; code?: string; cause?: { code?: string } }
  if (err?.name === 'AbortError' || /aborted|abort/i.test(err?.message ?? '')) return 'Interrompido.'
  const code = err?.code ?? err?.cause?.code
  // SDKs embrulham falhas de rede (APIConnectionError, "Connection error.").
  const connection = code === 'ECONNREFUSED' || err?.name === 'APIConnectionError' || /connection error|fetch failed|ECONNREFUSED/i.test(err?.message ?? '')
  if (connection && /local/i.test(provider)) return `${provider} não está aberto (nada respondendo no endereço configurado).`
  if (code === 'ECONNREFUSED') return `${provider} não está respondendo neste endereço. Ele está aberto?`
  if (connection) return `Sem conexão com o ${provider}. Verifique a internet.`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Sem conexão com a internet (ou endereço inválido).'
  switch (err?.status) {
    case 401:
    case 403:
      return `Chave do ${provider} inválida ou sem permissão. Confira em Preferências → Agente.`
    case 402:
      return `Sem crédito na conta do ${provider}.`
    case 404:
      return 'Modelo não encontrado neste provedor. Escolha outro na lista.'
    case 429:
      return `Limite de uso do ${provider} atingido (ou sem crédito). Tente de novo em instantes.`
    default:
      if (err?.status && err.status >= 500) return `O ${provider} está com instabilidade (erro ${err.status}). Tente de novo.`
      return `${provider}: ${(err?.message ?? String(e)).replace(/(sk|xai)-[A-Za-z0-9_-]{8,}/g, '***').slice(0, 300)}`
  }
}

export function parseToolInput(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
