import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageParam, BetaTool, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AgentToolCall } from '@shared/types'
import { friendlyError, type Provider, type TurnInput, type TurnResult } from './types'

// Capacidades por modelo (referência claude-api): thinking adaptativo e effort nos modelos atuais;
// fallback de recusa no servidor só em Opus 5.5/5, Fable 5.1 e Sonnet 5.5.
const ADAPTIVE = /^claude-(fable-5|mythos-5|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6|haiku-5)/
const EFFORT = /^claude-(fable-5|mythos-5|opus-5|opus-4-[5-9]|sonnet-5|haiku-5)/
const FALLBACK = /^claude-(opus-5-5|opus-5$|fable-5-1|sonnet-5-5)/

export class AnthropicProvider implements Provider {
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 })
  }

  async models(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id)
    return ids
  }

  async run(input: TurnInput): Promise<TurnResult> {
    const tools: BetaTool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.schema, additionalProperties: false },
      strict: true,
      eager_input_streaming: true,
    }))
    const messages: BetaMessageParam[] = input.history.map((m) => ({ role: m.role, content: m.content }))
    const usage = { input: 0, output: 0, cacheRead: 0 }
    const model = input.model
    for (let round = 0; round < input.maxRounds; round++) {
      let message
      try {
        const stream = this.client.beta.messages.stream(
          {
            model,
            max_tokens: 32000,
            system: [{ type: 'text', text: input.system }],
            tools,
            messages,
            // Cache automático do prefixo estável (system + ferramentas + histórico).
            cache_control: { type: 'ephemeral' },
            ...(ADAPTIVE.test(model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
            ...(EFFORT.test(model) ? { output_config: { effort: 'medium' } } : {}),
            ...(FALLBACK.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
          } as Parameters<typeof this.client.beta.messages.stream>[0],
          { signal: input.signal },
        )
        stream.on('text', (d) => input.onText(d))
        stream.on('thinking', (d) => input.onThinking(d))
        message = await stream.finalMessage()
      } catch (e) {
        throw new Error(friendlyError(e, 'Claude'))
      }
      usage.input += message.usage.input_tokens ?? 0
      usage.output += message.usage.output_tokens ?? 0
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0
      for (const block of message.content) {
        if (block.type === 'fallback') input.onNotice(`${block.from.model} recusou; ${block.to.model} continuou a resposta.`)
      }
      // O histórico guarda o conteúdo completo (inclui blocos de thinking e fallback) para a próxima rodada.
      messages.push({ role: 'assistant', content: message.content })
      if (message.stop_reason === 'refusal') {
        const cat = message.stop_details?.category ? ` (${message.stop_details.category})` : ''
        input.onNotice(`O modelo recusou este pedido${cat}.`)
        return { usage }
      }
      if (message.stop_reason === 'pause_turn') continue
      const uses = message.content.filter((b) => b.type === 'tool_use')
      if (!uses.length) {
        if (message.stop_reason === 'max_tokens') input.onNotice('A resposta atingiu o limite de tamanho.')
        return { usage }
      }
      if (message.stop_reason === 'max_tokens') {
        // Entrada de ferramenta truncada: não executar.
        input.onNotice('A resposta foi cortada no meio de uma chamada de ferramenta. Tente uma pergunta mais específica.')
        return { usage }
      }
      const results: BetaToolResultBlockParam[] = await Promise.all(
        uses.map(async (u) => {
          const call: AgentToolCall = { id: u.id, name: u.name, summary: u.name }
          const args = u.input && typeof u.input === 'object' && !Array.isArray(u.input) ? (u.input as Record<string, unknown>) : null
          if (!args) {
            input.onTool({ ...call, ok: false, summary: `${u.name}: argumentos inválidos` })
            return { type: 'tool_result' as const, tool_use_id: u.id, content: 'Erro: argumentos inválidos.', is_error: true }
          }
          input.onTool(call)
          const r = await input.runTool(u.name, args)
          input.onTool({ ...call, ok: r.ok, summary: r.summary })
          return { type: 'tool_result' as const, tool_use_id: u.id, content: r.content, is_error: !r.ok }
        }),
      )
      // Todas as respostas de ferramenta da rodada vão juntas numa única mensagem.
      messages.push({ role: 'user', content: results })
    }
    input.onNotice(`Parei após ${input.maxRounds} rodadas de ferramentas. Peça para continuar se precisar.`)
    return { usage }
  }
}
