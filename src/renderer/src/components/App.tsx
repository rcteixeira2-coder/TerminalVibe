import { useEffect } from 'react'
import { useStore, countNeedsMe } from '../state/store'
import { Sidebar } from './Sidebar'
import { ProjectView } from './ProjectView'
import { GridView } from './GridView'
import { Palette } from './Palette'
import { ModsView, ModPanelDrawer } from './ModsView'
import { PrefsView } from './PrefsView'
import { UsageView } from './UsageView'
import { ClaudeModsView } from './ClaudeModsView'
import { ComponentsView } from './ComponentsView'
import { PreviewModal } from './PreviewModal'
import { FindBar } from './FindBar'
import { Toasts } from './Toasts'
import { UpdateCard } from './UpdateCard'

export function App() {
  const view = useStore((s) => s.view)
  const sidebar = useStore((s) => s.ui.sidebar)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const overlay = useStore((s) => s.overlay)
  const sessions = useStore((s) => s.sessions)

  useEffect(() => {
    const n = countNeedsMe(sessions)
    document.title = n ? `Cockpit (${n})` : 'Cockpit'
  }, [sessions])

  return (
    <div className={`app ${sidebar ? '' : 'no-sidebar'}`}>
      <div className="drag-strip" />
      {sidebar && <Sidebar />}
      <main className="main">
        {view === 'grid' ? (
          <GridView />
        ) : project && activeProjectId ? (
          <ProjectView key={project.id} project={project} />
        ) : (
          <Welcome />
        )}
      </main>
      {overlay === 'palette' && <Palette />}
      {overlay === 'mods' && <ModsView />}
      {overlay === 'claudeMods' && <ClaudeModsView />}
      {overlay === 'prefs' && <PrefsView />}
      {overlay === 'usage' && <UsageView />}
      {overlay === 'components' && <ComponentsView />}
      {overlay === 'preview' && <PreviewModal />}
      {overlay === 'find' && <FindBar />}
      <ModPanelDrawer />
      <UpdateCard />
      <Toasts />
    </div>
  )
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Cockpit</h1>
        <p>Escolha um projeto na barra lateral para abrir Claude, Codex ou um terminal.</p>
        <ul className="hints">
          <li><kbd>⌘K</kbd> paleta de comandos</li>
          <li><kbd>⌘G</kbd> grade com todas as sessões</li>
          <li><kbd>⌘J</kbd> próxima sessão que precisa de você</li>
          <li><kbd>⌘1…9</kbd> ir para um projeto</li>
        </ul>
      </div>
    </div>
  )
}
