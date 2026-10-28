export type Agent = 'claude' | 'codex' | 'shell'

export const AGENTS: Agent[] = ['claude', 'codex', 'shell']

export const AGENT_LABEL: Record<Agent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  shell: 'Terminal',
}

// Ciclo de vida do processo (igual ao DevSessionState do Hermes).
export type Lifecycle = 'idle' | 'running' | 'stopping' | 'exited' | 'interrupted' | 'failed'

// O que a sessão precisa de você. Vem das camadas de status (OSC 7501, hooks, heurística).
export type Activity = 'unknown' | 'working' | 'needs_approval' | 'your_turn' | 'done' | 'error'

export type ProjectSource = 'desktop' | 'added'

export interface Project {
  id: string // caminho canônico
  name: string
  path: string
  source: ProjectSource
  favorite: boolean
  color: string
  lastAgent?: Agent
  // Onde o ▶ Rodar abre servidores e páginas: browser lateral (padrão) ou navegador padrão do Mac.
  openIn?: OpenIn
  // Divisão da barra lateral criada pelo usuário (SidebarGroup.id).
  group?: string
  missing?: boolean
}

export interface SidebarGroup {
  id: string
  name: string
}

export type OpenIn = 'cockpit' | 'external'

export interface SessionInfo {
  id: string // = COCKPIT_PANE_ID
  projectId: string
  agent: Agent
  // Agente detectado em primeiro plano (ex.: `claude` digitado num painel de shell).
  foreground?: Agent
  title: string
  lifecycle: Lifecycle
  activity: Activity
  activityDetail?: string
  // Fonte do status atual, para depuração/selo "melhor esforço".
  activitySource?: 'osc' | 'hook' | 'heuristic'
  message?: string
  claudeSessionId?: string
  taskTitle?: string
  exitCode?: number
  startedAt: number
  lastOutputAt: number
  cols: number
  rows: number
  modTyped?: boolean
  // Modelo que respondeu por último (Claude, lido do transcript no fim de cada turno).
  model?: string
  // O mod auto-modelo estava ligado quando esta sessão do Claude abriu (o /auto-modelo só existe nela se sim).
  autoModelo?: boolean
  // Iniciada pelo Hermes (canal de controle): só essas o Hermes encerra.
  origin?: 'hermes'
}

export interface SpawnRequest {
  projectId: string
  agent: Agent
  resume?: boolean
  cols: number
  rows: number
  // Comando digitado logo após o shell abrir (LaunchTargets / mods). Só palavras montadas pelo app.
  initialInput?: string
  title?: string
  // Retomar exatamente esta conversa do Claude (id validado no main).
  claudeSessionId?: string
  // Primeira mensagem do Claude (só montada pelo main, ex.: /UploadNoGithub).
  initialPrompt?: string
  // Pedidos do Hermes (só montados pelo main): Remote Control com este nome, em modo plano.
  remoteControl?: string
  origin?: 'hermes'
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  // Data do commit (ms).
  at: number
}

// Estado do projeto em relação ao git/GitHub. `none`: pasta sem repositório próprio; `local`: git sem remote.
export interface GitState {
  kind: 'none' | 'local' | 'remote'
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  // Arquivos alterados (já rastreados) e novos (não rastreados).
  changed: number
  untracked: number
  files: string[]
  incoming: GitCommit[]
  outgoing: GitCommit[]
  // "dono/repo" e a página no GitHub (sem credenciais).
  repo?: string
  webUrl?: string
  checkedAt: number
  fetchedAt?: number
  fetching?: boolean
  error?: string
}

// Branch padrão: nela nada sobe direto, só por uma branch nova + PR.
export function isDefaultBranch(b: string | undefined): boolean {
  return b === 'main' || b === 'master'
}

export interface TreeEntry {
  name: string
  path: string
  kind: 'dir' | 'file' | 'symlink' | 'package'
  hidden: boolean
}

export interface TreeListing {
  entries: TreeEntry[]
  truncated: number
}

export interface LaunchTarget {
  id: string
  kind: 'app' | 'server' | 'page'
  title: string
  detail: string
  path: string
  command?: string
}

export interface Prefs {
  sound: boolean
  notifications: boolean
  oscStatus: boolean
  fontSize: number
  silentWhenNotifier: boolean
}

export const DEFAULT_PREFS: Prefs = {
  sound: true,
  notifications: true,
  oscStatus: true,
  fontSize: 13,
  silentWhenNotifier: false,
}

export interface PreviewInfo {
  path: string
  kind: 'image' | 'video' | 'audio' | 'text' | 'html' | 'other'
  url?: string
  text?: string
  size: number
  tooLarge?: boolean
}

export interface BrowserState {
  projectId: string
  url: string
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  title: string
}

export interface ModButton {
  modId: string
  id: string
  label: string
  icon?: string
  location: 'sidebar' | 'project'
}

export interface ModCommand {
  modId: string
  id: string
  title: string
}

export interface ModPanel {
  modId: string
  id: string
  title: string
  url: string
}

export interface ModInfo {
  id: string
  name: string
  version: string
  description?: string
  enabled: boolean
  permissions: string[]
  error?: string
  hasScript: boolean
}

export interface ModsSnapshot {
  mods: ModInfo[]
  buttons: ModButton[]
  commands: ModCommand[]
  panels: ModPanel[]
}

// Mods/plugins do Claude Code (~/.claude/settings.json → enabledPlugins).
export interface ClaudeModInfo {
  key: string
  name: string
  version?: string
  description?: string
  enabled: boolean
  kind: 'mod' | 'plugin'
}

export interface ClaudeModsSnapshot {
  mods: ClaudeModInfo[]
  plugins: ClaudeModInfo[]
  error?: string
}

export const PROJECT_COLORS = [
  '#e07a5f', '#81b29a', '#f2cc8f', '#7aa2f7', '#bb9af7', '#f7768e',
  '#2ac3de', '#9ece6a', '#ff9e64', '#c0caf5', '#e0af68', '#73daca',
]

// ---- Agente de chat ----

export type AgentProviderId = 'claudecode' | 'xai' | 'anthropic' | 'openai' | 'ollama' | 'lmstudio'

export interface AgentProviderInfo {
  id: AgentProviderId
  label: string
  needsKey: boolean
  configured: boolean
  baseUrl: string
  defaultModel: string
  lastModel?: string
}

export interface AgentToolCall {
  id: string
  name: string
  summary: string
  ok?: boolean
  detail?: string
}

export interface AgentAttachment {
  kind: 'file' | 'terminal'
  label: string
  path?: string
  sessionId?: string
}

export interface AgentUsage {
  input: number
  output: number
  cacheRead?: number
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  // Texto efetivamente enviado ao modelo (com anexos expandidos). Só no histórico, não na tela.
  prompt?: string
  thinking?: string
  tools?: AgentToolCall[]
  attachments?: AgentAttachment[]
  provider?: AgentProviderId
  model?: string
  usage?: AgentUsage
  error?: string
  notice?: string
  at: number
}

export interface AgentConversation {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  messages: AgentMessage[]
}

export interface AgentConversationSummary {
  id: string
  title: string
  updatedAt: number
  messages: number
}

export interface AgentSendRequest {
  projectId: string
  conversationId?: string
  provider: AgentProviderId
  model: string
  text: string
  attachments?: AgentAttachment[]
}

// Ação do agente que espera o clique do usuário (Aplicar/Recusar) antes de acontecer.
export interface AgentApproval {
  id: string
  kind: 'write' | 'edit' | 'move' | 'mkdir' | 'trash' | 'type' | 'spawn'
  title: string
  project?: string
  // Diff, prévia do conteúdo ou o texto exato que será digitado.
  detail?: string
}

export type AgentEvent =
  | { type: 'start'; projectId: string; conversationId: string; messageId: string; user: AgentMessage; title: string }
  | { type: 'text'; projectId: string; conversationId: string; messageId: string; delta: string }
  | { type: 'thinking'; projectId: string; conversationId: string; messageId: string; delta: string }
  | { type: 'tool'; projectId: string; conversationId: string; messageId: string; call: AgentToolCall }
  | { type: 'notice'; projectId: string; conversationId: string; messageId: string; text: string }
  | { type: 'done'; projectId: string; conversationId: string; messageId: string; message: AgentMessage }
  | { type: 'approval'; projectId: string; conversationId: string; messageId: string; approval: AgentApproval }
  | { type: 'approvalDone'; projectId: string; conversationId: string; messageId: string; id: string; ok: boolean }

// ---- Uso dos modelos (painel 📊) ----

export type UsagePeriod = 'today' | '7d' | '30d'

// Uma janela de limite de um plano: % usado e quando renova.
export interface PlanWindow {
  label: string
  percent: number
  resetsAt?: number
}

export interface PlanCard {
  id: 'claude' | 'codex'
  title: string
  plan?: string
  windows: PlanWindow[]
  // Quando a leitura foi feita (ms); ausente = nunca lida.
  readAt?: number
  note?: string
}

export interface TokenTotals {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  // Custo estimado em US$ (equivalente em API); null = preço desconhecido.
  cost: number | null
}

export interface UsageRow extends TokenTotals {
  key: string
  label: string
}

export interface UsageDay extends TokenTotals {
  day: string
}

export interface UsageSource {
  id: 'claude' | 'codex' | 'agent'
  title: string
  totals: TokenTotals
  days: UsageDay[]
  byModel: UsageRow[]
  byProject: UsageRow[]
  note?: string
}

export interface AccountUsage {
  id: 'anthropic' | 'openai' | 'xai'
  title: string
  configured: boolean
  // Custo real em US$ no período, por dia e por modelo/item.
  cost?: number
  days?: { day: string; cost: number }[]
  byItem?: { label: string; cost: number }[]
  tokens?: { input: number; output: number; cacheRead: number }
  error?: string
  note?: string
}

export interface UsageReport {
  period: UsagePeriod
  plans: PlanCard[]
  sessions: UsageSource[]
  agent: UsageSource
  accounts: AccountUsage[]
  updatedAt: number
  scanning?: boolean
  scanError?: string
  // Agente e contas dependem do Keychain: sem permissão (clique), ficam de fora.
  locked?: boolean
}

export type AdminKeyId = 'anthropic-admin' | 'openai-admin'

// "Atualizar Cockpit" (port do Hermes): etapas do scripts/install-mac.sh, na ordem.
export const UPDATE_STEPS = [
  { id: 'waiting', title: 'Esperando as edições do código pararem' },
  { id: 'compiling', title: 'Compilando' },
  { id: 'packaging', title: 'Empacotando' },
  { id: 'signing', title: 'Assinando' },
  { id: 'installing', title: 'Instalando' },
  { id: 'restarting', title: 'Reiniciando' },
] as const

export type UpdateStep = (typeof UPDATE_STEPS)[number]['id']

export interface UpdateStatus {
  // Só no app empacotado e com a pasta do código ainda no lugar.
  supported: boolean
  available: boolean
  running: boolean
  // Terminais shell vivos: fecham no reinício e não voltam (Claude/Codex são retomados).
  closingShells: number
}

export interface UpdateProgress {
  step: UpdateStep
  line: string | null
  // null enquanto roda; o fim do log quando falhou.
  failed: string | null
  startedAt: number
}
