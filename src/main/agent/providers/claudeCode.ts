import { execFile, spawn } from 'node:child_process'
import type { McpBridge } from '../mcpBridge'
import type { Provider, TurnInput, TurnResult } from './types'

// "Claude (assinatura)": roda o Claude Code do usuário em modo headless (`claude -p`), com o login dele
// (Pro/Max), sem chave de API. Sem as ferramentas próprias do Claude Code, sem hooks/plugins/CLAUDE.md
// do usuário (--setting-sources ""): ele só enxerga as ferramentas do Cockpit, servidas pela McpBridge.

export const CLAUDE_CODE_MODELS = ['opus', 'sonnet', 'haiku']
// Aprovações podem levar minutos: o Claude Code espera a ferramenta até 30 min.
const TOOL_TIMEOUT_MS = 30 * 60 * 1000
const MAX_PROMPT_TURNS = 40

export interface ClaudeCodeDeps {
  binary(): string | null
  env(): Record<string, string>
  bridge: McpBridge
}

// Histórico dos outros provedores é só texto: vira uma transcrição antes da mensagem atual.
export function transcriptPrompt(history: TurnInput['history']): string {
  const last = history[history.length - 1]
  const before = history.slice(0, -1).slice(-MAX_PROMPT_TURNS)
  if (!before.length) return last?.content ?? ''
  const lines = before.map((m) => `<${m.role === 'user' ? 'usuario' : 'assistente'}>\n${m.content}\n</${m.role === 'user' ? 'usuario' : 'assistente'}>`)
  return `Conversa até agora:\n${lines.join('\n')}\n\nMensagem atual do usuário:\n${last?.content ?? ''}`
}

export function friendlyClaudeCodeError(text: string): string {
  if (/not logged in|log ?in|authenticat|oauth|401|invalid api key/i.test(text)) return 'O Claude Code não está logado neste Mac. Abra uma sessão do Claude, rode /login e tente de novo.'
  if (/rate limit|usage limit|limit reached|429/i.test(text)) return 'Limite de uso da sua assinatura do Claude atingido. Tente de novo mais tarde (ou escolha outro modelo).'
  if (/overloaded|529|5\d\d/i.test(text)) return 'O Claude está com instabilidade agora. Tente de novo em instantes.'
  return `Claude Code: ${text.trim().slice(0, 300) || 'terminou sem resposta.'}`
}

export class ClaudeCodeProvider implements Provider {
  constructor(private deps: ClaudeCodeDeps) {}

  // Botão Testar: login e plano, sem gastar uso da assinatura.
  async status(): Promise<{ ok: boolean; message: string }> {
    const file = this.deps.binary()
    if (!file) return { ok: false, message: 'Não encontrei o Claude Code neste Mac.' }
    const env = this.deps.env()
    const out = await new Promise<string>((resolve) =>
      execFile(file, ['auth', 'status'], { env, cwd: env.HOME, timeout: 15_000 }, (_e, stdout) => resolve(String(stdout ?? ''))),
    )
    try {
      const s = JSON.parse(out) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string }
      if (!s.loggedIn) return { ok: false, message: 'O Claude Code não está logado. Abra uma sessão do Claude e rode /login.' }
      return { ok: true, message: `Conectado pela sua assinatura${s.subscriptionType ? ` (${s.subscriptionType})` : ''}.` }
    } catch {
      return { ok: false, message: 'Não consegui ler o login do Claude Code. Ele está atualizado?' }
    }
  }

  async models(): Promise<string[]> {
    if (!this.deps.binary()) throw new Error('Não encontrei o Claude Code neste Mac. Instale e faça login para usar a assinatura.')
    return CLAUDE_CODE_MODELS
  }

  async run(input: TurnInput): Promise<TurnResult> {
    const file = this.deps.binary()
    if (!file) throw new Error('Não encontrei o Claude Code neste Mac. Instale e faça login para usar a assinatura.')
    const usage = { input: 0, output: 0, cacheRead: 0 }
    const bridge = await this.deps.bridge.register({ tools: input.tools, runTool: input.runTool, onTool: input.onTool })
    try {
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', bridge.config,
        '--allowedTools', 'mcp__cockpit', '--no-session-persistence', '--disable-slash-commands',
        '--model', input.model,
        '--system-prompt', `${input.system}\nSuas ferramentas aparecem com o prefixo mcp__cockpit__ (ex.: mcp__cockpit__read_file).`,
      ]
      const env: Record<string, string> = { ...this.deps.env(), MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS) }
      const child = spawn(file, args, { env, cwd: env.HOME, stdio: ['pipe', 'pipe', 'pipe'] })
      const abort = () => child.kill('SIGTERM')
      if (input.signal.aborted) abort()
      input.signal.addEventListener('abort', abort, { once: true })
      child.stdin.on('error', () => {})
      child.stdin.end(transcriptPrompt(input.history))

      let stderr = ''
      let pending = ''
      let resultError: string | null = null
      let gotResult = false
      let wroteText = false
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 8000) stderr += d.toString()
      })
      const onLine = (line: string) => {
        if (!line.trim()) return
        let ev: Record<string, any>
        try {
          ev = JSON.parse(line)
        } catch {
          return
        }
        if (ev.type === 'stream_event') {
          const e = ev.event
          if (e?.type === 'content_block_start' && e.content_block?.type === 'text' && wroteText) {
            // Texto novo depois de usar ferramentas: separa do trecho anterior.
            input.onText('\n\n')
          } else if (e?.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta' && e.delta.text) {
              wroteText = true
              input.onText(e.delta.text)
            } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) input.onThinking(e.delta.thinking)
          }
        } else if (ev.type === 'result') {
          gotResult = true
          const u = ev.usage ?? {}
          usage.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
          usage.output = u.output_tokens ?? 0
          usage.cacheRead = u.cache_read_input_tokens ?? 0
          if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) resultError = String(ev.result ?? ev.subtype ?? 'erro')
        }
      }
      child.stdout.on('data', (d: Buffer) => {
        pending += d.toString()
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          onLine(pending.slice(0, nl))
          pending = pending.slice(nl + 1)
        }
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (c) => resolve(c))
      })
      input.signal.removeEventListener('abort', abort)
      if (pending) onLine(pending)
      if (input.signal.aborted) throw new Error('Interrompido.')
      if (resultError) throw new Error(friendlyClaudeCodeError(resultError))
      if (code !== 0 || !gotResult) throw new Error(friendlyClaudeCodeError(stderr || `saiu com código ${code}`))
      // O laço de ferramentas (e o limite de rodadas) fica com o próprio Claude Code.
      return { usage }
    } finally {
      bridge.dispose()
    }
  }
}
