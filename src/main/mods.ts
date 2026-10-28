import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain, session as electronSession, type Session } from 'electron'
import type { Agent, ModButton, ModCommand, ModInfo, ModPanel, ModsSnapshot, SessionInfo } from '@shared/types'
import { isInside } from './security'
import { fileResponse } from './files'

// COCKPIT_MODS_DIR só existe para os testes não tocarem nos mods reais do usuário.
export const MODS_DIR = process.env.COCKPIT_MODS_DIR || join(homedir(), '.cockpit', 'mods')

export const MOD_PERMISSIONS = ['session.events', 'session.write', 'notify', 'browser'] as const

export type ModAction =
  | { type: 'type'; text: string; enter?: boolean }
  | { type: 'spawn'; agent: Agent }
  | { type: 'openUrl'; url: string }
  | { type: 'launch'; target?: string }
  | { type: 'script' }

interface ManifestAction {
  id: string
  label?: string
  title?: string
  icon?: string
  location?: 'sidebar' | 'project'
  action?: ModAction
}

export interface Manifest {
  id: string
  name: string
  version: string
  description?: string
  main?: string
  permissions?: string[]
  buttons?: ManifestAction[]
  commands?: ManifestAction[]
  panels?: { id: string; title: string; html: string }[]
}

interface Loaded {
  dir: string
  manifest: Manifest
  error?: string
}

// Valida o manifesto; erros viram mensagem na tela de Mods (o mod não carrega).
export function validateManifest(raw: unknown, dirName: string): { manifest?: Manifest; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'manifest.json inválido' }
  const m = raw as Record<string, unknown>
  const id = typeof m.id === 'string' ? m.id : ''
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return { error: 'id inválido (use letras minúsculas, números e -)' }
  if (id !== dirName) return { error: `id "${id}" deve ser igual ao nome da pasta "${dirName}"` }
  if (typeof m.name !== 'string' || !m.name) return { error: 'name obrigatório' }
  const perms = Array.isArray(m.permissions) ? m.permissions.filter((p): p is string => typeof p === 'string') : []
  const unknownPerm = perms.find((p) => !(MOD_PERMISSIONS as readonly string[]).includes(p))
  if (unknownPerm) return { error: `permissão desconhecida: ${unknownPerm}` }
  const actions = (list: unknown): ManifestAction[] =>
    Array.isArray(list)
      ? list.filter((a): a is ManifestAction => !!a && typeof a === 'object' && typeof (a as ManifestAction).id === 'string').slice(0, 20)
      : []
  const main = typeof m.main === 'string' ? m.main : undefined
  if (main && (main.includes('..') || main.startsWith('/'))) return { error: 'main deve ser um caminho dentro do mod' }
  const panels = Array.isArray(m.panels)
    ? m.panels.filter((p) => p && typeof p.id === 'string' && typeof p.html === 'string' && !String(p.html).includes('..')).slice(0, 5)
    : []
  return {
    manifest: {
      id, name: m.name as string, version: typeof m.version === 'string' ? m.version : '0.0.0',
      description: typeof m.description === 'string' ? m.description : undefined,
      main, permissions: perms, buttons: actions(m.buttons), commands: actions(m.commands), panels,
    },
  }
}

// Texto digitado por mods: sem sequências de controle (só \r \n \t), até 4 KB.
export function sanitizeModText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9b]/g, '').slice(0, 4096)
}

export interface ModsDeps {
  sessions(): SessionInfo[]
  projectName(id: string): string | undefined
  write(sessionId: string, text: string): boolean
  notify(title: string, body: string): void
  spawn(projectId: string, agent: Agent): void
  openUrl(projectId: string, url: string): void
  launch(projectId: string, target?: string): void
  enabled(id: string): boolean
  setEnabled(id: string, v: boolean): void
  writeGranted(id: string): boolean
  grantWrite(id: string): void
  parentWindow(): BrowserWindow | null
  panelMessage(modId: string, panelId: string, message: unknown): void
}

export class ModsHost extends EventEmitter<{ changed: [ModsSnapshot] }> {
  private mods = new Map<string, Loaded>()
  private host: BrowserWindow | null = null
  private hostSession: Session | null = null
  private restarts = 0
  private lastWrite = new Map<string, number>()
  private hung = new Set<string>()
  private heartbeat: NodeJS.Timeout | null = null
  private lastPong = 0
  private stableTimer: NodeJS.Timeout | null = null

  constructor(private deps: ModsDeps, private preloadPath: string, private examplesDir: string) {
    super()
  }

  init(): void {
    if (!existsSync(MODS_DIR)) {
      mkdirSync(MODS_DIR, { recursive: true })
      try {
        if (existsSync(this.examplesDir)) cpSync(this.examplesDir, MODS_DIR, { recursive: true })
      } catch {
        // sem exemplos
      }
    }
    this.registerProtocol(electronSession.defaultSession)
    ipcMain.handle('modhost:call', (e, modId: string, method: string, args: unknown[]) => {
      if (!this.host || e.sender !== this.host.webContents) return { error: 'origem inválida' }
      return this.call(modId, method, Array.isArray(args) ? args : [])
    })
    ipcMain.on('modhost:ready', (e) => {
      if (this.host && e.sender === this.host.webContents) {
        this.lastPong = Date.now()
        this.pushModsToHost()
      }
    })
    ipcMain.on('modhost:pong', (e) => {
      if (this.host && e.sender === this.host.webContents) this.lastPong = Date.now()
    })
    this.load()
  }

  snapshot(): ModsSnapshot {
    const mods: ModInfo[] = []
    const buttons: ModButton[] = []
    const commands: ModCommand[] = []
    const panels: ModPanel[] = []
    for (const [id, l] of this.mods) {
      const enabled = this.deps.enabled(id) && !l.error
      const error = l.error ?? (this.hung.has(id) ? 'O script travou (loop infinito?) e foi parado. Corrija e use Recarregar.' : undefined)
      mods.push({
        id, name: l.manifest.name, version: l.manifest.version, description: l.manifest.description,
        enabled: this.deps.enabled(id), permissions: l.manifest.permissions ?? [], error, hasScript: !!l.manifest.main,
      })
      if (!enabled) continue
      for (const b of l.manifest.buttons ?? [])
        buttons.push({ modId: id, id: b.id, label: b.label ?? b.title ?? b.id, icon: b.icon, location: b.location ?? 'sidebar' })
      for (const c of l.manifest.commands ?? []) commands.push({ modId: id, id: c.id, title: c.title ?? c.label ?? c.id })
      for (const p of l.manifest.panels ?? []) panels.push({ modId: id, id: p.id, title: p.title, url: `mod://${id}/${p.html}` })
    }
    return { mods, buttons, commands, panels }
  }

  load(): void {
    this.mods.clear()
    this.hung.clear()
    let dirs: string[] = []
    try {
      dirs = readdirSync(MODS_DIR).filter((d) => !d.startsWith('.') && statSync(join(MODS_DIR, d)).isDirectory())
    } catch {
      dirs = []
    }
    for (const d of dirs) {
      const dir = join(MODS_DIR, d)
      try {
        const v = validateManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), d)
        if (v.manifest) this.mods.set(v.manifest.id, { dir, manifest: v.manifest })
        else this.mods.set(d, { dir, manifest: { id: d, name: d, version: '?' }, error: v.error })
      } catch (e) {
        this.mods.set(d, { dir, manifest: { id: d, name: d, version: '?' }, error: `manifest.json: ${(e as Error).message}` })
      }
    }
    this.restartHost()
    this.emit('changed', this.snapshot())
  }

  setEnabled(id: string, v: boolean): ModsSnapshot {
    this.deps.setEnabled(id, v)
    this.restartHost()
    const snap = this.snapshot()
    this.emit('changed', snap)
    return snap
  }

  // Botão/comando clicado pelo usuário.
  invoke(modId: string, actionId: string, ctx: { projectId?: string; sessionId?: string }): { ok: boolean; error?: string } {
    const l = this.mods.get(modId)
    if (!l || l.error || !this.deps.enabled(modId)) return { ok: false, error: 'Mod desligado.' }
    const def = [...(l.manifest.buttons ?? []), ...(l.manifest.commands ?? [])].find((a) => a.id === actionId)
    if (!def) return { ok: false, error: 'Ação não encontrada.' }
    const action = def.action ?? { type: 'script' }
    switch (action.type) {
      case 'type': {
        if (!ctx.sessionId) return { ok: false, error: 'Abra uma sessão primeiro.' }
        const text = sanitizeModText(action.text) + (action.enter ? '\r' : '')
        return { ok: this.deps.write(ctx.sessionId, text) }
      }
      case 'spawn':
        if (!ctx.projectId) return { ok: false, error: 'Escolha um projeto.' }
        this.deps.spawn(ctx.projectId, action.agent)
        return { ok: true }
      case 'openUrl':
        if (!ctx.projectId) return { ok: false, error: 'Escolha um projeto.' }
        this.deps.openUrl(ctx.projectId, action.url)
        return { ok: true }
      case 'launch':
        if (!ctx.projectId) return { ok: false, error: 'Escolha um projeto.' }
        this.deps.launch(ctx.projectId, action.target)
        return { ok: true }
      case 'script':
        this.sendEvent(modId, 'action', [actionId, ctx])
        return { ok: true }
    }
  }

  sessionEvent(info: SessionInfo): void {
    const ev = {
      sessionId: info.id, projectId: info.projectId, projectName: this.deps.projectName(info.projectId),
      agent: info.foreground ?? info.agent, title: info.title, activity: info.activity, lifecycle: info.lifecycle,
      detail: info.activityDetail,
    }
    for (const [id, l] of this.mods) {
      if (l.error || !this.deps.enabled(id) || !l.manifest.main) continue
      if (!(l.manifest.permissions ?? []).includes('session.events')) continue
      this.sendEvent(id, 'session', [ev])
    }
  }

  panelToMod(modId: string, panelId: string, message: unknown): void {
    this.sendEvent(modId, 'panel', [panelId, message])
  }

  private has(modId: string, perm: string): boolean {
    return (this.mods.get(modId)?.manifest.permissions ?? []).includes(perm)
  }

  private async call(modId: string, method: string, args: unknown[]): Promise<unknown> {
    const l = this.mods.get(modId)
    if (!l || l.error || !this.deps.enabled(modId)) return { error: 'mod desligado' }
    switch (method) {
      case 'listSessions':
        if (!this.has(modId, 'session.events')) return { error: 'sem permissão session.events' }
        return this.deps.sessions().map((s) => ({
          sessionId: s.id, projectId: s.projectId, projectName: this.deps.projectName(s.projectId), agent: s.foreground ?? s.agent,
          title: s.title, activity: s.activity, lifecycle: s.lifecycle, detail: s.activityDetail,
        }))
      case 'notify':
        if (!this.has(modId, 'notify')) return { error: 'sem permissão notify' }
        this.deps.notify(String(args[0] ?? l.manifest.name).slice(0, 100), String(args[1] ?? '').slice(0, 300))
        return { ok: true }
      case 'sendToSession': {
        if (!this.has(modId, 'session.write')) return { error: 'sem permissão session.write' }
        const now = Date.now()
        if ((this.lastWrite.get(modId) ?? 0) > now - 1000) return { error: 'limite: 1 envio por segundo' }
        if (!this.deps.writeGranted(modId)) {
          const win = this.deps.parentWindow()
          const opts = {
            type: 'question' as const, buttons: ['Permitir', 'Negar'], defaultId: 1, cancelId: 1,
            message: `O mod "${l.manifest.name}" quer digitar nas suas sessões.`,
            detail: 'Ele só poderá enviar texto simples (sem teclas de controle), no máximo 1 vez por segundo. Você pode desligar o mod a qualquer momento.',
          }
          const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
          if (r.response !== 0) return { error: 'negado pelo usuário' }
          this.deps.grantWrite(modId)
        }
        this.lastWrite.set(modId, now)
        const text = sanitizeModText(args[1])
        return { ok: this.deps.write(String(args[0]), text) }
      }
      case '__hung':
        // O host parou um iframe que não respondeu ao ping.
        this.hung.add(modId)
        this.emit('changed', this.snapshot())
        return { ok: true }
      case 'postToPanel':
        this.deps.panelMessage(modId, String(args[0]), args[1])
        return { ok: true }
      case 'openUrl':
        if (!this.has(modId, 'browser')) return { error: 'sem permissão browser' }
        this.deps.openUrl(String(args[0]), String(args[1]))
        return { ok: true }
      default:
        return { error: `método desconhecido: ${method}` }
    }
  }

  private sendEvent(modId: string, type: string, args: unknown[]): void {
    if (!this.host || this.host.isDestroyed()) return
    this.host.webContents.send('modhost:event', modId, type, args)
  }

  private scriptedMods(): { id: string; main: string }[] {
    return [...this.mods.values()]
      .filter((l) => !l.error && l.manifest.main && this.deps.enabled(l.manifest.id) && !this.hung.has(l.manifest.id))
      .map((l) => ({ id: l.manifest.id, main: l.manifest.main! }))
  }

  private pushModsToHost(): void {
    this.host?.webContents.send('modhost:mods', this.scriptedMods())
  }

  private restartHost(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.heartbeat = this.stableTimer = null
    if (this.host && !this.host.isDestroyed()) this.host.destroy()
    this.host = null
    if (!this.scriptedMods().length) return
    if (!this.hostSession) {
      this.hostSession = electronSession.fromPartition('cockpit-mods', { cache: false })
      this.registerProtocol(this.hostSession)
      // Sem rede: só o próprio protocolo mod://.
      this.hostSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('mod://') && !details.url.startsWith('devtools://') }))
      this.hostSession.setPermissionRequestHandler((_w, _p, cb) => cb(false))
      // webRequest não cobre WebRTC/DNS: proxy morto + UDP só via proxy deixam o host sem rede de verdade.
      void this.hostSession.setProxy({ proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' })
    }
    const host = new BrowserWindow({
      show: false,
      webPreferences: {
        session: this.hostSession, preload: this.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    this.host = host
    host.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    const recover = () => {
      // Host travado (ex.: while(true) no mesmo processo): recria com espera crescente.
      if (this.host !== host) return
      this.restarts++
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = null
      if (!host.isDestroyed()) host.destroy()
      this.host = null
      setTimeout(() => this.restartHost(), Math.min(30_000, 1000 * 2 ** this.restarts))
    }
    host.webContents.on('unresponsive', recover)
    // 'unresponsive' não dispara em janelas ocultas sem eventos de entrada: heartbeat próprio.
    this.lastPong = Date.now()
    this.heartbeat = setInterval(() => {
      if (this.host !== host || host.isDestroyed()) return
      if (Date.now() - this.lastPong > 12_000) {
        recover()
        return
      }
      host.webContents.send('modhost:ping')
    }, 4000)
    // Estável por 1 min: a espera crescente volta ao início.
    this.stableTimer = setTimeout(() => (this.restarts = 0), 60_000)
    host.webContents.on('render-process-gone', recover)
    host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    host.webContents.on('will-navigate', (e) => e.preventDefault())
    void host.loadURL('mod://__host/index.html')
  }

  private registerProtocol(ses: Session): void {
    if (ses.protocol.isProtocolHandled('mod')) return
    ses.protocol.handle('mod', (req) => {
      const u = new URL(req.url)
      const modId = u.hostname
      const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
      const csp = "default-src 'none'; script-src mod:; style-src mod: 'unsafe-inline'; img-src mod: data:; font-src mod: data:; frame-src mod:"
      const html = (body: string) =>
        new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } })
      const js = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
      if (modId === '__host') {
        if (path === 'index.html') return html('<!doctype html><meta charset="utf-8"><script src="mod://__host/host.js"></script>')
        if (path === 'host.js') return js(HOST_JS)
        return new Response('não encontrado', { status: 404 })
      }
      const l = this.mods.get(modId)
      if (!l || l.error) return new Response('não encontrado', { status: 404 })
      if (path === '__runtime.html')
        return html(`<!doctype html><meta charset="utf-8"><script src="mod://${modId}/__shim.js"></script><script type="module" src="mod://${modId}/${l.manifest.main ?? 'main.js'}"></script>`)
      if (path === '__shim.js') return js(SHIM_JS)
      const file = resolve(l.dir, path)
      if (!isInside(l.dir, file)) return new Response('bloqueado', { status: 403 })
      const res = fileResponse(file, null)
      // CSP em toda resposta (HTML, SVG, qualquer extensão): painéis não acessam a rede.
      res.headers.set('Content-Security-Policy', csp.replace("script-src mod:", "script-src mod: 'unsafe-inline'"))
      return res
    })
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    if (this.host && !this.host.isDestroyed()) this.host.destroy()
  }
}

// Host oculto: um iframe por mod com script; repassa chamadas e eventos.
const HOST_JS = `
const frames = new Map();
const missed = new Map();
function mount(mods) {
  for (const f of frames.values()) f.remove();
  frames.clear();
  missed.clear();
  for (const m of mods) {
    const f = document.createElement('iframe');
    f.src = 'mod://' + m.id + '/__runtime.html';
    f.dataset.mod = m.id;
    document.body.appendChild(f);
    frames.set(m.id, f);
  }
}
// Cada mod responde a pings; quem perde 3 seguidos (ex.: while(true) em processo próprio) é removido.
setInterval(() => {
  for (const [id, f] of frames) {
    const n = (missed.get(id) || 0) + 1;
    if (n > 3) {
      f.remove(); frames.delete(id); missed.delete(id);
      window.cockpitHost.call(id, '__hung', []);
      continue;
    }
    missed.set(id, n);
    if (f.contentWindow) f.contentWindow.postMessage({ kind: 'ping' }, '*');
  }
}, 3000);
window.addEventListener('message', async (e) => {
  const m = e.data;
  if (!m) return;
  let modId = null;
  for (const [id, f] of frames) if (f.contentWindow === e.source) modId = id;
  if (!modId) return;
  if (m.kind === 'pong') { missed.set(modId, 0); return; }
  if (m.kind !== 'call') return;
  let result;
  try { result = await window.cockpitHost.call(modId, String(m.method), m.args || []); }
  catch (err) { result = { error: String(err && err.message || err) }; }
  e.source.postMessage({ kind: 'result', id: m.id, result }, '*');
});
window.cockpitHost.onMods(mount);
window.cockpitHost.onPing(() => window.cockpitHost.pong());
window.cockpitHost.onEvent((modId, type, args) => {
  const f = frames.get(modId);
  if (f && f.contentWindow) f.contentWindow.postMessage({ kind: 'event', type, args }, '*');
});
window.cockpitHost.ready();
`

// API dentro de cada mod: window.cockpit
const SHIM_JS = `
(() => {
  const pending = new Map(); let seq = 0;
  const handlers = { session: [], action: [], panel: [] };
  const call = (method, args = []) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    parent.postMessage({ kind: 'call', id, method, args }, '*');
  });
  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.kind === 'ping') { parent.postMessage({ kind: 'pong' }, '*'); return; }
    if (m.kind === 'result') {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.result && m.result.error) p.reject(new Error(m.result.error)); else p.resolve(m.result);
    } else if (m.kind === 'event' && handlers[m.type]) {
      for (const h of handlers[m.type]) { try { h(...m.args); } catch (err) { console.error(err); } }
    }
  });
  window.cockpit = Object.freeze({
    onSessionEvent: (cb) => handlers.session.push(cb),
    onAction: (cb) => handlers.action.push(cb),
    onPanelMessage: (cb) => handlers.panel.push(cb),
    listSessions: () => call('listSessions'),
    notify: (title, body) => call('notify', [title, body]),
    sendToSession: (sessionId, text) => call('sendToSession', [sessionId, text]),
    postToPanel: (panelId, message) => call('postToPanel', [panelId, message]),
    openUrl: (projectId, url) => call('openUrl', [projectId, url]),
  });
})();
`
