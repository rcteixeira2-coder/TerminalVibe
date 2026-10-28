import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, protocol, session, shell, webContents,
  type IpcMainInvokeEvent, type MenuItemConstructorOptions,
} from 'electron'
import type { InvokeApi, InvokeChannel, MainEvents, EventChannel } from '@shared/ipc'
import { INVOKE_CHANNELS } from '@shared/ipc'
import type { Agent, GitState, SessionInfo, SpawnRequest, UpdateProgress } from '@shared/types'
import { AGENTS, UPDATE_STEPS, isDefaultBranch } from '@shared/types'
import { needsMe } from '@shared/status'
import { AUTO_MOD } from '@shared/modelSwitch'
import { SessionManager } from './pty/SessionManager'
import { startHookServer } from './status/hookServer'
import { startControlServer, type ControlServer } from './control/controlServer'
import { AttentionTracker, maskSecrets, pasteText, remoteControlName, RemoteScan, type ControlSession } from './control/protocol'
import { Store } from './store'
import { Projects } from './projects'
import { Notifier, claudeNotifierStatus, setClaudeNotifierMuted } from './notifier'
import { BrowserManager } from './browser'
import { fileResponse, listDir, preview, resolvePreviewRequest, resolveTerminalPath } from './files'
import { scanLaunchTargets } from './launchTargets'
import { ModsHost, MODS_DIR } from './mods'
import { CLAUDE_MODS_DIR, claudeModsSnapshot, setClaudeModEnabled } from './claudeMods'
import { modelCatalog } from './modelCatalog'
import { buildEnv, hasControlChars, isInside, isLocalUrl, quotePath, validateLink } from './security'
import { gitEnv, safeBranch } from './git'
import { GitWatcher } from './gitWatcher'
import { AgentManager, PROVIDERS } from './agent/AgentManager'
import { UsageManager } from './usage/UsageManager'
import type { AgentProviderId } from '@shared/types'
import { UUID_RE } from './pty/SessionManager'
import { resolveBinary } from './pty/launch'
import { McpBridge } from './agent/mcpBridge'
import { BROWSER_TOOL_DEFS, runBrowserTool, type BrowserToolDeps } from './browserTools'
import { isAvailable as updateAvailable, runUpdate, scheduleRelaunch, sourceRoot } from './appUpdate'

app.setName('Cockpit')

protocol.registerSchemesAsPrivileged([
  { scheme: 'preview', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  { scheme: 'mod', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// Segunda instância: sai na hora. Sem isso ela seguiria até o whenReady, abriria outra janela
// e apagaria o socket de hooks da instância que está rodando.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.exit(0)

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'resources') : join(app.getAppPath(), 'resources')
const store = new Store(join(app.getPath('userData'), 'cockpit.json'))
const projects = new Projects(store)
const token = randomBytes(24).toString('hex')
// Caminho curto (limite de 104 bytes para sockets Unix).
const sockPath = join(app.getPath('userData'), 'run', 'hooks.sock')
// Canal do Hermes: socket próprio e outro token (o dos hooks vai para o ambiente de todo terminal).
const controlSockPath = join(app.getPath('userData'), 'run', 'control.sock')
const controlTokenPath = join(app.getPath('userData'), 'run', 'control.token')
const controlToken = randomBytes(24).toString('hex')
// O Claude grava arquivos dentro da pasta do plugin (tipos dos módulos): usa uma cópia na pasta de dados,
// nunca a de dentro do app assinado.
const pluginDir = existsSync(join(resourcesDir, 'claude-plugin', 'hooks', 'hooks.json'))
  ? syncPlugin(join(resourcesDir, 'claude-plugin'), join(app.getPath('userData'), 'claude-plugin'))
  : null

function syncPlugin(src: string, dst: string): string {
  try {
    cpSync(src, dst, { recursive: true, force: true })
    return dst
  } catch {
    return src
  }
}

let win: BrowserWindow | null = null
let quitting = false
let visibleSessions = new Set<string>()
let sleepBlocker: number | null = null
let loginEnv: Record<string, string> | undefined
let envReady: Promise<unknown> = Promise.resolve()
let started = false
// A janela foi fechada (escondida) estando em tela cheia.
let reopenFullScreen = false
let crashTimes: number[] = []

// Servidor MCP local (127.0.0.1, token por uso): ferramentas do Agente e o navegador das sessões do Claude.
const bridge = new McpBridge()

const sessions: SessionManager = new SessionManager({
  projectPath: (id) => projects.path(id),
  // Só em desenvolvimento/testes: um `claude` falso no lugar do real.
  binaryOverride: !app.isPackaged && process.env.COCKPIT_TEST_CLAUDE_BIN ? { claude: process.env.COCKPIT_TEST_CLAUDE_BIN } : undefined,
  browserMcp: (sessionId, projectId) =>
    bridge.registerSync(
      {
        tools: BROWSER_TOOL_DEFS,
        runTool: (name, input) => runBrowserTool(browserToolDeps, projectId, sessions.get(sessionId)?.title ?? 'Claude', name, input),
        onTool: () => {},
      },
      'cockpit_browser',
    ),
  autoModelo: () => claudeModsSnapshot().mods.some((m) => m.key === AUTO_MOD && m.enabled),
  version: app.getVersion(),
  sock: sockPath,
  token,
  pluginDir,
  get loginEnv() {
    return loginEnv
  },
  oscStatus: () => store.data.prefs.oscStatus,
})

const gitWatcher = new GitWatcher({
  projects: () => projects.list(),
  env: () => gitEnv(buildEnv(process.env, { paneId: '', sock: '', token: '', version: '', login: loginEnv }).PATH, homedir()),
})

// A janela pode estar destruída (saída do app) enquanto sessões ainda emitem eventos.
function liveWin(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

function send<K extends EventChannel>(channel: K, ...args: Parameters<MainEvents[K]>): void {
  liveWin()?.webContents.send(channel, ...args)
}

// Ambiente do `claude -p` do agente: mesma lista branca dos terminais, sem as variáveis do Cockpit.
function claudeEnv(): Record<string, string> {
  const env = buildEnv(process.env, { paneId: '', sock: '', token: '', version: app.getVersion(), login: loginEnv })
  for (const k of ['COCKPIT_PANE_ID', 'COCKPIT_SOCK', 'COCKPIT_TOKEN', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION']) delete env[k]
  return env
}

// Só em desenvolvimento/testes: apontar provedores do agente para um servidor local falso.
const agentOverride = !app.isPackaged && process.env.COCKPIT_AGENT_TEST_BASEURL ? JSON.parse(process.env.COCKPIT_AGENT_TEST_BASEURL) : undefined
const agent = new AgentManager({
  userData: app.getPath('userData'),
  projectRoot: (id) => projects.path(id),
  projectName: (id) => projects.get(id)?.name ?? 'projeto',
  sessions: (projectId) =>
    sessions
      .list()
      .filter((s) => s.projectId === projectId && s.lifecycle === 'running')
      .map((s) => ({ id: s.id, title: s.taskTitle ? `${s.title} — ${s.taskTitle}` : s.title, agent: s.foreground ?? s.agent })),
  tail: (id, n) => sessions.tail(id, n),
  emit: (ev) => send('agent:event', ev),
  bridge,
  claudeCode: {
    binary: () => resolveBinary('claude', claudeEnv().PATH),
    env: claudeEnv,
  },
  baseUrlOverride: agentOverride,
})
// Conversas do agente: só de um projeto conhecido.
const isAgentScope = (id: unknown): boolean => !!projects.get(String(id))
const isProvider = (id: unknown): id is AgentProviderId => typeof id === 'string' && PROVIDERS.some((p) => p.id === id)

const notifier = new Notifier(() => store.data.prefs, (id) => focusSession(id))

const browser = new BrowserManager(() => liveWin(), (id) => projects.path(id), (s) => send('browser:state', s))

const mods = new ModsHost(
  {
    sessions: () => sessions.list(),
    projectName: (id) => projects.get(id)?.name,
    write: (id, text) => {
      if (!sessions.isRunning(id)) return false
      sessions.write(id, text)
      sessions.markModTyped(id)
      return true
    },
    notify: (title, body) => notifier.show(title, body),
    spawn: (projectId, agent) => send('ui:command', `spawn:${encodeURIComponent(projectId)}:${agent}`),
    openUrl: (projectId, url) => {
      const r = browser.open(projectId, url)
      if (!('error' in r)) send('browser:detected', projectId, r.url)
    },
    launch: (projectId, target) => {
      const t = target || store.meta(projectId).launchTarget || ''
      send('ui:command', `launch:${encodeURIComponent(projectId)}:${encodeURIComponent(t)}`)
    },
    enabled: (id) => store.data.modsEnabled[id] !== false,
    setEnabled: (id, v) => {
      store.data.modsEnabled[id] = v
      store.save()
    },
    writeGranted: (id) => !!store.data.modWriteGrants[id],
    grantWrite: (id) => {
      store.data.modWriteGrants[id] = true
      store.save()
    },
    parentWindow: () => liveWin(),
    panelMessage: (modId, panelId, message) => send('mods:panelMessage', modId, panelId, message),
  },
  join(__dirname, '../preload/modhost.js'),
  join(resourcesDir, 'mods-examples'),
)

const usage = new UsageManager({
  userData: app.getPath('userData'),
  home: homedir(),
  secrets: agent.secrets,
  conversations: () => agent.allConversations(),
  onLimits: (card) => send('usage:limits', card),
  // Só em desenvolvimento/testes: Admin APIs falsas.
  adminBase: !app.isPackaged && process.env.COCKPIT_USAGE_TEST_BASEURL ? JSON.parse(process.env.COCKPIT_USAGE_TEST_BASEURL) : undefined,
})

// ---- eventos das sessões ----

sessions.on('data', (id, data) => {
  send('pty:data', id, data)
  scanRemote(id, data)
})
sessions.on('update', (info) => {
  send('session:update', info)
  if (info.lifecycle !== 'running') attention.clear(info.id)
})
sessions.on('removed', (id) => {
  launched.delete(id)
  remoteScans.delete(id)
  attention.clear(id)
  send('session:removed', id)
})
sessions.on('activity', (info, _prev, next) => {
  const seen = !!liveWin()?.isFocused() && visibleSessions.has(info.id)
  notifier.activity(info, projects.get(info.projectId), next, seen)
  mods.sessionEvent(info)
  updateDockBadge()
  attention.update(info.id, info.lifecycle === 'running' && (info.foreground ?? info.agent) !== 'shell' && needsMe(next))
  // O agente terminou uma tarefa (talvez um commit/push): relê o git do projeto.
  if (next === 'done' || next === 'your_turn') void gitWatcher.refresh(info.projectId)
})
sessions.on('notify', (info, text) => {
  const seen = !!liveWin()?.isFocused() && visibleSessions.has(info.id)
  notifier.program(info, projects.get(info.projectId), text, seen)
})
sessions.on('localUrl', (info, url) => {
  const run = launched.get(info.id)
  if (run) {
    run.lastUrl = url
    // Aberto pelo ▶ Rodar: o primeiro endereço sempre aparece (no Cockpit ou no navegador escolhido).
    if (run.reveal) {
      run.reveal = false
      revealUrl(info.projectId, url)
      return
    }
  }
  if (store.meta(info.projectId).openIn === 'external') {
    const safe = validateLink(url)
    if (safe && isLocalUrl(safe)) void shell.openExternal(safe)
    return
  }
  if (store.meta(info.projectId).browserHidden) return
  send('browser:detected', info.projectId, url)
})
sessions.on('workingChanged', (working) => {
  // Só impede o repouso por inatividade enquanto algo trabalha de fato (a tela ainda apaga).
  if (working && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
  if (!working && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker)
    sleepBlocker = null
  }
})

function updateDockBadge(): void {
  const n = sessions.list().filter((s) => s.lifecycle === 'running' && needsMe(s.activity)).length
  app.dock?.setBadge(n ? String(n) : '')
}

function focusSession(id: string): void {
  showWindow()
  send('ui:focusSession', id)
}

// ---- Hermes (canal de controle) ----

let control: ControlServer | null = null
// Interface ainda carregando (ex.: Cockpit aberto agora pelo Hermes): o comando espera o renderer:ready.
let rendererReady = false
let pendingCommands: string[] = []

function commandWhenReady(command: string): void {
  if (rendererReady) send('ui:command', command)
  else pendingCommands.push(command)
}
// Sessões do Hermes que ainda procuram o link do Remote Control na saída.
const remoteScans = new Map<string, RemoteScan>()

function scanRemote(id: string, data: string): void {
  const scan = remoteScans.get(id)
  if (!scan) return
  if (scan.expired()) return void remoteScans.delete(id)
  const found = scan.feed(data)
  if (!found) return
  remoteScans.delete(id)
  const projectPath = sessions.projectOf(id)
  if (projectPath) control?.broadcast({ event: 'remote', projectPath, message: found })
}

// Sessões do Claude abertas pelo Hermes neste projeto (as do Rodrigo nunca entram aqui).
function hermesSessions(projectId?: string): SessionInfo[] {
  return sessions.list().filter((s) => s.origin === 'hermes' && (!projectId || s.projectId === projectId))
}

// Sessão como o Hermes a vê (robô das sessões).
function controlSession(s: SessionInfo): ControlSession {
  const project = projects.get(s.projectId)
  const agentKind = s.foreground ?? s.agent
  return {
    id: s.id, projectPath: project?.path ?? s.projectId, projectName: project?.name ?? 'projeto', agent: agentKind,
    title: s.taskTitle ? `${s.title} — ${s.taskTitle}` : s.title, activity: s.activity,
    detail: s.activityDetail ? maskSecrets(s.activityDetail) : undefined,
    needsMe: agentKind !== 'shell' && needsMe(s.activity), origin: s.origin,
  }
}

function attentionInfo(id: string): Record<string, unknown> | null {
  const s = sessions.get(id)
  if (!s || s.lifecycle !== 'running') return null
  const c = controlSession(s)
  return { sessionId: c.id, projectPath: c.projectPath, projectName: c.projectName, agent: c.agent, title: c.title, detail: c.detail }
}

const attention = new AttentionTracker((event) => control?.broadcast(event), attentionInfo)

const NO_SESSION = { ok: false as const, error: 'Essa sessão não está mais aberta no Cockpit.' }

// A pasta vira projeto do Cockpit (Mesa ou adicionada); só diretórios que existem.
function hermesProject(path: string): string | null {
  return projects.add(path)?.id ?? null
}

const hermesHandler = {
  open: async (path: string) => {
    await envReady
    const id = hermesProject(path)
    if (!id) return { ok: false as const, error: 'Não encontrei a pasta do projeto. Ela foi movida ou apagada?' }
    showWindow()
    commandWhenReady(`open:${encodeURIComponent(id)}`)
    return { ok: true as const }
  },
  request: async (path: string, prompt: string, name: string) => {
    await envReady
    const id = hermesProject(path)
    if (!id) return { ok: false as const, error: 'Não encontrei a pasta do projeto. Ela foi movida ou apagada?' }
    const running = hermesSessions(id).find((s) => s.lifecycle === 'running')
    if (running) {
      // Acompanhamento: cola no mesmo Claude, como se o Rodrigo tivesse colado e apertado Enter.
      sessions.write(running.id, pasteText(prompt))
      setTimeout(() => sessions.isRunning(running.id) && sessions.write(running.id, '\r'), 150)
      return { ok: true as const }
    }
    const r = sessions.spawn({
      projectId: id, agent: 'claude', cols: 120, rows: 32, title: 'Claude · Hermes',
      initialPrompt: prompt, remoteControl: remoteControlName(name), origin: 'hermes',
    })
    if ('error' in r) return { ok: false as const, error: r.error }
    remoteScans.set(r.id, new RemoteScan())
    return { ok: true as const }
  },
  // Fim do pedido: encerra só o que o Hermes abriu ali; o painel fica com a saída para leitura.
  finish: async (path: string) => {
    const id = projects.get(path)?.id ?? hermesProject(path)
    if (id) await Promise.all(hermesSessions(id).filter((s) => s.lifecycle === 'running').map((s) => sessions.kill(s.id)))
    return { ok: true as const }
  },
  // Hermes bloqueado: as sessões dele param (o painel oferece "Retomar conversa"); as do Rodrigo seguem.
  interruptHermes: async () => {
    await Promise.all(hermesSessions().filter((s) => s.lifecycle === 'running').map((s) => sessions.kill(s.id)))
    return { ok: true as const }
  },
  // ---- robô das sessões: o Hermes lê e propõe; o Rodrigo confirma lá antes de qualquer `send` ----
  sessions: () => ({ ok: true as const, sessions: sessions.list().filter((s) => s.lifecycle === 'running').map(controlSession) }),
  tail: (id: string, lines: number) =>
    sessions.isRunning(id) ? { ok: true as const, text: maskSecrets(sessions.tail(id, lines)) } : NO_SESSION,
  // Uma mensagem colada (como o `request`), Enter separado depois. Uma letra ou dígito só (opção de menu)
  // vai como tecla: o Claude e o Codex escolhem a opção na própria tecla.
  send: (id: string, text: string, enter: boolean) => {
    if (!sessions.isRunning(id)) return NO_SESSION
    sessions.write(id, /^[0-9A-Za-z]$/.test(text) ? text : pasteText(text))
    if (enter) setTimeout(() => sessions.isRunning(id) && sessions.write(id, '\r'), 150)
    return { ok: true as const }
  },
  focus: (id: string) => {
    if (!sessions.get(id)) return NO_SESSION
    focusSession(id)
    return { ok: true as const }
  },
  connected: (push: (event: Record<string, unknown>) => void) => {
    for (const id of attention.current()) {
      const info = attentionInfo(id)
      if (info) push({ event: 'attention', ...info })
    }
  },
}

// ---- janela ----

function createWindow(): void {
  const saved = store.data.window
  win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 760,
    minHeight: 460,
    title: 'Cockpit',
    backgroundColor: '#16161e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.on('focus', () => gitWatcher.onFocus())
  win.on('close', (e) => {
    if (win) store.data.window = win.getNormalBounds()
    store.save()
    if (!quitting) {
      // Fechar só esconde: as sessões continuam.
      e.preventDefault()
      const w = win
      if (!w) return
      // Em tela cheia, esconder deixa o espaço da tela cheia preto: sai dela primeiro e esconde em seguida.
      if (w.isFullScreen()) {
        reopenFullScreen = true
        w.once('leave-full-screen', () => {
          if (!w.isDestroyed()) w.hide()
        })
        w.setFullScreen(false)
      } else w.hide()
    }
  })
  win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.on('will-navigate', (e, url) => {
    if (isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL!)) return
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safe = validateLink(url)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  // Painéis de mod (iframes) não podem sair de mod://.
  win.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !e.url.startsWith('mod://')) e.preventDefault()
  })
  // Fluxo só conta bytes depois que o renderer registra os ouvintes (renderer:ready).
  win.webContents.on('did-start-loading', () => {
    rendererReady = false
    sessions.setFlowEnabled(false)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    sessions.setFlowEnabled(false)
    if (quitting || details.reason === 'clean-exit') return
    const now = Date.now()
    crashTimes = crashTimes.filter((t) => now - t < 60_000)
    crashTimes.push(now)
    if (crashTimes.length > 3) {
      dialog.showErrorBox('Cockpit', 'A interface caiu várias vezes seguidas. As sessões continuam rodando; reabra o Cockpit se precisar.')
      return
    }
    browser.closeAll()
  gitWatcher.stop()
    const w = liveWin()
    if (isDev) void w?.loadURL(process.env.ELECTRON_RENDERER_URL!)
    else void w?.loadFile(join(__dirname, '../renderer/index.html'))
  })
  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  // Antes do whenReady terminar, a janela ainda vai ser criada por ele; saindo, não recria.
  if (!started || quitting) return
  if (!win || win.isDestroyed()) createWindow()
  else {
    win.show()
    win.focus()
    // Foi fechada em tela cheia: volta em tela cheia.
    if (reopenFullScreen) {
      reopenFullScreen = false
      win.setFullScreen(true)
    }
  }
}

// ---- IPC ----

type Handler<K extends InvokeChannel> = (e: IpcMainInvokeEvent, ...args: Parameters<InvokeApi[K]>) => ReturnType<InvokeApi[K]> | Promise<ReturnType<InvokeApi[K]>>

const handlers: { [K in InvokeChannel]: Handler<K> } = {
  'app:info': () => ({ version: app.getVersion(), home: app.getPath('home'), platform: process.platform, packaged: app.isPackaged }),
  'projects:list': () => projects.list(),
  'projects:add': async () => {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], defaultPath: projects.desktop, buttonLabel: 'Adicionar' }
    const w = liveWin()
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    return projects.add(r.filePaths[0])
  },
  'projects:remove': (_e, id) => projects.remove(String(id)),
  'projects:update': (_e, id, patch) => {
    const clean: Parameters<Projects['update']>[1] = {}
    if (typeof patch?.favorite === 'boolean') clean.favorite = patch.favorite
    if (typeof patch?.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) clean.color = patch.color
    if (patch?.lastAgent && AGENTS.includes(patch.lastAgent)) clean.lastAgent = patch.lastAgent
    if (patch?.openIn === 'cockpit' || patch?.openIn === 'external') clean.openIn = patch.openIn
    if (patch?.group === null) clean.group = undefined
    else if (typeof patch?.group === 'string' && store.data.groups.some((g) => g.id === patch.group)) clean.group = patch.group
    return projects.update(String(id), clean)
  },
  'groups:list': () => store.data.groups,
  'groups:set': (_e, groups) => {
    const seen = new Set<string>()
    const clean = (Array.isArray(groups) ? groups : [])
      .filter((g) => typeof g?.id === 'string' && /^[\w-]{1,64}$/.test(g.id) && typeof g.name === 'string' && !seen.has(g.id) && seen.add(g.id))
      .map((g) => ({ id: g.id, name: g.name.trim().slice(0, 40) || 'Divisão' }))
      .slice(0, 50)
    // Divisão excluída: as pastas dela voltam para as seções automáticas.
    for (const m of Object.values(store.data.meta)) if (m.group && !seen.has(m.group)) delete m.group
    store.data.groups = clean
    store.save()
    projects.refresh()
    return clean
  },
  'projects:reveal': (_e, id) => {
    const p = projects.path(String(id))
    if (p) shell.showItemInFolder(p)
  },
  'projects:close': async (e, id) => {
    const list = sessions.list().filter((s) => s.projectId === String(id))
    const running = list.filter((s) => s.lifecycle === 'running' || s.lifecycle === 'stopping')
    if (running.length) {
      const w = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        type: 'warning' as const,
        message: `Fechar ${projects.get(String(id))?.name ?? 'a pasta'}?`,
        detail: `${running.length === 1 ? '1 sessão ainda está rodando e será encerrada' : `${running.length} sessões ainda estão rodando e serão encerradas`}. A pasta volta para a Mesa.`,
        buttons: ['Fechar pasta', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
      }
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
      if (r.response !== 0) return false
    }
    await Promise.all(list.map((s) => sessions.dispose(s.id)))
    return true
  },
  'projects:openInCursor': (_e, path, line) => openInCursor(String(path), typeof line === 'number' ? line : undefined),
  'sessions:list': () => sessions.list(),
  'sessions:spawn': async (_e, req) => {
    await envReady
    return spawnSession(req)
  },
  'sessions:kill': (_e, id) => void sessions.kill(String(id)),
  'sessions:interrupt': (_e, id) => sessions.interrupt(String(id)),
  'sessions:dispose': (_e, id) => void sessions.dispose(String(id)),
  'sessions:buffer': (_e, id) => sessions.buffer(String(id)),
  'sessions:restorable': () => store.data.openSessions,
  'sessions:forgetRestorable': (_e, projectId) => {
    store.data.openSessions = store.data.openSessions.filter((s) => s.projectId !== projectId)
    store.save()
  },
  'sessions:insertPath': (_e, id, path) => {
    const sid = String(id)
    const p = String(path)
    // Arrastar do Finder pode trazer arquivos de fora do projeto (ex.: um print para o Claude); o caminho
    // precisa existir e não pode ter caracteres de controle, que virariam teclas no shell.
    if (!sessions.isRunning(sid) || !isAbsolute(p) || hasControlChars(p) || !existsSync(p)) {
      shell.beep()
      return false
    }
    sessions.write(sid, `${quotePath(p)} `)
    return true
  },
  'files:list': (_e, projectId, dir) => {
    const root = projects.path(String(projectId))
    return root ? listDir(root, String(dir || root)) : { error: 'Projeto indisponível.' }
  },
  'files:quickLook': (_e, projectId, path) => {
    const root = projects.path(String(projectId))
    const w = liveWin()
    if (!root || !w || !isInside(root, String(path))) return false
    w.previewFile(String(path))
    return true
  },
  'files:reveal': (_e, projectId, path) => {
    const root = projects.path(String(projectId))
    if (!root || !isInside(root, String(path))) return false
    shell.showItemInFolder(String(path))
    return true
  },
  'files:copyPath': (_e, projectId, path) => {
    const root = projects.path(String(projectId))
    if (!root || !isInside(root, String(path))) return false
    clipboard.writeText(String(path))
    return true
  },
  'files:preview': (_e, projectId, path) => {
    const root = projects.path(String(projectId))
    return root ? preview(root, String(projectId), String(path)) : { error: 'Projeto indisponível.' }
  },
  'files:resolveLink': (_e, sessionId, text) => {
    const sid = String(sessionId)
    const projectId = sessions.projectOf(sid)
    const root = projectId ? projects.path(projectId) : null
    const cwd = sessions.cwdOf(sid)
    if (!root || !cwd) return null
    return resolveTerminalPath(cwd, root, String(text))
  },
  'links:open': (_e, url) => {
    const safe = validateLink(String(url))
    if (!safe) return false
    void shell.openExternal(safe)
    return true
  },
  'git:states': () => gitWatcher.all(),
  'git:refresh': (_e, projectId, fetch) => gitWatcher.refresh(String(projectId), { fetch: !!fetch, force: !!fetch }),
  'git:action': async (_e, projectId, action, cols, rows) => {
    await envReady
    return gitAction(String(projectId), String(action), Number(cols), Number(rows))
  },
  'launch:targets': (_e, projectId) => {
    const root = projects.path(String(projectId))
    return root ? scanLaunchTargets(root) : []
  },
  'launch:run': async (_e, projectId, targetId, cols, rows) => {
    await envReady
    return runTarget(String(projectId), String(targetId), cols, rows)
  },
  'browser:open': (_e, projectId, url) => {
    store.setMeta(String(projectId), { browserHidden: false })
    return browser.open(String(projectId), url ? String(url) : undefined)
  },
  'browser:navigate': (_e, projectId, url) => browser.navigate(String(projectId), String(url)),
  'browser:action': (_e, projectId, action) => {
    if (action === 'close') store.setMeta(String(projectId), { browserHidden: true })
    browser.action(String(projectId), action)
  },
  'browser:bounds': (_e, projectId, rect) => browser.setBounds(String(projectId), rect),
  'browser:state': (_e, projectId) => browser.state(String(projectId)),
  'prefs:get': () => store.data.prefs,
  'prefs:set': (_e, patch) => {
    const p = store.data.prefs
    for (const k of ['sound', 'notifications', 'oscStatus', 'silentWhenNotifier'] as const) if (typeof patch?.[k] === 'boolean') p[k] = patch[k]!
    if (typeof patch?.fontSize === 'number') p.fontSize = Math.max(8, Math.min(22, Math.round(patch.fontSize)))
    sessions.setOscStatus(p.oscStatus)
    store.save()
    return p
  },
  'notifier:status': () => claudeNotifierStatus(),
  'notifier:mute': (_e, muted) => setClaudeNotifierMuted(!!muted),
  'mods:snapshot': () => mods.snapshot(),
  'mods:setEnabled': (_e, id, enabled) => mods.setEnabled(String(id), !!enabled),
  'mods:reload': () => {
    mods.load()
    return mods.snapshot()
  },
  'mods:invoke': (_e, modId, actionId, ctx) => mods.invoke(String(modId), String(actionId), {
    projectId: typeof ctx?.projectId === 'string' ? ctx.projectId : undefined,
    sessionId: typeof ctx?.sessionId === 'string' ? ctx.sessionId : undefined,
  }),
  'mods:openFolder': () => void shell.openPath(MODS_DIR),
  'claudeMods:snapshot': () => claudeModsSnapshot(),
  'claudeMods:setEnabled': (_e, key, enabled) => setClaudeModEnabled(String(key), !!enabled),
  'models:catalog': () => modelCatalog(),
  'claudeMods:openFolder': () => void shell.openPath(CLAUDE_MODS_DIR),
  'ui:contextMenu': (_e, kind, payload) => contextMenu(kind, payload),
  'ui:dockBadge': (_e, count) => app.dock?.setBadge(count > 0 ? String(count) : ''),
  'agent:providers': () => agent.providers(),
  'agent:setKey': async (_e, id, key) => {
    if (!isProvider(id)) return { ok: false, error: 'Provedor inválido.' }
    try {
      await agent.setKey(id, typeof key === 'string' ? key : null)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
  'agent:setBaseUrl': (_e, id, url) => {
    if (!isProvider(id)) return { ok: false, error: 'Provedor inválido.' }
    try {
      agent.setBaseUrl(id, typeof url === 'string' && url.trim() ? url.trim() : null)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
  'agent:test': (_e, id) => (isProvider(id) ? agent.test(id) : { ok: false, message: 'Provedor inválido.' }),
  'agent:models': (_e, id) => (isProvider(id) ? agent.models(id) : { error: 'Provedor inválido.' }),
  'agent:conversations': async (_e, projectId) => (isAgentScope(projectId) ? agent.conversations(String(projectId)) : []),
  'agent:load': (_e, projectId, id) => agent.load(String(projectId), String(id)),
  'agent:delete': (_e, projectId, id) => agent.delete(String(projectId), id === null ? null : String(id)),
  'agent:send': (_e, req) => {
    if (!req || !isAgentScope(req.projectId) || !isProvider(req.provider)) return { error: 'Pedido inválido.' }
    const attachments = Array.isArray(req.attachments)
      ? req.attachments
          .filter((a) => a && (a.kind === 'file' || a.kind === 'terminal'))
          .map((a) => ({ kind: a.kind, label: String(a.label ?? '').slice(0, 120), path: typeof a.path === 'string' ? a.path : undefined, sessionId: typeof a.sessionId === 'string' ? a.sessionId : undefined }))
      : []
    return agent.send({ projectId: String(req.projectId), conversationId: typeof req.conversationId === 'string' ? req.conversationId : undefined, provider: req.provider, model: String(req.model ?? ''), text: String(req.text ?? ''), attachments })
  },
  'agent:stop': (_e, conversationId) => agent.stop(String(conversationId)),
  'agent:approve': (_e, id, ok) => agent.approve(String(id), ok === true),
  'usage:report': (_e, period, force, secure) => usage.report(['today', '7d', '30d'].includes(period) ? period : '7d', !!force, !!secure),
  'usage:claudeCard': () => usage.claudeCard(),
  'usage:adminStatus': async () => ({ 'anthropic-admin': await agent.secrets.has('anthropic-admin'), 'openai-admin': await agent.secrets.has('openai-admin') }),
  'usage:setAdminKey': async (_e, id, key) => {
    if (id !== 'anthropic-admin' && id !== 'openai-admin') return { ok: false, error: 'Chave inválida.' }
    try {
      await agent.secrets.set(id, typeof key === 'string' ? key.slice(0, 400) : null)
      usage.clearAdminCache()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
  'usage:testAdmin': (_e, id) => (id === 'anthropic-admin' || id === 'openai-admin' ? usage.testAdmin(id) : { ok: false, message: 'Chave inválida.' }),
  'agent:findFiles': (_e, projectId, query) => agent.findFiles(String(projectId), String(query ?? '').slice(0, 100)),
  'files:resolveProjectPath': (_e, projectId, text) => {
    const root = projects.path(String(projectId))
    return root ? resolveTerminalPath(root, root, String(text)) : null
  },
  // Copiar/selecionar no frame focado (inclui iframes de painéis de mod).
  'ui:edit': (_e, action) => {
    const w = liveWin()
    if (!w) return
    if (action === 'copy') w.webContents.copy()
    else if (action === 'selectAll') w.webContents.selectAll()
  },
  'update:status': () => {
    const root = app.isPackaged ? sourceRoot() : null
    return {
      supported: !!root,
      available: updateAvailable(root),
      running: !!update && !update.failed,
      closingShells: sessions.list().filter((s) => s.agent === 'shell' && s.lifecycle === 'running').length,
    }
  },
  'update:start': () => startUpdate(),
  'update:relaunch': () => relaunchInstalled(),
}

function registerIpc(): void {
  for (const ch of INVOKE_CHANNELS) {
    ipcMain.handle(ch, (e, ...args) => {
      const w = liveWin()
      if (!w || e.sender !== w.webContents) throw new Error('origem inválida')
      return (handlers[ch] as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(e, ...args)
    })
  }
  const fromWin = (e: Electron.IpcMainEvent) => e.sender === liveWin()?.webContents
  ipcMain.on('pty:write', (e, id: string, data: string) => {
    if (fromWin(e) && typeof data === 'string' && data.length <= 1024 * 1024) sessions.write(String(id), data)
  })
  ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => {
    if (fromWin(e)) sessions.resize(String(id), Number(cols), Number(rows))
  })
  ipcMain.on('pty:ack', (e, id: string, bytes: number) => {
    if (fromWin(e)) sessions.ack(String(id), Number(bytes) || 0)
  })
  ipcMain.on('session:visible', (e, ids: string[]) => {
    if (fromWin(e) && Array.isArray(ids)) visibleSessions = new Set(ids.map(String))
  })
  ipcMain.on('renderer:ready', (e) => {
    if (!fromWin(e)) return
    sessions.setFlowEnabled(true)
    rendererReady = true
    for (const c of pendingCommands.splice(0)) send('ui:command', c)
  })
  ipcMain.on('mods:panelToMod', (e, modId: string, panelId: string, message: unknown) => {
    if (fromWin(e)) mods.panelToMod(String(modId), String(panelId), message)
  })
}

function spawnSession(req: SpawnRequest): SessionInfo | { error: string } {
  if (!req || !projects.get(String(req.projectId)) || !AGENTS.includes(req.agent)) return { error: 'Pedido inválido.' }
  let previous: { claudeSessionId?: string } | undefined
  if (req.resume && req.agent === 'claude') {
    // Retoma exatamente a conversa pedida; o id vira argumento, então só formato UUID.
    if (typeof req.claudeSessionId === 'string' && UUID_RE.test(req.claudeSessionId)) previous = { claudeSessionId: req.claudeSessionId }
  }
  const title = typeof req.title === 'string' ? req.title.slice(0, 80) : undefined
  const r = sessions.spawn(
    { projectId: req.projectId, agent: req.agent, resume: !!req.resume, cols: Number(req.cols), rows: Number(req.rows), title },
    previous,
  )
  if (!('error' in r)) {
    store.setMeta(req.projectId, { lastAgent: req.agent })
    if (req.resume) {
      const before = store.data.openSessions.length
      store.data.openSessions = store.data.openSessions.filter((s) =>
        previous?.claudeSessionId ? s.claudeSessionId !== previous.claudeSessionId : !(s.projectId === req.projectId && s.agent === req.agent),
      )
      if (store.data.openSessions.length !== before) store.save()
    }
  }
  return r
}

// Comandos do git montados aqui (nunca pelo renderer), num terminal visível do projeto.
async function gitAction(projectId: string, action: string, cols: number, rows: number): Promise<SessionInfo | { error: string }> {
  if (!projects.get(projectId)) return { error: 'Projeto indisponível.' }
  const st: GitState | null = await gitWatcher.refresh(projectId)
  let r: SessionInfo | { error: string }
  if (action === 'pull' || action === 'push') {
    if (st?.kind !== 'remote') return { error: 'Este projeto não está ligado ao GitHub.' }
    let cmd = 'git pull --ff-only'
    if (action === 'push') {
      // Na branch padrão nada sobe direto: o Claude cria uma branch e abre o PR.
      if (isDefaultBranch(st.branch)) return { error: 'Na main, suba pelo Claude (ele cria uma branch).' }
      if (st.upstream) cmd = 'git push'
      else if (safeBranch(st.branch) && !hasControlChars(st.branch)) cmd = `git push -u origin ${st.branch}`
      else return { error: 'Nome de branch inesperado; suba pelo Claude.' }
    }
    r = sessions.spawn({ projectId, agent: 'shell', cols, rows, title: action === 'pull' ? '↓ Baixar do GitHub' : '↑ Subir para o GitHub', initialInput: `${cmd}\r` })
  } else if (action === 'claude') {
    r = sessions.spawn({ projectId, agent: 'claude', cols, rows, title: 'GitHub', initialPrompt: '/UploadNoGithub' })
  } else return { error: 'Ação inválida.' }
  // O terminal não avisa quando o comando termina: relê o estado algumas vezes.
  if (!('error' in r)) for (const ms of [4000, 12_000, 30_000]) setTimeout(() => void gitWatcher.refresh(projectId), ms)
  return r
}

// Servidores abertos pelo ▶ Rodar: evita um segundo `npm run dev` e mostra o endereço assim que ele aparece.
const launched = new Map<string, { projectId: string; targetId: string; reveal: boolean; lastUrl?: string }>()

// Ordem explícita do usuário: abre no Cockpit (e mostra) ou no navegador escolhido para o projeto.
function revealUrl(projectId: string, url: string): void {
  if (store.meta(projectId).openIn === 'external') {
    const safe = validateLink(url)
    if (safe && isLocalUrl(safe)) void shell.openExternal(safe)
    return
  }
  store.setMeta(projectId, { browserHidden: false })
  send('browser:show', projectId, url)
}

// O /browser do mod terminal-browser: o xterm.js não desenha a página no terminal, então abre o navegador lateral.
// O endereço passa pelas mesmas regras do painel (localhost e arquivos do projeto).
function browserFromMod(paneId: string, p: { op?: unknown; url?: unknown }): void {
  const projectId = sessions.get(paneId)?.projectId
  if (!projectId) return
  if (p.op === 'open' && typeof p.url === 'string' && p.url) revealUrl(projectId, p.url)
  else if (p.op === 'show') {
    store.setMeta(projectId, { browserHidden: false })
    send('browser:show', projectId)
  } else if (p.op === 'back' || p.op === 'forward' || p.op === 'reload') browser.action(projectId, p.op)
}

const browserToolDeps: BrowserToolDeps = {
  open: (projectId, url) => {
    store.setMeta(projectId, { browserHidden: false })
    return browser.open(projectId, url)
  },
  action: (projectId, action) => browser.action(projectId, action),
  contents: (projectId) => browser.contents(projectId),
  shown: (projectId) => browser.shown(projectId),
  withPage: (projectId, fn) => browser.withPage(projectId, fn),
  logs: (projectId) => browser.logs(projectId),
  network: (projectId) => browser.network(projectId),
  show: (projectId, by) => send('browser:show', projectId, undefined, by),
}

function runTarget(projectId: string, targetId: string, cols: number, rows: number): SessionInfo | { error: string } | { ok: true } {
  const root = projects.path(projectId)
  if (!root) return { error: 'Projeto indisponível.' }
  const t = scanLaunchTargets(root).find((x) => x.id === targetId)
  if (!t) return { error: 'Alvo não encontrado.' }
  store.setMeta(projectId, { launchTarget: targetId })
  if (t.kind === 'app') {
    execFile('/usr/bin/open', [t.path])
    return { ok: true }
  }
  if (t.kind === 'page') {
    if (store.meta(projectId).openIn === 'external') {
      // O preview:// só existe dentro do Cockpit; fora, o Mac abre o arquivo no navegador padrão.
      execFile('/usr/bin/open', [t.path])
      return { ok: true }
    }
    const url = browser.pageUrl(projectId, t.path)
    if (!url) return { error: 'Página indisponível.' }
    revealUrl(projectId, url)
    return { ok: true }
  }
  // Já rodando (ex.: "dev" aberto antes): não sobe outro servidor na mesma porta.
  const running = [...launched.entries()].find(([id, l]) => l.projectId === projectId && l.targetId === targetId && sessions.isRunning(id))
  if (running) {
    const [id, l] = running
    send('ui:focusSession', id)
    if (l.lastUrl) revealUrl(projectId, l.lastUrl)
    else {
      l.reveal = true
      send('notice', `${t.title} já está rodando — o app abre assim que o endereço aparecer no terminal.`)
    }
    return { ok: true }
  }
  const r = sessions.spawn({ projectId, agent: 'shell', cols, rows, title: `▶ ${t.title}`, initialInput: `${t.command}\r` })
  if (!('error' in r)) launched.set(r.id, { projectId, targetId, reveal: true })
  return r
}

const CURSOR_CLI = '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'

function openInCursor(path: string, line?: number): { ok: boolean; error?: string } {
  const allowed = projects.list().some((p) => !p.missing && isInside(p.path, path))
  if (!allowed) return { ok: false, error: 'Fora dos projetos.' }
  if (line && existsSync(CURSOR_CLI)) {
    execFile(CURSOR_CLI, ['-g', `${path}:${line}`], { env: { PATH: '/usr/bin:/bin' } })
    return { ok: true }
  }
  if (!existsSync('/Applications/Cursor.app')) return { ok: false, error: 'Cursor não está instalado.' }
  execFile('/usr/bin/open', ['-a', 'Cursor', path])
  return { ok: true }
}

async function contextMenu(kind: 'file' | 'project' | 'session' | 'group', payload: Record<string, string>): Promise<string | null> {
  const w = liveWin()
  if (!w) return null
  // [id, rótulo, submenu?]: o submenu devolve o id do item escolhido dentro dele.
  type Item = [string, string, Item[]?]
  let groups: { id: string; name: string }[] = []
  try {
    groups = kind === 'project' && payload.groups ? JSON.parse(payload.groups) : []
  } catch {
    groups = []
  }
  const moveTo: Item[] = [
    ...groups.map((g): Item => [`group:${g.id}`, `${g.id === payload.group ? '✓ ' : ''}${g.name}`]),
    ...(groups.length ? ([['-', '']] as Item[]) : []),
    ['group:new', 'Nova divisão…'],
    ...(payload.group ? ([['group:none', 'Tirar da divisão']] as Item[]) : []),
  ]
  const items: Item[] =
    kind === 'file'
      ? [
          ['preview', 'Pré-visualizar'],
          ['quicklook', 'Quick Look'],
          ...(payload.html === '1' ? ([['browser', 'Ver no browser']] as [string, string][]) : []),
          ['-', ''],
          ['insert', 'Inserir caminho no terminal'],
          ['copy', 'Copiar caminho'],
          ['reveal', 'Mostrar no Finder'],
          ['cursor', 'Abrir no Cursor'],
        ]
      : kind === 'project'
        ? [
            ['favorite', payload.favorite === '1' ? 'Remover dos favoritos' : 'Favoritar'],
            ['move', 'Mover para divisão', moveTo],
            ['color', 'Trocar cor'],
            ['-', ''],
            ['reveal', 'Mostrar no Finder'],
            ['cursor', 'Abrir no Cursor'],
            ['git', 'Verificar GitHub'],
            ...(payload.sessions === '1' ? ([['-', ''], ['close', 'Fechar pasta']] as [string, string][]) : []),
            ...(payload.source === 'added' ? ([['-', ''], ['remove', 'Remover da lista']] as [string, string][]) : []),
          ]
        : kind === 'group'
          ? [
              ['rename', 'Renomear divisão'],
              ...(payload.first === '1' ? [] : ([['up', 'Mover para cima']] as Item[])),
              ...(payload.last === '1' ? [] : ([['down', 'Mover para baixo']] as Item[])),
              ['-', ''],
              ['delete', 'Excluir divisão'],
            ]
          : [
            ['interrupt', 'Interromper (⌃C)'],
            ['kill', 'Encerrar sessão'],
            ['close', 'Fechar painel'],
          ]
  return new Promise((resolve) => {
    let chosen: string | null = null
    const build = (list: Item[]): MenuItemConstructorOptions[] =>
      list.map(([id, label, sub]) =>
        id === '-' ? { type: 'separator' } : sub ? { label, submenu: build(sub) } : { label, click: () => (chosen = id) },
      )
    Menu.buildFromTemplate(build(items)).popup({ window: w, callback: () => resolve(chosen) })
  })
}

function buildMenu(): void {
  const cmd = (command: string) => () => {
    showWindow()
    send('ui:command', command)
  }
  // No browser lateral (ou DevTools) a seleção é da página, não do terminal.
  const editCmd = (action: 'copy' | 'selectAll') => () => {
    const focused = webContents.getFocusedWebContents()
    const w = liveWin()
    if (focused && w && focused !== w.webContents) {
      if (action === 'copy') focused.copy()
      else focused.selectAll()
      return
    }
    send('ui:command', action)
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Cockpit',
      submenu: [
        { role: 'about', label: 'Sobre o Cockpit' },
        { type: 'separator' },
        { label: 'Preferências…', accelerator: 'Cmd+,', click: cmd('prefs') },
        { label: 'Mods…', click: cmd('mods') },
        { label: 'Mods do Claude…', click: cmd('claudeMods') },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar Cockpit' },
        { role: 'hideOthers', label: 'Ocultar outros' },
        { type: 'separator' },
        { label: 'Encerrar Cockpit', accelerator: 'Cmd+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Sessão',
      submenu: [
        { label: 'Nova aba', accelerator: 'Cmd+T', click: cmd('newTab') },
        { label: 'Dividir (terminal)', accelerator: 'Cmd+D', click: cmd('split:shell') },
        { label: 'Dividir com Claude', accelerator: 'Cmd+Shift+D', click: cmd('split:claude') },
        { label: 'Expandir/restaurar painel', accelerator: 'Cmd+Shift+Enter', click: cmd('maximize') },
        { type: 'separator' },
        { label: 'Interromper', accelerator: 'Cmd+.', click: cmd('interrupt') },
        { label: 'Encerrar sessão', accelerator: 'Cmd+Shift+W', click: cmd('kill') },
        { type: 'separator' },
        { label: 'Próxima que precisa de mim', accelerator: 'Cmd+J', click: cmd('nextNeedsMe') },
        { label: 'Painel anterior', accelerator: 'Cmd+Alt+Left', click: cmd('prevPane') },
        { label: 'Próximo painel', accelerator: 'Cmd+Alt+Right', click: cmd('nextPane') },
        { label: 'Buscar no terminal', accelerator: 'Cmd+F', click: cmd('find') },
        { label: 'Limpar tela', accelerator: 'Cmd+Shift+K', click: cmd('clear') },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { label: 'Copiar', accelerator: 'Cmd+C', click: editCmd('copy') },
        { role: 'paste', label: 'Colar' },
        { label: 'Selecionar tudo', accelerator: 'Cmd+A', click: editCmd('selectAll') },
      ],
    },
    {
      label: 'Visualizar',
      submenu: [
        { label: 'Paleta de comandos', accelerator: 'Cmd+K', click: cmd('palette') },
        { label: 'Paleta de comandos ', accelerator: 'Cmd+Shift+P', click: cmd('palette'), visible: false },
        { label: 'Grade de sessões', accelerator: 'Cmd+G', click: cmd('grid') },
        { label: 'Barra lateral', accelerator: 'Cmd+B', click: cmd('sidebar') },
        { label: 'Árvore de arquivos', accelerator: 'Cmd+E', click: cmd('tree') },
        { label: 'Browser', accelerator: 'Cmd+Shift+B', click: cmd('browser') },
        { label: 'Agente', accelerator: 'Cmd+L', click: cmd('agent') },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i): MenuItemConstructorOptions => ({ label: `Projeto ${i + 1}`, accelerator: `Cmd+${i + 1}`, click: cmd(`project:${i}`) })),
        { type: 'separator' },
        { label: 'Aumentar fonte', accelerator: 'Cmd+=', click: cmd('fontUp') },
        { label: 'Diminuir fonte', accelerator: 'Cmd+-', click: cmd('fontDown') },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { label: 'Uso dos modelos…', accelerator: 'Cmd+Shift+U', click: cmd('usage') },
        { label: 'Fechar janela', accelerator: 'Cmd+W', click: () => liveWin()?.close() },
        { role: 'zoom' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Ambiente do shell de login (PATH do Homebrew/nvm etc.) quando o app é aberto pelo Finder. Comando fixo, com tempo limite.
function readLoginEnv(): Promise<Record<string, string> | undefined> {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-ilc', '/usr/bin/env -0'], { timeout: 4000, maxBuffer: 1024 * 1024, env: { HOME: app.getPath('home'), PATH: '/usr/bin:/bin' } }, (err, stdout) => {
      if (err || !stdout) return resolve(undefined)
      const env: Record<string, string> = {}
      for (const pair of stdout.split('\0')) {
        const i = pair.indexOf('=')
        if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1)
      }
      resolve(env)
    })
  })
}

// ---- Atualizar Cockpit (igual ao Hermes) ----

// Progresso da atualização em curso (ou da última que falhou); null quando nenhuma começou.
let update: UpdateProgress | null = null
const installedApp = join(homedir(), 'Applications', 'Cockpit.app')

/** Recompila do código-fonte (scripts/install-mac.sh) e reabre a cópia instalada; uma falha mantém esta versão. */
function startUpdate(): UpdateProgress | { error: string } {
  if (update && !update.failed) return update
  const root = app.isPackaged ? sourceRoot() : null
  if (!root) return { error: 'Não achei a pasta do código do Cockpit.' }
  const progress: UpdateProgress = { step: 'waiting', line: null, failed: null, startedAt: Date.now() }
  update = progress
  const emit = (): void => send('update:progress', { ...progress })
  emit()
  void runUpdate(root, claudeEnv(), (step, line) => {
    // A etapa só avança (o log pode repetir palavras de etapas anteriores).
    if (UPDATE_STEPS.findIndex((s) => s.id === step) > UPDATE_STEPS.findIndex((s) => s.id === progress.step)) progress.step = step
    if (line) progress.line = line
    emit()
  }).then((failure) => {
    if (failure) {
      progress.failed = failure
      emit()
      return
    }
    progress.step = 'restarting'
    progress.line = null
    emit()
    setTimeout(relaunchInstalled, 700)
  })
  return { ...progress }
}

/** Fecha o Cockpit (salvando as sessões para retomar) e abre a cópia instalada, ou este bundle se não houver. */
function relaunchInstalled(): void {
  const bundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '')
  scheduleRelaunch(process.pid, existsSync(installedApp) ? installedApp : bundle)
  app.quit()
}

function persistOpenSessions(): void {
  store.data.openSessions = sessions
    .list()
    .filter((s) => (s.lifecycle === 'running' || s.lifecycle === 'stopping') && s.agent !== 'shell')
    .map((s) => ({ projectId: s.projectId, agent: s.agent as Agent, title: s.title, claudeSessionId: s.claudeSessionId }))
  store.flush()
}

app.on('second-instance', () => showWindow())
app.on('activate', () => showWindow())

app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  if (win && !win.isDestroyed()) store.data.window = win.getNormalBounds()
  persistOpenSessions()
  browser.closeAll()
  mods.dispose()
  // Um `ps` travado não pode impedir a saída.
  void Promise.race([sessions.stopAll(), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.exit(0))
})

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => app.quit())

// Um erro inesperado no main não pode travar o app num diálogo modal (que bloqueia a saída e as sessões):
// registra no stderr e segue.
process.on('uncaughtException', (err) => console.error('[cockpit] erro não tratado no main:', err))
process.on('unhandledRejection', (err) => console.error('[cockpit] promessa rejeitada no main:', err))

void app.whenReady().then(async () => {
  if (!gotLock) return
  // A janela não espera o shell de login; só a criação de sessões espera (envReady).
  envReady = Promise.all([readLoginEnv().then((env) => (loginEnv = env)), bridge.start().catch(() => 0)])
  // Conteúdo do preview:// no app (painel de prévia) e no browser lateral.
  session.defaultSession.protocol.handle('preview', (req) => {
    const r = resolvePreviewRequest(req.url, (id) => projects.path(id))
    return r ? fileResponse(r.file, req.headers.get('range')) : new Response('bloqueado', { status: 403 })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications' || permission === 'clipboard-sanitized-write'))
  try {
    startHookServer(sockPath, token, (paneId, payload) => {
      // O módulo do plugin informa os limites do plano (o mesmo canal dos hooks).
      if (payload.hook_event_name === 'CockpitUsage') usage.setClaudeLimits((payload as { rateLimits?: unknown }).rateLimits)
      else if (payload.hook_event_name === 'CockpitBrowser') browserFromMod(paneId, payload as { op?: unknown; url?: unknown })
      else sessions.applyHook(paneId, payload)
    })
  } catch (e) {
    console.error('[cockpit] hooks indisponíveis:', e)
  }
  try {
    control = startControlServer(controlSockPath, controlTokenPath, controlToken, hermesHandler)
  } catch (e) {
    console.error('[cockpit] canal do Hermes indisponível:', e)
  }
  projects.on('changed', (list) => {
    send('projects:changed', list)
    void gitWatcher.refreshAll(true)
  })
  gitWatcher.on('state', (id, st) => send('git:state', id, st))
  // Pré-carrega a leitura dos registros de uso (o painel 📊 abre na hora); só arquivos locais, sem Keychain.
  setTimeout(() => void usage.report('7d').catch(() => {}), 15_000)
  void envReady.then(() => gitWatcher.start())
  mods.on('changed', (snap) => send('mods:changed', snap))
  registerIpc()
  buildMenu()
  started = true
  createWindow()
  mods.init()
  powerMonitor.on('resume', () => send('notice', 'O Mac dormiu. As sessões continuaram de onde pararam.'))
})

app.on('window-all-closed', () => {
  // Mantém o app vivo no Dock (as sessões continuam).
})

