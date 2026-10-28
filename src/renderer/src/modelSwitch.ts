import { create } from 'zustand'
import type { SessionInfo } from '@shared/types'
import {
  AUTO_MOD, CODEX_KEYS, type CodexModel, type ModelCatalog, type ModelChange, claudeCommands, codexEffortKeys, codexModelKey, codexScreen,
  parseCodexFooter, promptState,
} from '@shared/modelSwitch'
import { actions, toast, useStore } from './state/store'
import { restartClaude } from './controller'
import { screenState } from './terminal/registry'

// Rodapé de modelo: o que cada painel escolheu, a troca pendente e o catálogo (lido do main ao abrir).
export interface PaneModel {
  model?: string
  effort?: string
  auto?: boolean
  pending?: ModelChange
  // Sendo digitada agora. O rodapé mostra applying + pending na hora do clique; se a troca falhar, volta.
  applying?: ModelChange
  busy?: boolean
  // Auto numa sessão aberta sem o mod: reinicia retomando a conversa quando ela parar.
  restart?: boolean
}

/** O que o rodapé mostra: a escolha mais recente, mesmo antes de chegar à sessão. */
export function shownChoice(pane: PaneModel | undefined): ModelChange {
  return { ...pane?.applying, ...pane?.pending }
}

interface ModelsState {
  catalog: ModelCatalog | null
  panes: Record<string, PaneModel>
}

export const useModels = create<ModelsState>(() => ({ catalog: null, panes: {} }))

const patchPane = (id: string, p: Partial<PaneModel>) =>
  useModels.setState((s) => ({ panes: { ...s.panes, [id]: { ...s.panes[id], ...p } } }))

let catalogLoad: Promise<void> | null = null
export function loadCatalog(force = false): Promise<void> {
  if (!catalogLoad || force) {
    catalogLoad = window.cockpit.invoke('models:catalog').then(
      (catalog) => useModels.setState({ catalog }),
      () => { catalogLoad = null },
    )
  }
  return catalogLoad
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const write = (id: string, data: string) => window.cockpit.send('pty:write', id, data)
const agentOf = (s: SessionInfo) => s.foreground ?? s.agent
const isBusy = (s: SessionInfo) => s.activity === 'working' || s.activity === 'needs_approval'

/** Pede uma troca. Com a sessão trabalhando ela espera; as escolhas seguidas se juntam numa só. */
export function requestModelChange(id: string, change: ModelChange): void {
  const pane = useModels.getState().panes[id]
  patchPane(id, { pending: { ...pane?.pending, ...change } })
  void flush(id)
}

/**
 * Auto numa sessão que abriu sem o mod auto-modelo (o /auto-modelo não existe nela): liga o mod,
 * reinicia retomando a mesma conversa (--resume, nada se perde) e liga o Automático na sessão nova.
 */
export function enableAutoAndRestart(id: string): void {
  patchPane(id, { restart: true, pending: undefined })
  void flush(id)
}

async function flush(id: string): Promise<void> {
  const pane = useModels.getState().panes[id]
  const session = actions.get().sessions[id]
  if (!(pane?.pending || pane?.restart) || pane.busy) return
  if (!session || session.lifecycle !== 'running') return patchPane(id, { pending: undefined, restart: undefined })
  if (isBusy(session)) return // volta quando a sessão parar (ouvinte abaixo)

  const scr = screenState(id)
  // Nunca digita por cima de um rascunho: o comando grudaria no texto e seria enviado junto.
  // Reiniciar também apagaria o rascunho.
  if (!scr || promptState(scr.cursorLine, scr.cursorX) !== 'empty') {
    patchPane(id, { pending: undefined, restart: undefined })
    toast('Há texto no prompt (ou um menu aberto). Envie ou apague e escolha de novo.', 'error')
    return
  }
  if (pane.restart) {
    patchPane(id, { restart: undefined, busy: true })
    try {
      await restartWithAuto(id)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      patchPane(id, { busy: false })
    }
    return
  }
  const change = pane.pending
  if (!change) return
  patchPane(id, { pending: undefined, applying: change, busy: true })
  try {
    if (agentOf(session) === 'codex') await applyCodex(id, change)
    else await applyClaude(id, change)
  } catch (e) {
    toast((e as Error).message, 'error')
  } finally {
    patchPane(id, { busy: false, applying: undefined })
  }
  // Algo escolhido enquanto aplicava: vai na sequência.
  if (useModels.getState().panes[id]?.pending) void flush(id)
}

// Sessão saiu de "trabalhando": aplica o que estava esperando.
useStore.subscribe((s, prev) => {
  if (s.sessions === prev.sessions) return
  for (const [id, pane] of Object.entries(useModels.getState().panes)) {
    if ((pane.pending || pane.restart) && !pane.busy && s.sessions[id] !== prev.sessions[id]) void flush(id)
  }
})

// ---- Claude: ligar o Automático reiniciando a sessão ----

async function restartWithAuto(id: string): Promise<void> {
  const snap = await window.cockpit.invoke('claudeMods:snapshot')
  if (!snap.mods.some((m) => m.key === AUTO_MOD && m.enabled)) {
    const r = await window.cockpit.invoke('claudeMods:setEnabled', AUTO_MOD, true)
    if (!('mods' in r)) throw new Error(r.error)
    void loadCatalog(true)
  }
  toast('Ligando o Automático: reiniciando e retomando a mesma conversa…')
  const next = await restartClaude(id)
  if (!next) throw new Error('Não consegui reiniciar esta sessão. Use "↻ Retomar conversa" no painel e ligue o Auto de novo.')
  patchPane(next, { applying: { auto: true }, busy: true })
  const ready = await waitPrompt(next)
  patchPane(next, { applying: undefined, busy: false })
  if (!ready) throw new Error('A conversa voltou, mas o prompt demorou a aparecer. Clique no Auto de novo.')
  requestModelChange(next, { auto: true })
}

// A sessão retomada está pronta para receber um comando: parada e com o prompt vazio.
async function waitPrompt(id: string, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const s = actions.get().sessions[id]
    if (!s || s.lifecycle !== 'running') return false
    const scr = screenState(id)
    if (scr && !isBusy(s) && promptState(scr.cursorLine, scr.cursorX) === 'empty') {
      // O prompt desenha antes dos comandos dos mods terminarem de carregar.
      await sleep(800)
      return true
    }
    await sleep(250)
  }
  return false
}

// ---- Claude: comandos no prompt (texto e Enter separados, senão vira colagem) ----

async function applyClaude(id: string, change: ModelChange): Promise<void> {
  // Haiku não tem esforço.
  const model = change.model ?? useModels.getState().panes[id]?.model
  const c = model === 'haiku' ? { ...change, effort: undefined } : change
  for (const cmd of claudeCommands(c)) {
    write(id, cmd)
    await sleep(150)
    write(id, '\r')
    await sleep(700)
  }
  patchPane(id, {
    ...(c.model !== undefined && { model: c.model }),
    ...(c.effort !== undefined && { effort: c.effort }),
    ...(c.auto !== undefined && { auto: c.auto }),
  })
}

// ---- Codex: pilota o menu do /model e aplica só nesta sessão (`s`; o Enter gravaria no config.toml) ----

async function waitScreen(id: string, ok: (lines: string[]) => boolean, ms = 3000): Promise<string[] | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const lines = screenState(id)?.lines
    if (lines && ok(lines)) return lines
    await sleep(100)
  }
  return null
}

// Volta dos menus até o prompt, um Esc por vez: dois Esc seguidos no prompt abrem "editar mensagem anterior".
async function escapeMenus(id: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const lines = screenState(id)?.lines
    if (!lines || codexScreen(lines) === 'other') return
    write(id, CODEX_KEYS.esc)
    await sleep(350)
  }
}

export function codexCurrent(id: string, models: CodexModel[]): { model?: string; effort?: string } | null {
  const lines = screenState(id)?.lines
  return lines ? parseCodexFooter(lines, models) : null
}

async function applyCodex(id: string, change: ModelChange): Promise<void> {
  const models = useModels.getState().catalog?.codex ?? []
  const now = codexCurrent(id, models)
  const slug = change.model ?? now?.model
  const model = models.find((m) => m.slug === slug)
  if (!model) throw new Error('Não encontrei este modelo na lista do Codex (~/.codex/models_cache.json).')
  const wanted = change.effort ?? now?.effort
  const effort = wanted && model.efforts.includes(wanted) ? wanted : (model.defaultEffort ?? model.efforts[0])
  const fail = async (what: string) => {
    await escapeMenus(id)
    throw new Error(`Não consegui trocar no Codex (${what}). Nada foi alterado.`)
  }

  write(id, '/model')
  await sleep(150)
  write(id, CODEX_KEYS.enter)
  let lines = await waitScreen(id, (l) => codexScreen(l) === 'models')
  if (!lines) return fail('o menu não abriu')
  const key = codexModelKey(lines, model)
  if (!key) return fail(`${model.name} não está no menu`)
  write(id, key)

  lines = await waitScreen(id, (l) => codexScreen(l) === 'efforts')
  if (!lines) return fail('a lista de esforço não abriu')
  let step = codexEffortKeys(lines, effort)
  if (!step) return fail(`esforço ${effort} indisponível`)
  write(id, step.keys)
  if (step.submenu) {
    lines = await waitScreen(id, (l) => codexScreen(l) === 'advanced')
    if (!lines) return fail('o submenu Max/Ultra não abriu')
    step = codexEffortKeys(lines, effort)
    if (!step) return fail(`esforço ${effort} indisponível`)
    write(id, step.keys)
  }
  if (!(await waitScreen(id, (l) => codexScreen(l) === 'other'))) return fail('o menu não fechou')
  patchPane(id, { model: model.slug, effort })
}
