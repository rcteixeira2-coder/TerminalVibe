import type { Agent, AgentEvent, AgentProviderId, SessionInfo, SidebarGroup } from '@shared/types'
import { AGENT_LABEL } from '@shared/types'
import { needsMe } from '@shared/status'
import {
  actions, activeTab, agentPane, appendMessage, layoutOf, needsMeOrder, newTabId, placeSession, removeSessionFromLayouts,
  APP_CELL, type Tab, saveArrangement, savedArrangement, setAgentPane, setDock, setLayout, setUi, tabCapacity, toast, updateTab,
} from './state/store'
import { arrange, autoCells, moveInSlots, presetOf, type DropZone } from './layout/presets'
import {
  clearTerminal, currentSize, disposeTerminal, ensureTerminal, focusTerminal, replay, selectAll, selection, setFontSize,
  setPathLinkHandler, writeData, applyTheme, onTerminalFocus,
} from './terminal/registry'

const { set, get } = actions
const api = () => window.cockpit

// Painéis reiniciados (Retomar/Nova sessão): a sessão nova ocupa o lugar da antiga.
const pendingReplace: { projectId: string; agent: Agent; replace: string }[] = []
// Ids já removidos: eventos atrasados não ressuscitam painéis.
const removedIds = new Set<string>()
// Sessões em reidratação: a saída ao vivo espera o replay terminar, na ordem.
const replayQueue = new Map<string, string[]>()

function placeNew(info: SessionInfo): void {
  const i = pendingReplace.findIndex((p) => p.projectId === info.projectId && p.agent === info.agent)
  if (i >= 0) {
    const [p] = pendingReplace.splice(i, 1)
    placeSession(info, { replace: p.replace })
  } else placeSession(info)
}

export async function init(): Promise<void> {
  // Ouvintes primeiro: nada que o main enviar durante a carga se perde (e o fluxo do pty segue confirmado).
  api().on('pty:data', (id, data) => {
    if (removedIds.has(id)) return
    const q = replayQueue.get(id)
    if (q) q.push(data)
    else if (get().sessions[id]) writeData(id, data)
    // Sem sessão conhecida: ainda assim confirma, para o main não pausar o pty.
    else api().send('pty:ack', id, data.length)
  })
  api().on('session:update', (info) => {
    if (removedIds.has(info.id)) return
    const known = !!get().sessions[info.id]
    set({ sessions: { ...get().sessions, [info.id]: info } })
    if (!known && !replayQueue.has(info.id)) placeNew(info)
  })
  api().on('session:removed', (id) => {
    removedIds.add(id)
    if (removedIds.size > 500) removedIds.delete(removedIds.values().next().value!)
    const sessions = { ...get().sessions }
    delete sessions[id]
    set({ sessions, focusedSessionId: get().focusedSessionId === id ? null : get().focusedSessionId })
    removeSessionFromLayouts(id)
    disposeTerminal(id)
  })
  const [projects, groups, sessions, prefs, mods, restorable] = await Promise.all([
    api().invoke('projects:list'),
    api().invoke('groups:list'),
    api().invoke('sessions:list'),
    api().invoke('prefs:get'),
    api().invoke('mods:snapshot'),
    api().invoke('sessions:restorable'),
  ])
  setFontSize(prefs.fontSize)
  const map: Record<string, SessionInfo> = {}
  for (const s of sessions) map[s.id] = s
  for (const s of sessions) replayQueue.set(s.id, [])
  set({ projects, groups, sessions: { ...map, ...get().sessions }, prefs, mods, restorable })
  // Antes do renderer:ready: o main despacha nesse momento os comandos que esperavam a interface (Hermes).
  api().on('ui:command', (cmd) => void runCommand(cmd))
  api().send('renderer:ready')
  // Renderer recarregado com sessões vivas: reidrata os terminais no tamanho do pty e recria o layout.
  for (const s of sessions) {
    ensureTerminal(s.id, s.cols, s.rows)
    const snapshot = await api().invoke('sessions:buffer', s.id)
    const queued = replayQueue.get(s.id) ?? []
    replayQueue.delete(s.id)
    // O buffer já inclui tudo até o pedido; o que chegou ao vivo antes dele é descartado para não duplicar.
    replay(s.id, snapshot)
    for (const d of queued) api().send('pty:ack', s.id, d.length)
    if (!removedIds.has(s.id)) placeSession(s)
  }
  // Interface recarregada com sessões vivas: volta para o projeto da sessão mais recente.
  const latest = [...sessions].sort((x, y) => y.startedAt - x.startedAt)[0]
  const first = (latest && projects.find((p) => p.id === latest.projectId)) ?? projects.find((p) => p.favorite) ?? projects[0]
  if (first && !get().activeProjectId) selectProject(first.id)

  api().on('projects:changed', (list) => set({ projects: list }))
  api().on('ui:focusSession', (id) => focusSession(id))
  api().on('notice', (text) => toast(text))
  api().on('mods:changed', (snap) => set({ mods: snap }))
  api().on('browser:state', (s) => {
    const cur = get().browser[s.projectId]
    set({ browser: { ...get().browser, [s.projectId]: { ...s, open: s.url ? (cur?.open ?? true) : false } } })
  })
  api().on('browser:show', (projectId, url, by) => void showBrowser(projectId, url, by))
  api().on('browser:detected', (projectId, url) => {
    const cur = get().browser[projectId]
    // App num espaço do layout: carrega ali, sem abrir o dock.
    if (appInLayout(projectId)) {
      if (!cur?.url || cur.url.startsWith('about:')) void openBrowser(projectId, url, { keepTab: true })
      else if (cur.url !== url) toast(`Servidor detectado: ${url}`)
      return
    }
    // Já à vista com uma página: não troca sozinho, só avisa. Escondido (dock fechado), volta a aparecer.
    const dock = get().dock[projectId]
    const visible = !!cur?.open && !!dock?.open && dock.tab === 'browser'
    if (visible && cur?.url && !cur.url.startsWith('about:')) {
      if (cur.url !== url) toast(`Servidor detectado: ${url}`)
      return
    }
    // Com o agente aberto, não troca de aba sozinho: carrega o browser e avisa.
    if (dock?.open && dock.tab === 'agent') {
      void openBrowser(projectId, url, { keepTab: true })
      toast(`Servidor detectado: ${url} — aberto na aba Browser.`)
      return
    }
    void openBrowser(projectId, url)
  })
  api().on('agent:event', (ev) => onAgentEvent(ev))
  api().on('git:state', (id, st) => set({ git: { ...get().git, [id]: st } }))
  api().on('usage:limits', (card) => set({ usageCard: card }))
  api().on('update:progress', (progress) => set({ update: progress }))
  // Código novo do Cockpit aparece como um ponto no botão ↻: confere ao abrir, a cada minuto e ao focar a janela.
  void refreshUpdateStatus()
  setInterval(() => void refreshUpdateStatus(), 60_000)
  window.addEventListener('focus', () => void refreshUpdateStatus())
  void api().invoke('usage:claudeCard').then((card) => set({ usageCard: card }))
  void api().invoke('git:states').then((all) => set({ git: { ...all, ...get().git } }))
  api().on('mods:panelMessage', (modId, panelId, message) => {
    const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-mod="${CSS.escape(modId)}"][data-panel="${CSS.escape(panelId)}"]`)
    frame?.contentWindow?.postMessage({ kind: 'cockpit', message }, '*')
  })
  window.addEventListener('message', (e) => {
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-mod]')].find((f) => f.contentWindow === e.source)
    if (!frame) return
    api().send('mods:panelToMod', frame.dataset.mod!, frame.dataset.panel!, (e.data as { message?: unknown })?.message ?? e.data)
  })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme())
  setPathLinkHandler({
    resolve: (sessionId, text) => api().invoke('files:resolveLink', sessionId, text),
    open: (_sessionId, target, withCursor) => {
      if (withCursor) void openInCursor(target.path, target.line)
      else openPreview(target.path)
    },
  })
  onTerminalFocus((id) => {
    if (get().focusedSessionId !== id) set({ focusedSessionId: id })
  })
}

export function selectProject(id: string): void {
  void api().invoke('git:refresh', id, false)
  layoutOf(id)
  set({ activeProjectId: id, view: 'project' })
  const tab = activeTab(id)
  const target = tab.sessionIds.find((s) => s === get().focusedSessionId) ?? tab.sessionIds[0]
  if (target) setTimeout(() => focusTerminal(target), 30)
}

export function focusSession(id: string): void {
  const s = get().sessions[id]
  if (!s) return
  const l = layoutOf(s.projectId)
  const tab = l.tabs.find((t) => t.sessionIds.includes(id))
  if (tab && tab.id !== l.activeTabId) setLayout(s.projectId, { ...l, activeTabId: tab.id })
  set({ activeProjectId: s.projectId, view: 'project', focusedSessionId: id })
  setTimeout(() => focusTerminal(id), 40)
}

export async function spawn(
  projectId: string,
  agent: Agent,
  opts: { resume?: boolean; title?: string; claudeSessionId?: string; replace?: string } = {},
): Promise<SessionInfo | null> {
  const size = guessSize()
  const marker = opts.replace ? { projectId, agent, replace: opts.replace } : null
  if (marker) pendingReplace.push(marker)
  const r = await api().invoke('sessions:spawn', {
    projectId, agent, resume: opts.resume, cols: size.cols, rows: size.rows, title: opts.title, claudeSessionId: opts.claudeSessionId,
  })
  if ('error' in r) {
    if (marker) pendingReplace.splice(pendingReplace.indexOf(marker), 1)
    toast(r.error, 'error')
    return null
  }
  // O evento session:update pode chegar antes ou depois desta resposta.
  if (!get().sessions[r.id]) {
    set({ sessions: { ...get().sessions, [r.id]: r } })
    placeNew(r)
  }
  ensureTerminal(r.id, size.cols, size.rows)
  set({ focusedSessionId: r.id, activeProjectId: projectId, view: 'project' })
  setTimeout(() => focusTerminal(r.id), 60)
  return r
}

function guessSize(): { cols: number; rows: number } {
  const id = get().focusedSessionId
  return id ? currentSize(id) : { cols: 120, rows: 34 }
}

export function newTab(projectId: string): void {
  const l = layoutOf(projectId)
  const tab = { id: newTabId(), sessionIds: [] }
  setLayout(projectId, { tabs: [...l.tabs, tab], activeTabId: tab.id })
}

export function closeTab(projectId: string, tabId: string): void {
  const l = layoutOf(projectId)
  const tab = l.tabs.find((t) => t.id === tabId)
  if (!tab) return
  for (const id of tab.sessionIds) void api().invoke('sessions:dispose', id)
  let tabs = l.tabs.filter((t) => t.id !== tabId)
  if (!tabs.length) tabs = [{ id: newTabId(), sessionIds: [] }]
  setLayout(projectId, { tabs, activeTabId: l.activeTabId === tabId ? tabs[tabs.length - 1].id : l.activeTabId })
}

export async function split(agent: Agent): Promise<void> {
  const pid = get().activeProjectId
  if (!pid) return
  const tab = activeTab(pid)
  const cap = tabCapacity(tab)
  if (tab.sessionIds.length + (tab.app ? 1 : 0) >= cap) {
    const p = presetOf(tab.preset)
    toast(p ? `O layout "${p.label}" está cheio. Escolha outro no ▦ ou use ⌘T para uma aba nova.` : `Até ${cap} terminais por aba. Use ⌘T para uma aba nova.`)
    return
  }
  await spawn(pid, agent)
}

// ---- layout da aba (menu ▦, arrastar terminais, divisórias) ----

// Reinicia uma sessão do Claude retomando a mesma conversa (para aplicar mods ligados/desligados).
// Devolve o id da sessão nova (null se não deu).
export async function restartClaude(id: string): Promise<string | null> {
  const s = get().sessions[id]
  if (!s || s.agent !== 'claude' || !s.claudeSessionId) return null
  if (s.lifecycle === 'running' || s.lifecycle === 'stopping') {
    await api().invoke('sessions:kill', id)
    for (let i = 0; i < 40 && ['running', 'stopping'].includes(get().sessions[id]?.lifecycle ?? ''); i++) await new Promise((r) => setTimeout(r, 150))
  }
  const cur = get().sessions[id] ?? s
  const next = await spawn(cur.projectId, 'claude', { resume: true, title: cur.title, replace: cur.id, claudeSessionId: cur.claudeSessionId })
  if (next) void api().invoke('sessions:dispose', id)
  return next?.id ?? null
}

export function liveIds(tab: { sessionIds: string[] }): string[] {
  const sessions = get().sessions
  return tab.sessionIds.filter((id) => sessions[id])
}

// Tudo o que ocupa um espaço da aba: sessões vivas e o App.
export function cellIds(tab: Tab): string[] {
  return tab.app ? [...liveIds(tab), APP_CELL] : liveIds(tab)
}

// Posição de cada item: espaços do layout (com vazios) ou, no automático, a fila lado a lado.
export function tabCells(tab: Tab): { cells: (string | null)[]; fixed: boolean } {
  const ids = cellIds(tab)
  const p = presetOf(tab.preset)
  const slots = p ? arrange(p, tab.order, ids, tab.removed) : null
  return slots ? { cells: slots, fixed: true } : { cells: autoCells(tab.order, ids), fixed: false }
}

export function toggleMaximize(projectId: string, tabId: string, item: string): void {
  const tab = layoutOf(projectId).tabs.find((t) => t.id === tabId)
  if (!tab) return
  updateTab(projectId, tabId, { maximized: tab.maximized === item ? undefined : item })
  if (item !== APP_CELL) {
    set({ focusedSessionId: item })
    setTimeout(() => focusTerminal(item), 60)
  }
}

// Põe o browser do projeto num espaço da aba (o site do ▶ Rodar ou um .html).
export async function placeAppAt(projectId: string, tabId: string, slot: number): Promise<void> {
  const tab = layoutOf(projectId).tabs.find((t) => t.id === tabId)
  if (!tab || tab.app) return
  // Uma só view por projeto: sai do dock.
  if (get().dock[projectId]?.tab === 'browser') setDock(projectId, { open: false })
  const { cells, fixed } = tabCells({ ...tab, app: true })
  if (fixed) {
    const from = cells.indexOf(APP_CELL)
    if (from >= 0 && from !== slot && cells[slot] === null) {
      cells[from] = null
      cells[slot] = APP_CELL
    }
  }
  updateTab(projectId, tabId, { app: true, order: cells })
  if (!get().browser[projectId]?.url) await openBrowser(projectId, undefined, { keepTab: true })
}

export function removeApp(projectId: string, tabId: string): void {
  const tab = layoutOf(projectId).tabs.find((t) => t.id === tabId)
  if (!tab) return
  updateTab(projectId, tabId, {
    app: false,
    order: tab.order?.map((x) => (x === APP_CELL ? null : x)),
    maximized: tab.maximized === APP_CELL ? undefined : tab.maximized,
  })
}

export function appInLayout(projectId: string): boolean {
  return !!get().layouts[projectId] && !!activeTab(projectId).app
}

// `null` volta ao automático (todos lado a lado).
export function applyPreset(presetId: string | null): void {
  const pid = get().activeProjectId
  if (!pid) return
  const tab = activeTab(pid)
  const p = presetOf(presetId ?? undefined)
  const ids = cellIds(tab)
  if (p && ids.length > p.slots) {
    toast(`"${p.label}" tem ${p.slots} espaço(s) e a aba tem ${ids.length} itens. Feche algum ou use outra aba.`)
    return
  }
  const sizes = savedArrangement(pid).sizes[p?.id ?? 'auto']
  // Escolher um layout (mesmo o atual) devolve os espaços removidos.
  updateTab(pid, tab.id, { preset: p?.id, order: p ? arrange(p, tab.order, ids) ?? undefined : autoCells(tab.order, ids), sizes, maximized: undefined, removed: undefined })
  saveArrangement(pid, { preset: p?.id ?? null })
  set({ view: 'project' })
}

// `null`: volta às proporções do layout (duplo clique na divisória).
export function setPaneSizes(projectId: string, tabId: string, path: string, sizes: number[] | null): void {
  const tab = layoutOf(projectId).tabs.find((t) => t.id === tabId)
  if (!tab) return
  const next = { ...tab.sizes }
  if (sizes) next[path] = sizes
  else delete next[path]
  updateTab(projectId, tabId, { sizes: next })
  saveArrangement(projectId, { sizes: { preset: tab.preset ?? 'auto', value: next } })
}

// × do "Espaço livre": tira o espaço do layout desta aba; os vizinhos crescem. Sempre sobra um espaço.
export function removeSlot(projectId: string, tabId: string, slot: number): void {
  const tab = layoutOf(projectId).tabs.find((t) => t.id === tabId)
  const p = presetOf(tab?.preset)
  if (!tab || !p) return
  const { cells, fixed } = tabCells(tab)
  if (!fixed || cells[slot] !== null || tab.removed?.includes(slot) || tabCapacity(tab) <= 1) return
  // Divisórias mudam de forma: volta às proporções do layout.
  updateTab(projectId, tabId, { removed: [...(tab.removed ?? []), slot], order: cells, sizes: undefined })
}

// Solta o terminal `id` sobre o espaço `target` da aba (centro: troca; borda: antes/depois).
export function moveSession(projectId: string, tabId: string, id: string, target: number, zone: DropZone): void {
  const tab = layoutOf(projectId).tabs.find((t) => t.id === tabId)
  if (!tab) return
  const { cells } = tabCells(tab)
  if (!cells.includes(id)) return
  updateTab(projectId, tabId, { order: moveInSlots(cells, id, target, zone) })
}

// Abre uma sessão num espaço vazio escolhido do layout.
export async function spawnAt(projectId: string, tabId: string, slot: number, agent: Agent): Promise<void> {
  const info = await spawn(projectId, agent)
  if (!info) return
  const tab = layoutOf(projectId).tabs.find((t) => t.id === tabId)
  const p = presetOf(tab?.preset)
  if (!tab || !p || !tab.sessionIds.includes(info.id)) return
  const slots = arrange(p, tab.order, cellIds(tab), tab.removed)
  if (!slots) return
  const from = slots.indexOf(info.id)
  if (from >= 0 && from !== slot && slots[slot] === null) {
    slots[from] = null
    slots[slot] = info.id
  }
  updateTab(projectId, tabId, { order: slots })
}

export async function closePane(id: string): Promise<void> {
  await api().invoke('sessions:dispose', id)
}

export function focusedId(): string | null {
  return get().focusedSessionId
}

export async function openBrowser(projectId: string, url?: string, opts: { keepTab?: boolean } = {}): Promise<void> {
  const r = await api().invoke('browser:open', projectId, url)
  if ('error' in r) {
    toast(r.error, 'error')
    return
  }
  set({ browser: { ...get().browser, [projectId]: { ...r, open: true } } })
  if (!opts.keepTab) setDock(projectId, { open: true, tab: 'browser' })
}

// Ordem explícita (▶ Rodar, ou um Claude usando o navegador): navega se houver url e MOSTRA o painel —
// no espaço App do layout, se houver, senão no dock (mesmo com o Agente aberto).
const byTimers = new Map<string, ReturnType<typeof setTimeout>>()
export async function showBrowser(projectId: string, url?: string, by?: string): Promise<void> {
  if (by) {
    set({ browserBy: { ...get().browserBy, [projectId]: by } })
    clearTimeout(byTimers.get(projectId))
    byTimers.set(projectId, setTimeout(() => {
      const { [projectId]: _, ...rest } = get().browserBy
      set({ browserBy: rest })
    }, 6000))
  }
  const cur = get().browser[projectId]
  const dock = get().dock[projectId]
  const inLayout = appInLayout(projectId)
  // Sem url e já à vista: nada a fazer (evita trabalho a cada ação do Claude).
  if (!url && cur?.open && (inLayout || (dock?.open && dock.tab === 'browser'))) return
  await openBrowser(projectId, url, { keepTab: inLayout })
}

export function closeBrowser(projectId: string): void {
  void api().invoke('browser:action', projectId, 'close')
  const cur = get().browser[projectId]
  if (cur) set({ browser: { ...get().browser, [projectId]: { ...cur, open: false } } })
  if (get().dock[projectId]?.tab === 'browser') setDock(projectId, { open: false })
}

export function toggleDock(projectId: string, tab: 'agent' | 'browser'): void {
  if (tab === 'browser' && appInLayout(projectId)) {
    toast('O app está num espaço do layout. Use o × no cabeçalho dele para trazê-lo de volta ao painel lateral.')
    return
  }
  const d = get().dock[projectId]
  if (d?.open && d.tab === tab) setDock(projectId, { open: false })
  else if (tab === 'browser' && !get().browser[projectId]?.open) void openBrowser(projectId)
  else setDock(projectId, { open: true, tab })
  if (tab === 'agent') void loadAgentSummaries(projectId)
}

// ---- Agente ----

export async function refreshAgentConfig(): Promise<void> {
  const r = await api().invoke('agent:providers')
  const cfg = get().agentConfig
  // Sem escolha anterior: a assinatura do Claude (se instalada), depois a primeira chave configurada.
  const provider = r.lastProvider ?? r.providers.find((p) => p.configured && (p.id === 'claudecode' || p.needsKey))?.id ?? cfg.provider
  const info = r.providers.find((p) => p.id === provider)
  set({ agentConfig: { ...cfg, providers: r.providers, provider, model: info?.lastModel || info?.defaultModel || cfg.model, encryption: r.encryption, loaded: true } })
}

// Primeiro uso do Agente na sessão: só então o main abre o Keychain.
export function ensureAgentConfig(): void {
  if (!get().agentConfig.loaded) void refreshAgentConfig()
}

// silent: o erro fica no próprio seletor (ex.: Ollama fechado), sem aviso flutuante.
export async function loadAgentModels(provider: AgentProviderId, opts: { silent?: boolean } = {}): Promise<void> {
  const r = await api().invoke('agent:models', provider)
  const cfg = get().agentConfig
  if ('error' in r) {
    if (!opts.silent) toast(r.error, 'error')
    set({ agentConfig: { ...cfg, modelErrors: { ...cfg.modelErrors, [provider]: r.error } } })
    return
  }
  const modelErrors = { ...cfg.modelErrors }
  delete modelErrors[provider]
  set({ agentConfig: { ...cfg, models: { ...cfg.models, [provider]: r.models }, modelErrors } })
}

export function selectAgentModel(provider: AgentProviderId, model: string): void {
  set({ agentConfig: { ...get().agentConfig, provider, model } })
}

export async function loadAgentSummaries(projectId: string): Promise<void> {
  const summaries = await api().invoke('agent:conversations', projectId)
  setAgentPane(projectId, { summaries })
}

export async function openConversation(projectId: string, id: string | null): Promise<void> {
  if (!id) {
    setAgentPane(projectId, { conversationId: undefined, conversation: undefined, streaming: undefined })
    return
  }
  const conversation = await api().invoke('agent:load', projectId, id)
  if (conversation) setAgentPane(projectId, { conversationId: id, conversation, streaming: undefined })
}

export async function deleteConversation(projectId: string, id: string): Promise<void> {
  await api().invoke('agent:delete', projectId, id)
  if (agentPane(projectId).conversationId === id) await openConversation(projectId, null)
  await loadAgentSummaries(projectId)
}

export async function sendToAgent(projectId: string): Promise<void> {
  const pane = agentPane(projectId)
  const text = pane.draft.trim()
  if (!text || pane.streaming) return
  const { provider, model } = get().agentConfig
  const r = await api().invoke('agent:send', {
    projectId, conversationId: pane.conversationId, provider, model, text, attachments: pane.attachments,
  })
  if ('error' in r) {
    toast(r.error, 'error')
    return
  }
  setAgentPane(projectId, { draft: '', attachments: [] })
}

export function stopAgent(projectId: string): void {
  const id = agentPane(projectId).conversationId
  if (id) void api().invoke('agent:stop', id)
}

function onAgentEvent(ev: AgentEvent): void {
  const pid = ev.projectId
  const pane = agentPane(pid)
  switch (ev.type) {
    case 'start': {
      const now = Date.now()
      const conversation =
        pane.conversation && pane.conversation.id === ev.conversationId
          ? { ...pane.conversation, messages: [...pane.conversation.messages, ev.user] }
          : { id: ev.conversationId, projectId: pid, title: ev.title, createdAt: now, updatedAt: now, messages: [ev.user] }
      setAgentPane(pid, { conversationId: ev.conversationId, conversation, streaming: { messageId: ev.messageId, text: '', thinking: '', tools: [] } })
      break
    }
    case 'text':
    case 'thinking':
    case 'tool':
    case 'notice': {
      const s = pane.streaming
      if (!s || s.messageId !== ev.messageId) return
      if (ev.type === 'text') setAgentPane(pid, { streaming: { ...s, text: s.text + ev.delta } })
      else if (ev.type === 'thinking') setAgentPane(pid, { streaming: { ...s, thinking: s.thinking + ev.delta } })
      else if (ev.type === 'notice') setAgentPane(pid, { streaming: { ...s, notice: s.notice ? `${s.notice}\n${ev.text}` : ev.text } })
      else {
        const tools = s.tools.some((t) => t.id === ev.call.id) ? s.tools.map((t) => (t.id === ev.call.id ? ev.call : t)) : [...s.tools, ev.call]
        setAgentPane(pid, { streaming: { ...s, tools } })
      }
      break
    }
    case 'done':
      if (pane.conversationId === ev.conversationId) {
        appendMessage(pid, ev.message)
        setAgentPane(pid, { streaming: undefined })
      }
      void loadAgentSummaries(pid)
      break
    case 'approval':
      setAgentPane(pid, { approvals: [...(pane.approvals ?? []), ev.approval] })
      break
    case 'approvalDone':
      setAgentPane(pid, { approvals: (pane.approvals ?? []).filter((a) => a.id !== ev.id) })
      break
  }
}

export function answerApproval(id: string, ok: boolean): void {
  void api().invoke('agent:approve', id, ok)
}

export function openPreview(path: string): void {
  set({ overlay: 'preview', previewPath: path })
}

export async function openInCursor(path: string, line?: number): Promise<void> {
  const r = await api().invoke('projects:openInCursor', path, line)
  if (!r.ok) toast(r.error ?? 'Não foi possível abrir no Cursor.', 'error')
}

export async function insertPath(path: string): Promise<void> {
  const id = get().focusedSessionId ?? activeTab(get().activeProjectId ?? '').sessionIds[0]
  if (!id) {
    toast('Abra um terminal para inserir o caminho.')
    return
  }
  const ok = await api().invoke('sessions:insertPath', id, path)
  if (ok) focusTerminal(id)
}

export function nextNeedsMe(): void {
  const list = needsMeOrder(Object.values(get().sessions)).filter((s) => s.lifecycle === 'running' && needsMe(s.activity))
  if (!list.length) {
    toast('Nenhuma sessão precisa de você agora.')
    return
  }
  const cur = get().focusedSessionId
  const idx = list.findIndex((s) => s.id === cur)
  focusSession(list[(idx + 1) % list.length].id)
}

function cyclePane(dir: 1 | -1): void {
  const pid = get().activeProjectId
  if (!pid) return
  const ids = activeTab(pid).sessionIds
  if (!ids.length) return
  const idx = ids.indexOf(get().focusedSessionId ?? '')
  focusSession(ids[(idx + dir + ids.length) % ids.length])
}

export async function refreshGit(projectId: string): Promise<void> {
  await api().invoke('git:refresh', projectId, true)
}

export async function gitAction(projectId: string, action: 'pull' | 'push' | 'claude'): Promise<void> {
  const size = guessSize()
  const r = await api().invoke('git:action', projectId, action, size.cols, size.rows)
  if ('error' in r) toast(r.error, 'error')
}

export async function runLaunchTarget(projectId: string, targetId: string): Promise<void> {
  const size = guessSize()
  const r = await api().invoke('launch:run', projectId, targetId, size.cols, size.rows)
  if ('error' in r) toast(r.error, 'error')
}

export async function invokeMod(modId: string, actionId: string): Promise<void> {
  const r = await api().invoke('mods:invoke', modId, actionId, {
    projectId: get().activeProjectId ?? undefined,
    sessionId: get().focusedSessionId ?? undefined,
  })
  if (!r.ok) toast(r.error ?? 'O mod não respondeu.', 'error')
}

export async function setFont(delta: number): Promise<void> {
  const prefs = await api().invoke('prefs:set', { fontSize: get().prefs.fontSize + delta })
  set({ prefs })
  setFontSize(prefs.fontSize)
}

export async function refreshUpdateStatus(): Promise<void> {
  set({ updateStatus: await api().invoke('update:status') })
}

/** "Atualizar Cockpit": recompila do código, instala e reabre; o cartão no topo esquerdo mostra as etapas. */
export async function startUpdate(): Promise<void> {
  const r = await api().invoke('update:start')
  if ('error' in r) toast(r.error)
  else set({ update: r })
  void refreshUpdateStatus()
}

export async function runCommand(cmd: string): Promise<void> {
  const pid = get().activeProjectId
  const fid = get().focusedSessionId
  const [name, ...rest] = cmd.split(':')
  switch (name) {
    case 'palette':
      set({ overlay: get().overlay === 'palette' ? null : 'palette' })
      break
    case 'mods':
      set({ overlay: 'mods' })
      break
    case 'claudeMods':
      set({ overlay: 'claudeMods', claudeModsFor: null })
      break
    case 'prefs':
      set({ overlay: 'prefs' })
      break
    case 'components':
      set({ overlay: 'components' })
      break
    case 'usage':
      set({ overlay: get().overlay === 'usage' ? null : 'usage' })
      break
    case 'update':
      void startUpdate()
      break
    case 'grid':
      set({ view: get().view === 'grid' ? 'project' : 'grid' })
      break
    case 'sidebar':
      setUi({ sidebar: !get().ui.sidebar })
      break
    case 'tree':
      setUi({ tree: !get().ui.tree })
      break
    case 'browser':
      if (pid) toggleDock(pid, 'browser')
      break
    case 'maximize': {
      if (!pid) break
      const tab = activeTab(pid)
      const cells = cellIds(tab)
      const item = tab.maximized ?? (cells.includes(get().focusedSessionId ?? '') ? get().focusedSessionId! : cells[0])
      if (item) toggleMaximize(pid, tab.id, item)
      break
    }
    case 'agent':
      if (pid) toggleDock(pid, 'agent')
      break
    case 'newTab':
      if (pid) newTab(pid)
      break
    case 'split':
      await split((rest[0] as Agent) || 'shell')
      break
    case 'interrupt':
      if (fid) void api().invoke('sessions:interrupt', fid)
      break
    case 'kill':
      if (fid) void api().invoke('sessions:kill', fid)
      break
    case 'nextNeedsMe':
      nextNeedsMe()
      break
    case 'prevPane':
      cyclePane(-1)
      break
    case 'nextPane':
      cyclePane(1)
      break
    case 'find':
      if (fid) set({ overlay: 'find' })
      break
    case 'clear':
      if (fid) clearTerminal(fid)
      break
    case 'copy': {
      const text = fid ? selection(fid) : ''
      if (text && document.activeElement?.classList.contains('xterm-helper-textarea')) await navigator.clipboard.writeText(text)
      // Fora do terminal (inputs, prévia, painéis de mod): o main copia do frame focado.
      else void api().invoke('ui:edit', 'copy')
      break
    }
    case 'selectAll':
      if (fid && document.activeElement?.classList.contains('xterm-helper-textarea')) selectAll(fid)
      else void api().invoke('ui:edit', 'selectAll')
      break
    case 'fontUp':
      await setFont(1)
      break
    case 'fontDown':
      await setFont(-1)
      break
    case 'project': {
      const p = sidebarOrder()[Number(rest[0])]
      if (p) selectProject(p.id)
      break
    }
    case 'spawn': {
      // spawn:<projectId codificado>:<agent>
      const agent = rest[1] as Agent
      const projectId = decodeURIComponent(rest[0] ?? '')
      if (projectId && AGENT_LABEL[agent]) await spawn(projectId, agent)
      break
    }
    case 'open': {
      // open:<projectId codificado> — pedido do Hermes: mostra o projeto; sem sessão rodando, abre o último agente.
      const projectId = decodeURIComponent(rest[0] ?? '')
      const p = get().projects.find((x) => x.id === projectId)
      if (!p) break
      selectProject(p.id)
      const running = Object.values(get().sessions).some((s) => s.projectId === p.id && s.lifecycle === 'running')
      if (!running) await spawn(p.id, p.lastAgent ?? 'claude')
      break
    }
    case 'launch': {
      const projectId = decodeURIComponent(rest[0] ?? '')
      const target = decodeURIComponent(rest[1] ?? '')
      if (projectId && target) await runLaunchTarget(projectId, target)
      else if (projectId) toast('Use o botão ▶ do projeto para escolher o que rodar.')
      break
    }
  }
}

// Mesma ordem da barra lateral: favoritos, depois as divisões do usuário, depois o resto.
export function sidebarOrder() {
  const ps = get().projects
  const rest = ps.filter((p) => !p.favorite)
  return [
    ...ps.filter((p) => p.favorite),
    ...get().groups.flatMap((g) => rest.filter((p) => p.group === g.id)),
    ...rest.filter((p) => !p.group),
  ]
}

export async function saveGroups(groups: SidebarGroup[]): Promise<void> {
  set({ groups: await api().invoke('groups:set', groups) })
}

export async function moveToGroup(projectId: string, group: string | null): Promise<void> {
  await api().invoke('projects:update', projectId, { group })
}

// Cria a divisão já com o nome em edição na barra lateral; opcionalmente leva uma pasta junto.
export async function newGroup(projectId?: string): Promise<void> {
  const id = `g-${Date.now().toString(36)}`
  await saveGroups([...get().groups, { id, name: 'Nova divisão' }])
  if (projectId) await moveToGroup(projectId, id)
  set({ renamingGroup: id })
}
