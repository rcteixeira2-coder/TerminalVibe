import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  AgentAttachment, AgentConversation, AgentConversationSummary, AgentEvent, AgentMessage, AgentProviderId, AgentProviderInfo,
  AgentSendRequest, AgentToolCall,
} from '@shared/types'
import { AgentSecrets } from './secrets'
import { AgentHistory } from './history'
import { systemPrompt } from './prompt'
import { runTool, TOOL_DEFS, findFiles } from './tools'
import { AnthropicProvider } from './providers/anthropic'
import { OpenAICompatProvider } from './providers/openaiCompat'
import { ClaudeCodeProvider } from './providers/claudeCode'
import type { McpBridge } from './mcpBridge'
import type { Provider } from './providers/types'

const MAX_ROUNDS = 20
const MAX_ATTACH_BYTES = 120 * 1024

interface ProviderDef {
  id: AgentProviderId
  label: string
  needsKey: boolean
  baseUrl: string
  defaultModel: string
}

export const PROVIDERS: ProviderDef[] = [
  // Assinatura do Claude (Pro/Max) via Claude Code instalado: sem chave, sem endereço.
  { id: 'claudecode', label: 'Claude (assinatura)', needsKey: false, baseUrl: '', defaultModel: 'opus' },
  { id: 'xai', label: 'Grok (xAI)', needsKey: true, baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.7' },
  { id: 'anthropic', label: 'Claude (API)', needsKey: true, baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-opus-5-5' },
  { id: 'openai', label: 'OpenAI (API)', needsKey: true, baseUrl: 'https://api.openai.com/v1', defaultModel: '' },
  { id: 'ollama', label: 'Ollama (local)', needsKey: false, baseUrl: 'http://localhost:11434/v1', defaultModel: '' },
  { id: 'lmstudio', label: 'LM Studio (local)', needsKey: false, baseUrl: 'http://localhost:1234/v1', defaultModel: '' },
]

interface Settings {
  baseUrls: Partial<Record<AgentProviderId, string>>
  lastModel: Partial<Record<AgentProviderId, string>>
  lastProvider?: AgentProviderId
}

export interface AgentDeps {
  userData: string
  projectRoot(projectId: string): string | null
  projectName(projectId: string): string
  sessions(projectId: string): { id: string; title: string; agent: string }[]
  tail(sessionId: string, lines: number): string
  emit(ev: AgentEvent): void
  // Claude Code do usuário (provedor "assinatura"): executável e ambiente limpo, montados pelo main.
  claudeCode: { binary(): string | null; env(): Record<string, string> }
  // Servidor MCP local compartilhado (também serve o navegador às sessões do Claude).
  bridge: McpBridge
  // Testes apontam o provedor para um servidor local falso.
  baseUrlOverride?: Partial<Record<AgentProviderId, string>>
}

export class AgentManager {
  readonly secrets: AgentSecrets
  private history: AgentHistory
  private settingsFile: string
  private settings: Settings = { baseUrls: {}, lastModel: {} }
  private running = new Map<string, AbortController>()
  // Ações do agente esperando o clique do usuário.
  private pending = new Map<string, { conversationId: string; resolve(ok: boolean): void }>()

  constructor(private deps: AgentDeps) {
    this.secrets = new AgentSecrets(deps.userData)
    this.history = new AgentHistory(deps.userData)
    this.settingsFile = join(deps.userData, 'agent', 'settings.json')
    try {
      if (existsSync(this.settingsFile)) this.settings = { ...this.settings, ...JSON.parse(readFileSync(this.settingsFile, 'utf8')) }
    } catch {
      // padrão
    }
  }

  private saveSettings(): void {
    mkdirSync(join(this.deps.userData, 'agent'), { recursive: true, mode: 0o700 })
    const tmp = `${this.settingsFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 })
    renameSync(tmp, this.settingsFile)
  }

  private baseUrl(id: AgentProviderId): string {
    return this.deps.baseUrlOverride?.[id] ?? this.settings.baseUrls[id] ?? PROVIDERS.find((p) => p.id === id)!.baseUrl
  }

  async providers(): Promise<{ providers: AgentProviderInfo[]; lastProvider?: AgentProviderId; encryption: boolean }> {
    const providers: AgentProviderInfo[] = []
    for (const p of PROVIDERS) {
      providers.push({
        id: p.id, label: p.label, needsKey: p.needsKey,
        configured: p.id === 'claudecode' ? !!this.deps.claudeCode.binary() : !p.needsKey || (await this.secrets.has(p.id)),
        baseUrl: this.baseUrl(p.id), defaultModel: p.defaultModel, lastModel: this.settings.lastModel[p.id],
      })
    }
    // Sem chaves salvas, não abre o Keychain só para responder; salvar uma chave avisa se falhar.
    return { providers, lastProvider: this.settings.lastProvider, encryption: this.secrets.stored() ? await this.secrets.available() : true }
  }

  async setKey(id: AgentProviderId, key: string | null): Promise<void> {
    if (!PROVIDERS.some((p) => p.id === id && p.needsKey)) throw new Error('Provedor inválido.')
    await this.secrets.set(id, key)
  }

  setBaseUrl(id: AgentProviderId, url: string | null): void {
    const def = PROVIDERS.find((p) => p.id === id)
    if (!def || def.needsKey || id === 'claudecode') throw new Error('Só provedores locais aceitam outro endereço.')
    if (url) {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Endereço inválido.')
      this.settings.baseUrls[id] = u.toString().replace(/\/$/, '')
    } else delete this.settings.baseUrls[id]
    this.saveSettings()
  }

  private async provider(id: AgentProviderId): Promise<Provider> {
    const def = PROVIDERS.find((p) => p.id === id)
    if (!def) throw new Error('Provedor desconhecido.')
    if (id === 'claudecode') return this.claudeCode()
    const key = await this.secrets.get(id)
    if (def.needsKey && !key) throw new Error(`Configure a chave do ${def.label} em Preferências → Agente.`)
    if (id === 'anthropic') return new AnthropicProvider(key!)
    return new OpenAICompatProvider(def.label, this.baseUrl(id), key, !def.needsKey)
  }

  async models(id: AgentProviderId): Promise<{ models: string[] } | { error: string }> {
    try {
      const list = await (await this.provider(id)).models()
      return { models: list }
    } catch (e) {
      const { friendlyError } = await import('./providers/types')
      return { error: friendlyError(e, PROVIDERS.find((p) => p.id === id)?.label ?? id) }
    }
  }

  private claudeCode(): ClaudeCodeProvider {
    return new ClaudeCodeProvider({ ...this.deps.claudeCode, bridge: this.deps.bridge })
  }

  async test(id: AgentProviderId): Promise<{ ok: boolean; message: string }> {
    if (id === 'claudecode') return this.claudeCode().status()
    const r = await this.models(id)
    if ('error' in r) return { ok: false, message: r.error }
    return { ok: true, message: `Conectado: ${r.models.length} modelo(s) disponíveis.` }
  }

  // Para o painel de uso: todas as conversas (só `usage`, provedor, modelo e data são lidos).
  allConversations(): Promise<AgentConversation[]> {
    return this.history.everything()
  }

  conversations(projectId: string): Promise<AgentConversationSummary[]> {
    return this.history.list(projectId)
  }

  async load(projectId: string, id: string): Promise<AgentConversation | null> {
    return (await this.history.get(projectId, id)) ?? null
  }

  delete(projectId: string, id: string | null): Promise<void> {
    return this.history.delete(projectId, id)
  }

  findFiles(projectId: string, query: string): Promise<string[]> {
    const root = this.deps.projectRoot(projectId)
    return root ? findFiles(root, query) : Promise.resolve([])
  }

  stop(conversationId: string): void {
    this.running.get(conversationId)?.abort()
    for (const [id, p] of this.pending) if (p.conversationId === conversationId) this.approve(id, false)
  }

  approve(id: string, ok: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(ok)
  }

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  // Inicia a resposta e devolve os ids na hora; o conteúdo chega por eventos 'agent:event'.
  async send(req: AgentSendRequest): Promise<{ conversationId: string; messageId: string } | { error: string }> {
    const root = this.deps.projectRoot(req.projectId)
    if (!root) return { error: 'Projeto indisponível.' }
    if (!PROVIDERS.some((p) => p.id === req.provider)) return { error: 'Provedor inválido.' }
    const text = typeof req.text === 'string' ? req.text.trim().slice(0, 50_000) : ''
    if (!text) return { error: 'Mensagem vazia.' }
    const model = typeof req.model === 'string' && req.model.trim() ? req.model.trim().slice(0, 120) : PROVIDERS.find((p) => p.id === req.provider)!.defaultModel
    if (!model) return { error: 'Escolha um modelo.' }
    let provider: Provider
    try {
      provider = await this.provider(req.provider)
    } catch (e) {
      return { error: (e as Error).message }
    }
    const now = Date.now()
    let conv = req.conversationId ? await this.history.get(req.projectId, req.conversationId) : undefined
    if (conv && this.running.has(conv.id)) return { error: 'Espere a resposta atual terminar (ou pare).' }
    if (!conv) {
      conv = { id: randomUUID(), projectId: req.projectId, title: text.split('\n')[0].slice(0, 60), createdAt: now, updatedAt: now, messages: [] }
    }
    const attachments = (req.attachments ?? []).slice(0, 8)
    const prompt = await this.expandAttachments(req.projectId, root, text, attachments)
    const user: AgentMessage = { id: randomUUID(), role: 'user', text, prompt, attachments, at: now }
    const assistant: AgentMessage = { id: randomUUID(), role: 'assistant', text: '', thinking: '', tools: [], provider: req.provider, model, at: now }
    // Histórico só com texto (independe do provedor: dá para trocar de modelo no meio da conversa).
    const history = [...conv.messages, user]
      .filter((m) => (m.role === 'user' ? m.prompt ?? m.text : m.text))
      .map((m) => ({ role: m.role, content: m.role === 'user' ? (m.prompt ?? m.text) : m.text }))
    conv.messages.push(user)
    conv.updatedAt = now
    await this.history.put(conv)
    this.settings.lastProvider = req.provider
    this.settings.lastModel[req.provider] = model
    this.saveSettings()
    const controller = new AbortController()
    this.running.set(conv.id, controller)
    const base = { projectId: req.projectId, conversationId: conv.id, messageId: assistant.id }
    this.deps.emit({ type: 'start', ...base, user, title: conv.title })
    const convRef = conv
    const tools = new Map<string, AgentToolCall>()
    void (async () => {
      try {
        const r = await provider.run({
          model,
          system: systemPrompt(this.deps.projectName(req.projectId), root),
          history,
          tools: TOOL_DEFS,
          signal: controller.signal,
          maxRounds: MAX_ROUNDS,
          onText: (d) => {
            assistant.text += d
            this.deps.emit({ type: 'text', ...base, delta: d })
          },
          onThinking: (d) => {
            assistant.thinking += d
            this.deps.emit({ type: 'thinking', ...base, delta: d })
          },
          onTool: (call) => {
            tools.set(call.id, { ...tools.get(call.id), ...call })
            assistant.tools = [...tools.values()]
            this.deps.emit({ type: 'tool', ...base, call: tools.get(call.id)! })
          },
          onNotice: (t) => {
            assistant.notice = assistant.notice ? `${assistant.notice}\n${t}` : t
            this.deps.emit({ type: 'notice', ...base, text: t })
          },
          runTool: (name, input) =>
            runTool({ root, sessions: () => this.deps.sessions(req.projectId), tail: (id, n) => this.deps.tail(id, n) }, name, input),
        })
        assistant.usage = r.usage
      } catch (e) {
        assistant.error = (e as Error).message
      } finally {
        this.running.delete(convRef.id)
        for (const [id, p] of this.pending) if (p.conversationId === convRef.id) this.approve(id, false)
        if (!assistant.thinking) delete assistant.thinking
        convRef.messages.push(assistant)
        convRef.updatedAt = Date.now()
        await this.history.put(convRef).catch(() => {})
        this.deps.emit({ type: 'done', ...base, message: assistant })
      }
    })()
    return { conversationId: base.conversationId, messageId: base.messageId }
  }

  private async expandAttachments(projectId: string, root: string, text: string, list: AgentAttachment[]): Promise<string> {
    if (!list.length) return text
    const parts: string[] = []
    for (const a of list) {
      if (a.kind === 'file' && a.path && root) {
        const r = await runTool({ root, sessions: () => [], tail: () => '' }, 'read_file', { path: a.path })
        parts.push(`<arquivo caminho="${a.path}">\n${r.content.slice(0, MAX_ATTACH_BYTES)}\n</arquivo>`)
      } else if (a.kind === 'terminal' && a.sessionId) {
        const s = this.deps.sessions(projectId).find((x) => x.id === a.sessionId)
        if (s) parts.push(`<terminal titulo="${s.title}">\n${this.deps.tail(s.id, 150).slice(-MAX_ATTACH_BYTES)}\n</terminal>`)
      }
    }
    return parts.length ? `${parts.join('\n\n')}\n\n${text}` : text
  }
}

export function projectLabel(path: string): string {
  return basename(path)
}
