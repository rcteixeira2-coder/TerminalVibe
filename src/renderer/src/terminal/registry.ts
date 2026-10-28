import { Terminal, type ILink, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { mapKey } from './keymap'
import { darkTheme, lightTheme, prefersDark } from './theme'
import { useStore } from '../state/store'

const MAX_WEBGL = 12
const PATH_RE = /(?:^|[\s'"`(\[])((?:\.{1,2}\/|\/|[\w@-]+\/)?[\w@.\-/]*\.[A-Za-z0-9]{1,10}(?::\d+){0,2})(?=$|[\s'"`)\],;])/g

export interface PathLinkHandler {
  resolve(sessionId: string, text: string): Promise<{ path: string; line?: number } | null>
  open(sessionId: string, target: { path: string; line?: number }, withCursor: boolean): void
}

interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  webgl: WebglAddon | null
  el: HTMLDivElement
  opened: boolean
  replaying: boolean
  disposables: IDisposable[]
  lastCols: number
  lastRows: number
}

let fontSize = 13
let webglCount = 0
let pathLinks: PathLinkHandler | null = null
const entries = new Map<string, Entry>()
let focusListener: ((id: string) => void) | null = null

export function setPathLinkHandler(h: PathLinkHandler): void {
  pathLinks = h
}

export function onTerminalFocus(cb: (id: string) => void): void {
  focusListener = cb
}

function themeNow() {
  return prefersDark() ? darkTheme : lightTheme
}

export function getTerminal(id: string): Terminal | undefined {
  return entries.get(id)?.term
}

export function ensureTerminal(id: string, cols = 100, rows = 30): Entry {
  let e = entries.get(id)
  if (e) return e
  const term = new Terminal({
    cols,
    rows,
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace',
    fontSize,
    lineHeight: 1,
    letterSpacing: 0,
    scrollback: 10000,
    scrollSensitivity: 3,
    fastScrollSensitivity: 8,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    allowTransparency: false,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    minimumContrastRatio: 1,
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: false,
    theme: themeNow(),
    // OSC 8: só http/https e só com clique (validado no main).
    linkHandler: {
      activate: (_ev, uri) => void window.cockpit.invoke('links:open', uri),
      allowNonHttpProtocols: false,
    },
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  const unicode = new Unicode11Addon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(unicode)
  term.unicode.activeVersion = '11'
  term.loadAddon(new WebLinksAddon((_ev, uri) => void window.cockpit.invoke('links:open', uri)))
  const el = document.createElement('div')
  el.className = 'xterm-host'
  const entry: Entry = {
    id, term, fit, search, webgl: null, el, opened: false, replaying: false, disposables: [], lastCols: -1, lastRows: -1,
  }
  // Segurança (porte do SafeTerminalView): OSC 52 (clipboard) e kitty clipboard são engolidos.
  entry.disposables.push(term.parser.registerOscHandler(52, () => true))
  entry.disposables.push(term.parser.registerOscHandler(5522, () => true))
  // Status e avisos são lidos no main; aqui só não deixamos virar texto.
  entry.disposables.push(term.parser.registerOscHandler(7501, () => true))
  entry.disposables.push(term.parser.registerOscHandler(21337, () => true))
  entry.disposables.push(term.onData((d) => {
    // Durante a reidratação, respostas a consultas antigas não podem virar entrada.
    if (!entry.replaying) window.cockpit.send('pty:write', id, d)
  }))
  entry.disposables.push(term.onBinary((d) => {
    if (!entry.replaying) window.cockpit.send('pty:write', id, d)
  }))
  term.attachCustomKeyEventHandler((ev) => {
    // Com um modal aberto (exceto a busca), nenhuma tecla vai para o pty.
    const overlay = useStore.getState().overlay
    if (overlay && overlay !== 'find') return false
    const seq = mapKey(ev)
    if (seq !== null) {
      ev.preventDefault()
      window.cockpit.send('pty:write', id, seq)
      return false
    }
    // ⌘ + tecla fica para o menu do app (copiar, colar, abas…).
    if (ev.metaKey && ev.type === 'keydown' && ev.key !== 'v') return false
    return true
  })
  entry.disposables.push(term.registerLinkProvider({
    provideLinks(y, callback) {
      const handler = pathLinks
      if (!handler) return callback(undefined)
      const line = term.buffer.active.getLine(y - 1)
      if (!line) return callback(undefined)
      // Texto + coluna de cada caractere: emoji/CJK ocupam 2 colunas, então índice ≠ coluna.
      let text = ''
      const cols: number[] = []
      const cell = term.buffer.active.getNullCell()
      for (let x = 0; x < line.length; x++) {
        line.getCell(x, cell)
        if (cell.getWidth() === 0) continue
        const ch = cell.getChars() || ' '
        for (let i = 0; i < ch.length; i++) cols.push(x)
        text += ch
      }
      text = text.replace(/\s+$/, '')
      const candidates: { text: string; start: number }[] = []
      for (const m of text.matchAll(PATH_RE)) {
        const t = m[1]
        if (!t || /^https?:/.test(t) || t.length < 3) continue
        candidates.push({ text: t, start: (m.index ?? 0) + m[0].indexOf(t) })
        if (candidates.length >= 8) break
      }
      if (!candidates.length) return callback(undefined)
      void Promise.all(candidates.map(async (c) => ({ c, r: await handler.resolve(id, c.text) }))).then((res) => {
        const links: ILink[] = res
          .filter((x) => x.r)
          .map(({ c, r }) => ({
            text: c.text,
            range: { start: { x: cols[c.start] + 1, y }, end: { x: cols[c.start + c.text.length - 1] + 1, y } },
            decorations: { underline: true, pointerCursor: true },
            activate: (ev: MouseEvent) => handler.open(id, r!, ev.metaKey),
          }))
        callback(links.length ? links : undefined)
      })
    },
  }))
  entries.set(id, entry)
  return entry
}

export function writeData(id: string, data: string): void {
  const e = ensureTerminal(id)
  e.term.write(data, () => window.cockpit.send('pty:ack', id, data.length))
}

// Reidrata a partir do buffer do main (renderer recarregado).
export function replay(id: string, data: string): void {
  if (!data) return
  const e = ensureTerminal(id)
  e.replaying = true
  e.term.write(data, () => {
    e.replaying = false
  })
}

export function attachTerminal(id: string, container: HTMLElement): void {
  const e = ensureTerminal(id)
  if (e.el.parentElement !== container) container.appendChild(e.el)
  if (!e.opened) {
    e.term.open(e.el)
    e.opened = true
    e.term.textarea?.addEventListener('focus', () => {
      window.cockpit.send('session:focus', id)
      focusListener?.(id)
    })
  }
  if (!e.webgl && webglCount < MAX_WEBGL) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        if (e.webgl === webgl) {
          e.webgl = null
          webglCount--
        }
      })
      e.term.loadAddon(webgl)
      e.webgl = webgl
      webglCount++
    } catch {
      // Sem WebGL: renderizador DOM.
    }
  }
}

// Saiu da tela: libera o contexto WebGL (limite do Chromium), mantém o terminal vivo.
export function detachTerminal(id: string): void {
  const e = entries.get(id)
  if (!e) return
  if (e.webgl) {
    e.webgl.dispose()
    e.webgl = null
    webglCount--
  }
  e.el.remove()
}

// Ajusta ao contêiner visível e avisa o pty só se mudou.
export function fitTerminal(id: string): void {
  const e = entries.get(id)
  if (!e || !e.opened || !e.el.isConnected) return
  const dims = e.fit.proposeDimensions()
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 2) return
  if (dims.cols !== e.term.cols || dims.rows !== e.term.rows) e.term.resize(dims.cols, dims.rows)
  if (dims.cols !== e.lastCols || dims.rows !== e.lastRows) {
    e.lastCols = dims.cols
    e.lastRows = dims.rows
    window.cockpit.send('pty:resize', id, dims.cols, dims.rows)
  }
}

export function currentSize(id: string): { cols: number; rows: number } {
  const t = entries.get(id)?.term
  return t ? { cols: t.cols, rows: t.rows } : { cols: 100, rows: 30 }
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
}

export function disposeTerminal(id: string): void {
  const e = entries.get(id)
  if (!e) return
  detachTerminal(id)
  for (const d of e.disposables) d.dispose()
  e.term.dispose()
  entries.delete(id)
}

export function selection(id: string): string {
  return entries.get(id)?.term.getSelection() ?? ''
}

export function selectAll(id: string): void {
  entries.get(id)?.term.selectAll()
}

export function clearTerminal(id: string): void {
  entries.get(id)?.term.clear()
}

export function findNext(id: string, query: string, back = false): boolean {
  const e = entries.get(id)
  if (!e || !query) return false
  const opts = { caseSensitive: false, decorations: { matchOverviewRuler: '#e0af68', activeMatchColorOverviewRuler: '#ff9e64', matchBackground: '#3d59a1', activeMatchBackground: '#ff9e64' } }
  return back ? e.search.findPrevious(query, opts) : e.search.findNext(query, opts)
}

export function clearSearch(id: string): void {
  entries.get(id)?.search.clearDecorations()
}

// Últimas linhas em texto puro (cards da grade).
export function tailText(id: string, lines = 14): string {
  const t = entries.get(id)?.term
  if (!t) return ''
  const buf = t.buffer.active
  const end = buf.baseY + buf.cursorY
  const out: string[] = []
  for (let y = Math.max(0, end - 60); y <= end; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.slice(-lines).join('\n')
}

// Tela ao vivo (mesmo com o usuário rolando o histórico) e a linha do cursor: o rodapé de modelo lê menus e o prompt por aqui.
export function screenState(id: string): { lines: string[]; cursorLine: string; cursorX: number } | null {
  const t = entries.get(id)?.term
  if (!t) return null
  const buf = t.buffer.active
  const lines: string[] = []
  for (let y = 0; y < t.rows; y++) lines.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
  return { lines, cursorLine: buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '', cursorX: buf.cursorX }
}

export function setFontSize(size: number): void {
  fontSize = size
  for (const e of entries.values()) {
    e.term.options.fontSize = size
    fitTerminal(e.id)
  }
}

export function applyTheme(): void {
  const t = themeNow()
  for (const e of entries.values()) e.term.options.theme = t
}

// Texto completo do terminal (scrollback + tela), usado pelos testes de ponta a ponta.
export function fullText(id: string): string {
  const t = entries.get(id)?.term
  if (!t) return ''
  const buf = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    if (line.isWrapped && out.length) out[out.length - 1] += line.translateToString(true)
    else out.push(line.translateToString(true))
  }
  return out.join('\n')
}

// Cola texto respeitando o bracketed paste do programa (o Claude não envia ao receber várias linhas).
export function pasteText(id: string, text: string): boolean {
  const t = entries.get(id)?.term
  if (!t) return false
  t.paste(text)
  return true
}
