import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, session as electronSession, shell, WebContentsView, type Session, type WebContents } from 'electron'
import type { BrowserState } from '@shared/types'
import { isInside, isLocalUrl, validateLink } from './security'
import { fileResponse, previewUrl, resolvePreviewRequest } from './files'
import { ignoredForReload } from './launchTargets'

interface Entry {
  projectId: string
  view: WebContentsView
  bounds: Electron.Rectangle | null
  watcher: FSWatcher | null
  reloadTimer: NodeJS.Timeout | null
  lastUsed: number
  pendingScroll: number | null
  // Para o Claude depurar (ferramentas browser_console/browser_network): só em memória.
  logs: string[]
  net: string[]
}

const MAX_VIEWS = 3
const MAX_LOG = 200

function pushCapped(list: string[], line: string): void {
  list.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line)
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG)
}

export function isAllowedInPanel(url: string): boolean {
  if (url.startsWith('preview://')) return true
  if (url === 'about:blank') return true
  return isLocalUrl(url)
}

// Um WebContentsView por projeto, sob demanda (LRU de 3), partição só em memória, sem preload.
export class BrowserManager {
  private entries = new Map<string, Entry>()
  private partitions = new Set<string>()

  constructor(
    private win: () => BrowserWindow | null,
    private projectRoot: (id: string) => string | null,
    private emitState: (s: BrowserState) => void,
  ) {}

  private partitionFor(projectId: string): Session {
    const name = `browser-${createHash('sha1').update(projectId).digest('hex').slice(0, 16)}`
    const ses = electronSession.fromPartition(name, { cache: false })
    if (!this.partitions.has(name)) {
      this.partitions.add(name)
      ses.protocol.handle('preview', (req) => {
        const r = resolvePreviewRequest(req.url, this.projectRoot)
        if (!r) return new Response('bloqueado', { status: 403 })
        return fileResponse(r.file, req.headers.get('range'))
      })
      ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'))
      // HTML local (preview://) não fala com a internet: senão uma página do projeto poderia enviar arquivos dele para fora.
      ses.webRequest.onBeforeRequest((details, cb) => {
        const page = details.webContents?.getURL() ?? ''
        const fromPreview = page.startsWith('preview://') || (details.referrer ?? '').startsWith('preview://')
        const target = details.url
        const external = /^(https?|wss?):/i.test(target) && !isLocalUrl(target.replace(/^ws/i, 'http'))
        cb({ cancel: fromPreview && external })
      })
      ses.on('will-download', (e) => e.preventDefault())
      // Respostas com erro e falhas de rede de cada página, para o Claude ver (ex.: o 503 de uma API).
      ses.webRequest.onCompleted((d) => {
        if (d.statusCode >= 400) this.netLine(d.webContentsId, `${d.statusCode} ${d.method} ${d.url} (${d.resourceType})`)
      })
      ses.webRequest.onErrorOccurred((d) => {
        if (d.error !== 'net::ERR_ABORTED') this.netLine(d.webContentsId, `FALHOU ${d.method} ${d.url} — ${d.error} (${d.resourceType})`)
      })
    }
    return ses
  }

  private ensure(projectId: string): Entry | null {
    const win = this.win()
    if (!win) return null
    let e = this.entries.get(projectId)
    if (e) {
      e.lastUsed = Date.now()
      return e
    }
    const view = new WebContentsView({
      webPreferences: {
        session: this.partitionFor(projectId),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    })
    view.setBackgroundColor('#ffffff')
    e = { projectId, view, bounds: null, watcher: null, reloadTimer: null, lastUsed: Date.now(), pendingScroll: null, logs: [], net: [] }
    this.entries.set(projectId, e)
    const wc = view.webContents
    const entry = e
    wc.on('will-navigate', (ev, url) => {
      if (isAllowedInPanel(url)) return
      ev.preventDefault()
      const safe = validateLink(url)
      if (safe) void shell.openExternal(safe)
    })
    wc.on('will-redirect', (ev, url) => {
      if (!isAllowedInPanel(url)) ev.preventDefault()
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedInPanel(url)) void wc.loadURL(url)
      else {
        const safe = validateLink(url)
        if (safe) void shell.openExternal(safe)
      }
      return { action: 'deny' }
    })
    wc.on('will-attach-webview', (ev) => ev.preventDefault())
    wc.on('console-message', (ev) => {
      const { level, message, lineNumber, sourceId } = ev
      // Aviso do próprio Electron (só em desenvolvimento), não da página.
      if (message.startsWith('Electron Security Warning')) return
      pushCapped(entry.logs, `[${level}] ${message}${sourceId ? ` (${sourceId.replace(/^.*\//, '')}:${lineNumber})` : ''}`)
    })
    const push = () => this.emitState(this.state(projectId)!)
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('did-navigate', () => {
      this.watchIfLocal(entry)
      push()
    })
    wc.on('did-navigate-in-page', push)
    wc.on('page-title-updated', push)
    wc.on('did-finish-load', () => {
      if (entry.pendingScroll !== null) {
        const y = entry.pendingScroll
        entry.pendingScroll = null
        void wc.executeJavaScript(`window.scrollTo(0, ${Number(y) || 0})`, false).catch(() => {})
      }
    })
    win.contentView.addChildView(view)
    view.setVisible(false)
    this.evict()
    return e
  }

  private evict(): void {
    if (this.entries.size <= MAX_VIEWS) return
    const oldest = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (oldest) this.close(oldest.projectId)
  }

  open(projectId: string, url?: string): BrowserState | { error: string } {
    const e = this.ensure(projectId)
    if (!e) return { error: 'Janela indisponível.' }
    const wc = e.view.webContents
    if (url) {
      const target = this.normalize(projectId, url)
      if (!target) return { error: 'Endereço não permitido no painel. Use localhost ou um arquivo do projeto.' }
      if (wc.getURL() !== target) void wc.loadURL(target)
    }
    this.applyBounds(e)
    return this.state(projectId)!
  }

  private netLine(webContentsId: number | undefined, line: string): void {
    for (const e of this.entries.values()) if (e.view.webContents.id === webContentsId) pushCapped(e.net, line)
  }

  // ---- usado pelas ferramentas do navegador do Claude (src/main/browserTools.ts) ----

  // A página do projeto (criada se ainda não existe), para ler/clicar/tirar print.
  contents(projectId: string): WebContents | null {
    return this.ensure(projectId)?.view.webContents ?? null
  }

  shown(projectId: string): boolean {
    return !!this.entries.get(projectId)?.bounds
  }

  // Projeto que não está na tela: a página é desenhada fora da área visível enquanto o Claude age
  // (print, clique), sem trocar o projeto do usuário. Na tela: usa o painel como está.
  async withPage<T>(projectId: string, fn: (wc: WebContents) => Promise<T>): Promise<T> {
    const e = this.ensure(projectId)
    if (!e) throw new Error('Navegador indisponível (janela fechada).')
    if (e.bounds) return fn(e.view.webContents)
    const size = this.win()?.getContentSize() ?? [1280, 800]
    const w = Math.max(800, Math.round(size[0] * 0.5))
    const h = Math.max(600, size[1] - 60)
    e.view.setBounds({ x: -w - 200, y: 0, width: w, height: h })
    e.view.setVisible(true)
    await new Promise((res) => setTimeout(res, 120))
    try {
      return await fn(e.view.webContents)
    } finally {
      // O painel pode ter aparecido enquanto isso: só esconde se continua fora da tela.
      if (!e.bounds) e.view.setVisible(false)
      else this.applyBounds(e)
    }
  }

  logs(projectId: string): string[] {
    return [...(this.entries.get(projectId)?.logs ?? [])]
  }

  network(projectId: string): string[] {
    return [...(this.entries.get(projectId)?.net ?? [])]
  }

  navigate(projectId: string, url: string): BrowserState | { error: string } {
    return this.open(projectId, url)
  }

  private normalize(projectId: string, raw: string): string | null {
    let url = raw.trim()
    if (/^\d{2,5}$/.test(url)) url = `http://localhost:${url}/`
    else if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) url = `http://${url}`
    if (url.startsWith('/')) {
      const root = this.projectRoot(projectId)
      if (!root) return null
      // Caminho absoluto dentro do projeto, ou relativo à raiz do projeto ("/pasta/index.html").
      const file = isInside(root, url) ? url : join(root, url)
      return isInside(root, file) ? previewUrl(projectId, root, file) : null
    }
    return isAllowedInPanel(url) ? url : null
  }

  pageUrl(projectId: string, file: string): string | null {
    const root = this.projectRoot(projectId)
    return root ? previewUrl(projectId, root, file) : null
  }

  action(projectId: string, action: 'back' | 'forward' | 'reload' | 'external' | 'close' | 'devtools'): void {
    const e = this.entries.get(projectId)
    if (!e) return
    const wc = e.view.webContents
    const nav = wc.navigationHistory
    switch (action) {
      case 'back':
        if (nav.canGoBack()) nav.goBack()
        break
      case 'forward':
        if (nav.canGoForward()) nav.goForward()
        break
      case 'reload':
        this.reloadKeepingScroll(e)
        break
      case 'external': {
        const safe = validateLink(wc.getURL())
        if (safe) void shell.openExternal(safe)
        break
      }
      case 'devtools':
        wc.openDevTools({ mode: 'detach' })
        break
      case 'close':
        this.close(projectId)
        break
    }
  }

  // rect em px CSS da janela; null = esconder (overlays, arraste, outro projeto).
  setBounds(projectId: string, rect: Electron.Rectangle | null): void {
    for (const [id, e] of this.entries) {
      if (id !== projectId) {
        e.bounds = null
        e.view.setVisible(false)
      }
    }
    const e = this.entries.get(projectId)
    if (!e) return
    e.bounds = rect && rect.width > 10 && rect.height > 10 ? roundRect(rect) : null
    this.applyBounds(e)
  }

  private applyBounds(e: Entry): void {
    if (e.bounds) {
      e.view.setBounds(e.bounds)
      e.view.setVisible(true)
    } else e.view.setVisible(false)
  }

  state(projectId: string): BrowserState | null {
    const e = this.entries.get(projectId)
    if (!e) return null
    const wc = e.view.webContents
    return {
      projectId,
      url: wc.getURL(),
      visible: !!e.bounds,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      title: wc.getTitle(),
    }
  }

  close(projectId: string): void {
    const e = this.entries.get(projectId)
    if (!e) return
    this.entries.delete(projectId)
    e.watcher?.close()
    if (e.reloadTimer) clearTimeout(e.reloadTimer)
    this.win()?.contentView.removeChildView(e.view)
    e.view.webContents.close()
    this.emitState({ projectId, url: '', visible: false, canGoBack: false, canGoForward: false, loading: false, title: '' })
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
  }

  // Recarga ao vivo de HTML local: debounce 800 ms, mantendo a rolagem (Preview.swift).
  private watchIfLocal(e: Entry): void {
    const url = e.view.webContents.getURL()
    const local = url.startsWith('preview://')
    if (!local) {
      e.watcher?.close()
      e.watcher = null
      return
    }
    if (e.watcher) return
    const root = this.projectRoot(e.projectId)
    if (!root) return
    try {
      e.watcher = watch(root, { recursive: true }, (_ev, name) => {
        if (!name || ignoredForReload(join(root, name.toString()))) return
        if (e.reloadTimer) clearTimeout(e.reloadTimer)
        e.reloadTimer = setTimeout(() => this.reloadKeepingScroll(e), 800)
      })
    } catch {
      e.watcher = null
    }
  }

  private reloadKeepingScroll(e: Entry): void {
    const wc = e.view.webContents
    wc.executeJavaScript('window.scrollY', false)
      .then((y: unknown) => {
        e.pendingScroll = typeof y === 'number' ? y : null
      })
      .catch(() => {})
      .finally(() => wc.reload())
  }
}

function roundRect(r: Electron.Rectangle): Electron.Rectangle {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}
