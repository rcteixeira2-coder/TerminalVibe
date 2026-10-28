import type {
  AdminKeyId, PlanCard, UsagePeriod, UsageReport,
  AgentConversation, AgentConversationSummary, AgentEvent, AgentProviderId, AgentProviderInfo, AgentSendRequest,
  Agent, BrowserState, SidebarGroup, ClaudeModsSnapshot, UpdateProgress, UpdateStatus, GitState, LaunchTarget, ModsSnapshot, Prefs, PreviewInfo, Project, SessionInfo, SpawnRequest, TreeListing,
} from './types'
import type { ModelCatalog } from './modelSwitch'

// Contrato único entre main e renderer. Cada canal `invoke` tem request/response tipados;
// eventos `main → renderer` estão em MainEvents.
export interface InvokeApi {
  'app:info': () => { version: string; home: string; platform: string; packaged: boolean }
  'projects:list': () => Project[]
  'projects:add': () => Project | null
  'projects:remove': (id: string) => void
  'projects:update': (id: string, patch: Partial<Pick<Project, 'favorite' | 'color' | 'lastAgent' | 'openIn'>> & { group?: string | null }) => Project | null
  // Divisões da barra lateral, na ordem em que aparecem. Excluir uma divisão devolve as pastas dela.
  'groups:list': () => SidebarGroup[]
  'groups:set': (groups: SidebarGroup[]) => SidebarGroup[]
  'projects:reveal': (id: string) => void
  // Encerra todas as sessões do projeto (pergunta antes se alguma está rodando); ele volta para a Mesa.
  'projects:close': (id: string) => boolean
  'projects:openInCursor': (path: string, line?: number) => { ok: boolean; error?: string }
  'sessions:list': () => SessionInfo[]
  'sessions:spawn': (req: SpawnRequest) => SessionInfo | { error: string }
  'sessions:kill': (id: string) => void
  'sessions:interrupt': (id: string) => void
  'sessions:dispose': (id: string) => void
  'sessions:buffer': (id: string) => string
  'sessions:insertPath': (id: string, path: string) => boolean
  'sessions:restorable': () => { projectId: string; agent: Agent; title: string; claudeSessionId?: string }[]
  'sessions:forgetRestorable': (projectId: string) => void
  'files:list': (projectId: string, dir: string) => TreeListing | { error: string }
  'files:quickLook': (projectId: string, path: string) => boolean
  'files:reveal': (projectId: string, path: string) => boolean
  'files:copyPath': (projectId: string, path: string) => boolean
  'files:preview': (projectId: string, path: string) => PreviewInfo | { error: string }
  'files:resolveLink': (sessionId: string, text: string) => { path: string; line?: number } | null
  'links:open': (url: string) => boolean
  'launch:targets': (projectId: string) => LaunchTarget[]
  'git:states': () => Record<string, GitState>
  'git:refresh': (projectId: string, fetch: boolean) => GitState | null
  'git:action': (projectId: string, action: 'pull' | 'push' | 'claude', cols: number, rows: number) => SessionInfo | { error: string }
  'launch:run': (projectId: string, targetId: string, cols: number, rows: number) => SessionInfo | { error: string } | { ok: true }
  'browser:open': (projectId: string, url?: string) => BrowserState | { error: string }
  'browser:navigate': (projectId: string, url: string) => BrowserState | { error: string }
  'browser:action': (projectId: string, action: 'back' | 'forward' | 'reload' | 'external' | 'close' | 'devtools') => void
  'browser:bounds': (projectId: string, rect: { x: number; y: number; width: number; height: number } | null) => void
  'browser:state': (projectId: string) => BrowserState | null
  'prefs:get': () => Prefs
  'prefs:set': (patch: Partial<Prefs>) => Prefs
  'notifier:status': () => { installed: boolean; muted: boolean }
  'notifier:mute': (muted: boolean) => { installed: boolean; muted: boolean }
  'mods:snapshot': () => ModsSnapshot
  'mods:setEnabled': (id: string, enabled: boolean) => ModsSnapshot
  'mods:reload': () => ModsSnapshot
  'mods:invoke': (modId: string, actionId: string, ctx: { projectId?: string; sessionId?: string }) => { ok: boolean; error?: string }
  'mods:openFolder': () => void
  'claudeMods:snapshot': () => ClaudeModsSnapshot
  'claudeMods:setEnabled': (key: string, enabled: boolean) => ClaudeModsSnapshot | { error: string }
  'claudeMods:openFolder': () => void
  'models:catalog': () => ModelCatalog
  'ui:contextMenu': (kind: 'file' | 'project' | 'session' | 'group', payload: Record<string, string>) => string | null
  'ui:dockBadge': (count: number) => void
  'ui:edit': (action: 'copy' | 'selectAll') => void
  'agent:providers': () => { providers: AgentProviderInfo[]; lastProvider?: AgentProviderId; encryption: boolean }
  'agent:setKey': (id: AgentProviderId, key: string | null) => { ok: boolean; error?: string }
  'agent:setBaseUrl': (id: AgentProviderId, url: string | null) => { ok: boolean; error?: string }
  'agent:test': (id: AgentProviderId) => { ok: boolean; message: string }
  'agent:models': (id: AgentProviderId) => { models: string[] } | { error: string }
  'agent:conversations': (projectId: string) => AgentConversationSummary[]
  'agent:load': (projectId: string, id: string) => AgentConversation | null
  'agent:delete': (projectId: string, id: string | null) => void
  'agent:send': (req: AgentSendRequest) => { conversationId: string; messageId: string } | { error: string }
  'agent:stop': (conversationId: string) => void
  'agent:approve': (id: string, ok: boolean) => void
  'usage:report': (period: UsagePeriod, force: boolean, secure: boolean) => UsageReport
  'usage:claudeCard': () => PlanCard
  'usage:adminStatus': () => Record<AdminKeyId, boolean>
  'usage:setAdminKey': (id: AdminKeyId, key: string | null) => { ok: boolean; error?: string }
  'usage:testAdmin': (id: AdminKeyId) => { ok: boolean; message: string }
  'agent:findFiles': (projectId: string, query: string) => string[]
  'files:resolveProjectPath': (projectId: string, text: string) => { path: string; line?: number } | null
  // "Atualizar Cockpit": recompila do código-fonte, instala e reabre (igual ao Hermes).
  'update:status': () => UpdateStatus
  'update:start': () => UpdateProgress | { error: string }
  'update:relaunch': () => void
}

export type InvokeChannel = keyof InvokeApi

// Fire-and-forget renderer → main.
export interface SendApi {
  'pty:write': (id: string, data: string) => void
  'pty:resize': (id: string, cols: number, rows: number) => void
  'pty:ack': (id: string, bytes: number) => void
  'session:focus': (id: string) => void
  'session:visible': (ids: string[]) => void
  'mods:panelToMod': (modId: string, panelId: string, message: unknown) => void
  'renderer:ready': () => void
}

export type SendChannel = keyof SendApi

export interface MainEvents {
  'pty:data': (id: string, data: string) => void
  'session:update': (info: SessionInfo) => void
  'session:removed': (id: string) => void
  'projects:changed': (projects: Project[]) => void
  'ui:focusSession': (id: string) => void
  'ui:command': (command: string) => void
  'browser:state': (state: BrowserState) => void
  'browser:detected': (projectId: string, url: string) => void
  // Ordem explícita (▶ Rodar, Claude usando o navegador): navega se houver url e MOSTRA o painel.
  'browser:show': (projectId: string, url?: string, by?: string) => void
  'mods:changed': (snap: ModsSnapshot) => void
  'mods:panelMessage': (modId: string, panelId: string, message: unknown) => void
  'notice': (text: string) => void
  'agent:event': (ev: AgentEvent) => void
  'git:state': (projectId: string, state: GitState) => void
  'usage:limits': (card: PlanCard) => void
  'update:progress': (progress: UpdateProgress) => void
}

export type EventChannel = keyof MainEvents

export const INVOKE_CHANNELS: InvokeChannel[] = [
  'app:info', 'projects:list', 'projects:add', 'projects:remove', 'projects:update', 'projects:reveal', 'projects:close',
  'groups:list', 'groups:set',
  'projects:openInCursor', 'sessions:list', 'sessions:spawn', 'sessions:kill', 'sessions:interrupt',
  'sessions:dispose', 'sessions:buffer', 'sessions:insertPath', 'sessions:restorable', 'sessions:forgetRestorable', 'files:list', 'files:quickLook', 'files:reveal',
  'files:copyPath', 'files:preview', 'files:resolveLink', 'links:open', 'launch:targets', 'launch:run', 'git:states', 'git:refresh', 'git:action',
  'browser:open', 'browser:navigate', 'browser:action', 'browser:bounds', 'browser:state', 'prefs:get',
  'prefs:set', 'notifier:status', 'notifier:mute', 'mods:snapshot', 'mods:setEnabled', 'mods:reload',
  'mods:invoke', 'mods:openFolder', 'claudeMods:snapshot', 'claudeMods:setEnabled', 'claudeMods:openFolder', 'models:catalog', 'ui:contextMenu', 'ui:dockBadge', 'ui:edit',
  'agent:providers', 'agent:setKey', 'agent:setBaseUrl', 'agent:test', 'agent:models', 'agent:conversations', 'agent:load',
  'agent:delete', 'agent:send', 'agent:stop', 'agent:approve', 'agent:findFiles', 'usage:report', 'usage:claudeCard', 'usage:adminStatus', 'usage:setAdminKey', 'usage:testAdmin', 'files:resolveProjectPath',
  'update:status', 'update:start', 'update:relaunch',
]

export const SEND_CHANNELS: SendChannel[] = ['pty:write', 'pty:resize', 'pty:ack', 'session:focus', 'session:visible', 'mods:panelToMod', 'renderer:ready']

export const EVENT_CHANNELS: EventChannel[] = [
  'pty:data', 'session:update', 'session:removed', 'projects:changed', 'ui:focusSession', 'ui:command',
  'browser:state', 'browser:detected', 'browser:show', 'mods:changed', 'mods:panelMessage', 'notice', 'agent:event', 'git:state', 'usage:limits', 'update:progress',
]

