import { setDock, useStore, type DockTab } from '../state/store'
import { appInLayout, closeBrowser, openBrowser, removeApp } from '../controller'
import { activeTab } from '../state/store'
import { BrowserDock } from './BrowserDock'
import { AgentPanel } from './agent/AgentPanel'

// Painel direito com abas: Agente | Browser.
export function RightDock({ projectId, hidden }: { projectId: string; hidden: boolean }) {
  const tab = useStore((s) => s.dock[projectId]?.tab ?? 'agent')
  const browserOpen = useStore((s) => !!s.browser[projectId]?.open)
  // Assina o layout: com o App num espaço, o browser não pode aparecer aqui também (uma view por projeto).
  useStore((s) => s.layouts[projectId])
  const inLayout = appInLayout(projectId)
  const go = (t: DockTab) => {
    if (t === 'browser' && !browserOpen) void openBrowser(projectId)
    else setDock(projectId, { tab: t, open: true })
  }
  return (
    <div className="right-dock">
      <div className="dock-tabs">
        <button className={`dock-tab ${tab === 'agent' ? 'on' : ''}`} onClick={() => go('agent')} title="Agente (⌘L)">✦ Agente</button>
        <button className={`dock-tab ${tab === 'browser' ? 'on' : ''}`} onClick={() => go('browser')} title="Browser (⌘⇧B)">🌐 Browser</button>
        <span className="spacer" />
        <button
          className="icon-btn small"
          title="Fechar painel"
          onClick={() => (tab === 'browser' ? closeBrowser(projectId) : setDock(projectId, { open: false }))}
        >×</button>
      </div>
      <div className="dock-body">
        {tab === 'browser' && inLayout ? (
          <div className="browser-empty">
            <p>O app está num espaço do layout.</p>
            <button className="ghost-btn small" onClick={() => { removeApp(projectId, activeTab(projectId).id); void openBrowser(projectId) }}>Trazer para cá</button>
          </div>
        ) : tab === 'browser' ? (
          <BrowserDock projectId={projectId} hidden={hidden} />
        ) : (
          <AgentPanel projectId={projectId} />
        )}
      </div>
    </div>
  )
}
