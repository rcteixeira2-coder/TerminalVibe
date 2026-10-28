import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type { AgentToolCall } from '@shared/types'
import { friendlyError, parseToolInput, type Provider, type TurnInput, type TurnResult } from './types'

// xAI (Grok), OpenAI, Ollama e LM Studio falam o mesmo protocolo de chat completions.
export class OpenAICompatProvider implements Provider {
  private client: OpenAI

  constructor(private label: string, baseURL: string, apiKey: string | undefined, private local: boolean) {
    this.client = new OpenAI({ apiKey: apiKey || 'local', baseURL, maxRetries: 1, timeout: 120_000 })
  }

  async models(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id)
    return ids.sort()
  }

  async run(input: TurnInput): Promise<TurnResult> {
    const tools: ChatCompletionTool[] = input.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema },
    }))
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: input.system },
      ...input.history.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
    ]
    const usage = { input: 0, output: 0, cacheRead: 0 }
    for (let round = 0; round < input.maxRounds; round++) {
      let text = ''
      const calls = new Map<number, { id: string; name: string; args: string }>()
      try {
        const stream = await this.client.chat.completions.create(
          {
            model: input.model,
            messages,
            tools,
            stream: true,
            ...(this.local ? {} : { stream_options: { include_usage: true } }),
          },
          { signal: input.signal },
        )
        for await (const chunk of stream) {
          if (chunk.usage) {
            usage.input += chunk.usage.prompt_tokens ?? 0
            usage.output += chunk.usage.completion_tokens ?? 0
            usage.cacheRead += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
          }
          const delta = chunk.choices[0]?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string }) | undefined
          if (!delta) continue
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (reasoning) input.onThinking(reasoning)
          if (delta.content) {
            text += delta.content
            input.onText(delta.content)
          }
          for (const tc of delta.tool_calls ?? []) {
            const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            calls.set(tc.index, cur)
          }
        }
      } catch (e) {
        throw new Error(friendlyError(e, this.label))
      }
      const list = [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }))
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(list.length ? { tool_calls: list.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })) } : {}),
      })
      if (!list.length) return { usage }
      // Ferramentas da mesma rodada rodam em paralelo; todas as respostas voltam juntas.
      const results = await Promise.all(
        list.map(async (c) => {
          const args = parseToolInput(c.args)
          const call: AgentToolCall = { id: c.id, name: c.name, summary: c.name }
          if (!args) {
            input.onTool({ ...call, ok: false, summary: `${c.name}: argumentos inválidos` })
            return { id: c.id, content: 'Erro: argumentos JSON inválidos. Tente de novo.' }
          }
          input.onTool(call)
          const r = await input.runTool(c.name, args)
          input.onTool({ ...call, ok: r.ok, summary: r.summary })
          return { id: c.id, content: r.content }
        }),
      )
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
    }
    input.onNotice(`Parei após ${input.maxRounds} rodadas de ferramentas. Peça para continuar se precisar.`)
    return { usage }
  }
}
