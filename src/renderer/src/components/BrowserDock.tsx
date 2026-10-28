import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { closeBrowser, openBrowser } from '../controller'

// O WebContentsView do main fica por cima do DOM: este componente só reserva o espaço e envia os limites.
// Overlays (paleta, menus, modais) e arrastes escondem a view para não ficarem por baixo dela.
// `onClose`/`emptyExtra`: usado também dentro de um espaço do layout ("+ App").
export function BrowserDock({ projectId, hidden, onClose, emptyExtra }: { projectId: string; hidden: boolean; onClose?: () => void; emptyExtra?: React.ReactNode }) {
  const slot = useRef<HTMLDivElement>(null)
  const state = useStore((s) => s.browser[projectId])
  const overlay = useStore((s) => s.overlay)
  const dropdown = useStore((s) => s.dropdownOpen)
  const modPanel = useStore((s) => s.modPanel)
  const moving = useStore((s) => !!s.draggingPane || s.resizing)
  const by = useStore((s) => s.browserBy[projectId])
  const [url, setUrl] = useState(state?.url ?? '')
  const [editing, setEditing] = useState(false)
  const cover = hidden || !!overlay || dropdown || !!modPanel || moving

  useEffect(() => {
    if (!editing) setUrl(displayUrl(state?.url ?? ''))
  }, [state?.url, editing])

  useEffect(() => {
    const el = slot.current
    if (!el) return
    const push = () => {
      if (cover) {
        void window.cockpit.invoke('browser:bounds', projectId, null)
        return
      }
      const r = el.getBoundingClientRect()
      void window.cockpit.invoke('browser:bounds', projectId, { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', push)
      void window.cockpit.invoke('browser:bounds', projectId, null)
    }
  }, [projectId, cover])

  const go = () => {
    setEditing(false)
    if (url.trim()) void openBrowser(projectId, url.trim())
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn small" disabled={!state?.canGoBack} onClick={() => void window.cockpit.invoke('browser:action', projectId, 'back')}>‹</button>
        <button className="icon-btn small" disabled={!state?.canGoForward} onClick={() => void window.cockpit.invoke('browser:action', projectId, 'forward')}>›</button>
        <button className="icon-btn small" onClick={() => void window.cockpit.invoke('browser:action', projectId, 'reload')} title="Recarregar (mantém a rolagem)">{state?.loading ? '×' : '↻'}</button>
        <input
          className="url"
          value={url}
          placeholder="localhost:3000 ou /pasta/index.html"
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        {by && <span className="browser-by" title={`${by} está usando este navegador`}>🤖 {by}</span>}
        <button className="icon-btn small" onClick={() => void window.cockpit.invoke('browser:action', projectId, 'external')} title="Abrir no navegador padrão">↗</button>
        <button className="icon-btn small" onClick={() => void window.cockpit.invoke('browser:action', projectId, 'devtools')} title="DevTools">⚒</button>
        <button className="icon-btn small" onClick={() => (onClose ? onClose() : closeBrowser(projectId))} title={onClose ? 'Tirar o app deste espaço' : 'Fechar browser'}>×</button>
      </div>
      <div className="browser-slot" ref={slot}>
        {(!state?.url || state.url === 'about:blank') && (
          <div className="browser-empty">
            <p>Nenhuma página aberta.</p>
            <p className="muted small">Quando um servidor de desenvolvimento subir (ex.: <code>npm run dev</code>), ele abre aqui sozinho. Também dá para digitar <code>3000</code>, <code>localhost:5173</code> ou o caminho de um .html do projeto.</p>
            {emptyExtra}
          </div>
        )}
        {cover && state?.url && <div className="browser-covered">{state.title || displayUrl(state.url)}</div>}
      </div>
    </div>
  )
}

function displayUrl(u: string): string {
  if (u.startsWith('preview://')) {
    const i = u.indexOf('/', 'preview://'.length)
    return i > 0 ? `arquivo: /${decodeURIComponent(u.slice(i + 1))}` : u
  }
  return u
}
