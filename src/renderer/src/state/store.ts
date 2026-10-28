import { create } from 'zustand'
import type {
  Agent, AgentApproval, AgentAttachment, AgentConversation, AgentConversationSummary, AgentMessage, AgentProviderId, AgentProviderInfo, AgentToolCall,
  BrowserState, GitState, ModsSnapshot, PlanCard, Prefs, Project, SessionInfo, SidebarGroup, UpdateProgress, UpdateStatus,
} from '@shared/types'
import { DEFAULT_PREFS } from '@shared/types'
import { mostUrgent, needsMe, URGENCY } from '@shared/status'
import { presetOf } from '../layout/presets'

export const MAX_PANES = 6

export interface Tab {
  id: string
  sessionIds: string[]
  // Layout escolhido no menu ▦ (sem ele: todos lado a lado), posição de cada sessão nos espaços e tamanhos das divisórias.
  preset?: string
  order?: (string | null)[]
  sizes?: Record<string, number[]>
  // O browser do projeto ocupa um espaço da aba ("+ App").
  app?: boolean
  // Espaços do layout tirados pelo × do "Espaço livre" (voltam ao escolher o layout de novo no ▦).
  removed?: number[]
  // Item expandido para a aba toda: id da sessão ou 'app'.
  maximized?: string
}

export const APP_CELL = 'app'

// Quantos terminais cabem na aba: os espaços do layout ou o limite geral.
export function tabCapacity(tab: Tab): number {
  const p = presetOf(tab.preset)
  return p ? p.slots - (tab.removed?.filter((i) => i < p.slots).length ?? 0) : MAX_PANES
}

// Layout e tamanhos por projeto, lembrados entre aberturas do app.
const ARRANGE_KEY = 'cockpit.arrange'
interface Arrangement {
  preset?: string
  sizes: Record<string, Record<string, number[]>>
}

function loadArrangements(): Record<string, Arrangement> {
  try {
    return JSON.parse(localStorage.getItem(ARRANGE_KEY) ?? '{}') as Record<string, Arrangement>
  } catch {
    return {}
  }
}

export function savedArrangement(projectId: string): Arrangement {
  return loadArrangements()[projectId] ?? { sizes: {} }
}

export function saveArrangement(projectId: string, patch: { preset?: string | null; sizes?: { preset: string; value: Record<string, number[]> } }): void {
  const all = loadArrangements()
  const cur = all[projectId] ?? { sizes: {} }
  if (patch.preset !== undefined) cur.preset = patch.preset ?? undefined
  if (patch.sizes) cur.sizes[patch.sizes.preset] = patch.sizes.value
  all[projectId] = cur
  try {
    localStorage.setItem(ARRANGE_KEY, JSON.stringify(all))
  } catch {
    // sem armazenamento: o layout vale só nesta abertura
  }
}

export interface ProjectLayout {
  tabs: Tab[]
  activeTabId: string
}

export type Overlay = null | 'palette' | 'mods' | 'claudeMods' | 'prefs' | 'preview' | 'find' | 'usage' | 'components'

export interface Toast {
  id: number
  text: string
  kind?: 'info' | 'error'
}

interface Ui {
  sidebar: boolean
  tree: boolean
  browserWidth: number
  treeWidth: number
}

export type DockTab = 'agent' | 'browser'

export interface AgentStreaming {
  messageId: string
  text: string
  thinking: string
  tools: AgentToolCall[]
  notice?: string
}

export interface AgentPane {
  conversationId?: string
  conversation?: AgentConversation
  summaries: AgentConversationSummary[]
  streaming?: AgentStreaming
  draft: string
  attachments: AgentAttachment[]
  // Ações do agente aguardando Aplicar/Recusar (some quando decididas).
  approvals?: AgentApproval[]
}

export interface AgentConfig {
  providers: AgentProviderInfo[]
  provider: AgentProviderId
  model: string
  models: Partial<Record<AgentProviderId, string[]>>
  modelErrors: Partial<Record<AgentProviderId, string>>
  encryption: boolean
  // Já consultou o main (e o Keychain) nesta sessão. Antes disso nada toca no Keychain.
  loaded: boolean
}

export interface Restorable {
  projectId: string
  agent: Agent
  title: string
  claudeSessionId?: string
}

interface State {
  projects: Project[]
  // Divisões da barra lateral criadas pelo usuário, na ordem de exibição.
  groups: SidebarGroup[]
  // Divisão com o nome em edição (recém-criada ou "Renomear").
  renamingGroup: string | null
  sessions: Record<string, SessionInfo>
  layouts: Record<string, ProjectLayout>
  activeProjectId: string | null
  view: 'project' | 'grid'
  focusedSessionId: string | null
  overlay: Overlay
  // Sessão do Claude de onde a janela de mods foi aberta (para oferecer reiniciá-la).
  claudeModsFor: string | null
  previewPath: string | null
  browser: Record<string, BrowserState & { open: boolean }>
  // Sessão do Claude usando o navegador do projeto agora (selo no painel; some sozinho).
  browserBy: Record<string, string>
  mods: ModsSnapshot
  prefs: Prefs
  toasts: Toast[]
  restorable: Restorable[]
  modPanel: { modId: string; id: string } | null
  dropdownOpen: boolean
  // Terminal sendo arrastado pelo cabeçalho (mostra as áreas de soltar).
  draggingPane: string | null
  // Divisória sendo arrastada (esconde o browser, que fica por cima do DOM).
  resizing: boolean
  dock: Record<string, { open: boolean; tab: DockTab }>
  agent: Record<string, AgentPane>
  agentConfig: AgentConfig
  git: Record<string, GitState>
  // Limites do plano do Claude (barrinha do botão 📊 da barra lateral).
  usageCard: PlanCard | null
  // "Atualizar Cockpit": se há código novo (botão ↻) e o progresso da atualização em curso (cartão).
  updateStatus: UpdateStatus | null
  update: UpdateProgress | null
  ui: Ui
}

const UI_KEY = 'cockpit.ui'

function loadUi(): Ui {
  const base: Ui = { sidebar: true, tree: false, browserWidth: 520, treeWidth: 240 }
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as Partial<Ui>) }
  } catch {
    return base
  }
}

let tabSeq = 0
export const newTabId = () => `tab-${Date.now().toString(36)}-${++tabSeq}`

export const useStore = create<State>(() => ({
  projects: [],
  groups: [],
  renamingGroup: null,
  sessions: {},
  layouts: {},
  activeProjectId: null,
  view: 'project',
  focusedSessionId: null,
  overlay: null,
  claudeModsFor: null,
  previewPath: null,
  browser: {},
  mods: { mods: [], buttons: [], commands: [], panels: [] },
  prefs: DEFAULT_PREFS,
  toasts: [],
  restorable: [],
  modPanel: null,
  dropdownOpen: false,
  draggingPane: null,
  resizing: false,
  dock: {},
  agent: {},
  browserBy: {},
  agentConfig: { providers: [], provider: 'xai', model: 'grok-4.7', models: {}, modelErrors: {}, encryption: true, loaded: false },
  git: {},
  usageCard: null,
  updateStatus: null,
  update: null,
  ui: loadUi(),
}))

const set = useStore.setState
const get = useStore.getState

export function setUi(patch: Partial<Ui>): void {
  const ui = { ...get().ui, ...patch }
  set({ ui })
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui))
  } catch {
    // armazenamento indisponível
  }
}

let toastSeq = 0
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastSeq
  set({ toasts: [...get().toasts, { id, text, kind }] })
  setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 4000)
}

export function layoutOf(projectId: string): ProjectLayout {
  const l = get().layouts[projectId]
  if (l && l.tabs.length) return l
  // A primeira aba do projeto volta com o último layout escolhido.
  const saved = savedArrangement(projectId)
  const preset = presetOf(saved.preset)?.id
  const tab: Tab = { id: newTabId(), sessionIds: [], preset, sizes: saved.sizes[preset ?? 'auto'] }
  const fresh = { tabs: [tab], activeTabId: tab.id }
  set({ layouts: { ...get().layouts, [projectId]: fresh } })
  return fresh
}

export function setLayout(projectId: string, layout: ProjectLayout): void {
  set({ layouts: { ...get().layouts, [projectId]: layout } })
}

export function updateTab(projectId: string, tabId: string, patch: Partial<Tab>): void {
  const l = layoutOf(projectId)
  setLayout(projectId, { ...l, tabs: l.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) })
}

export function activeTab(projectId: string): Tab {
  const l = layoutOf(projectId)
  return l.tabs.find((t) => t.id === l.activeTabId) ?? l.tabs[0]
}

// Coloca a sessão na aba ativa do projeto (ou numa aba nova se a ativa estiver cheia).
// `replace`: ocupa o lugar de outra sessão (Retomar/Nova sessão num painel parado).
export function placeSession(info: SessionInfo, opts: { newTab?: boolean; replace?: string } = {}): void {
  const l = layoutOf(info.projectId)
  if (l.tabs.some((t) => t.sessionIds.includes(info.id))) return
  if (opts.replace) {
    const host = l.tabs.find((t) => t.sessionIds.includes(opts.replace!))
    if (host) {
      setLayout(info.projectId, {
        tabs: l.tabs.map((t) => (t.id === host.id ? { ...t, sessionIds: t.sessionIds.map((x) => (x === opts.replace ? info.id : x)) } : t)),
        activeTabId: host.id,
      })
      return
    }
  }
  const tab = l.tabs.find((t) => t.id === l.activeTabId) ?? l.tabs[0]
  if (!opts.newTab && tab.sessionIds.length + (tab.app ? 1 : 0) < tabCapacity(tab)) {
    setLayout(info.projectId, {
      ...l,
      tabs: l.tabs.map((t) => (t.id === tab.id ? { ...t, sessionIds: [...t.sessionIds, info.id] } : t)),
    })
  } else {
    const nt = { id: newTabId(), sessionIds: [info.id] }
    setLayout(info.projectId, { tabs: [...l.tabs, nt], activeTabId: nt.id })
  }
}

export function removeSessionFromLayouts(id: string): void {
  const layouts = { ...get().layouts }
  for (const [pid, l] of Object.entries(layouts)) {
    if (!l.tabs.some((t) => t.sessionIds.includes(id))) continue
    let tabs = l.tabs.map((t) => ({ ...t, sessionIds: t.sessionIds.filter((s) => s !== id), maximized: t.maximized === id ? undefined : t.maximized }))
    // Aba vazia some, exceto se for a única (ou se ainda mostra o App).
    if (tabs.length > 1) tabs = tabs.filter((t) => t.sessionIds.length || t.app || t.id === l.activeTabId)
    const activeTabId = tabs.some((t) => t.id === l.activeTabId) ? l.activeTabId : tabs[tabs.length - 1].id
    layouts[pid] = { tabs, activeTabId }
  }
  set({ layouts })
}

export function sessionsOf(projectId: string): SessionInfo[] {
  return Object.values(get().sessions)
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function projectActivity(projectId: string, sessions: Record<string, SessionInfo>) {
  return mostUrgent(
    Object.values(sessions)
      .filter((s) => s.projectId === projectId && s.lifecycle === 'running')
      .map((s) => s.activity),
  )
}

export function needsMeOrder(list: SessionInfo[]): SessionInfo[] {
  return [...list].sort((a, b) => {
    const ra = a.lifecycle === 'running' ? URGENCY[a.activity] : -1
    const rb = b.lifecycle === 'running' ? URGENCY[b.activity] : -1
    return rb - ra || b.lastOutputAt - a.lastOutputAt
  })
}

export function countNeedsMe(sessions: Record<string, SessionInfo>): number {
  return Object.values(sessions).filter((s) => s.lifecycle === 'running' && needsMe(s.activity)).length
}

export const actions = { set, get }

export function agentPane(projectId: string): AgentPane {
  return get().agent[projectId] ?? { summaries: [], draft: '', attachments: [] }
}

export function setAgentPane(projectId: string, patch: Partial<AgentPane>): void {
  set({ agent: { ...get().agent, [projectId]: { ...agentPane(projectId), ...patch } } })
}

export function setDock(projectId: string, patch: Partial<{ open: boolean; tab: DockTab }>): void {
  const cur = get().dock[projectId] ?? { open: false, tab: 'agent' as DockTab }
  set({ dock: { ...get().dock, [projectId]: { ...cur, ...patch } } })
}

export function appendMessage(projectId: string, m: AgentMessage): void {
  const pane = agentPane(projectId)
  if (!pane.conversation) return
  set({
    agent: {
      ...get().agent,
      [projectId]: { ...pane, conversation: { ...pane.conversation, messages: [...pane.conversation.messages, m], updatedAt: Date.now() } },
    },
  })
}
