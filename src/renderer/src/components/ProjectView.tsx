import { GitBadge } from './GitBadge'
import { useEffect, useRef, useState } from 'react'
import { Allotment, setSashSize } from 'allotment'
import type { Agent, LaunchTarget, Project } from '@shared/types'
import { AGENT_LABEL } from '@shared/types'
import { mostUrgent } from '@shared/status'
import { actions, APP_CELL, layoutOf, setLayout, setUi, tabCapacity, useStore, type Tab } from '../state/store'
import { presetOf, pruneTree, type LayoutNode } from '../layout/presets'
import {
  closeTab, invokeMod, moveSession, newTab, openInCursor, placeAppAt, removeApp, removeSlot, runLaunchTarget, setFont, setPaneSizes, spawn, spawnAt, split, tabCells,
  toggleDock, toggleMaximize,
} from '../controller'
import { BrowserDock } from './BrowserDock'
import type { DropZone } from '../layout/presets'
import { PaneView } from './PaneView'
import { FileTree } from './FileTree'
import { RightDock } from './RightDock'
import { StatusDot } from './StatusDot'
import { ClaudeModsButton } from './ClaudeModsView'

// Área de pegar das divisórias (CSS e JS juntos): mais fácil de esticar terminais e o app.
setSashSize(8)

export function ProjectView({ project }: { project: Project }) {
  const layout = useStore((s) => s.layouts[project.id]) ?? layoutOf(project.id)
  const sessions = useStore((s) => s.sessions)
  const tree = useStore((s) => s.ui.tree)
  const treeWidth = useStore((s) => s.ui.treeWidth)
  const browserWidth = useStore((s) => s.ui.browserWidth)
  const dock = useStore((s) => s.dock[project.id])
  const dockOpen = !!dock?.open
  const allButtons = useStore((s) => s.mods.buttons)
  const projectButtons = allButtons.filter((b) => b.location === 'project')
  const tab = layout.tabs.find((t) => t.id === layout.activeTabId) ?? layout.tabs[0]
  const [dragging, setDragging] = useState(false)

  return (
    <div className="project" style={{ ['--pc' as string]: project.color }}>
      <header className="project-header">
        <div className="ph-left">
          <span className="ph-color" />
          <span className="ph-name" title={project.path}>{project.name}</span>
          <TabBar projectId={project.id} tabs={layout.tabs} activeTabId={layout.activeTabId} />
        </div>
        <div className="ph-actions">
          {projectButtons.map((b) => (
            <button key={`${b.modId}:${b.id}`} className="ghost-btn small" onClick={() => void invokeMod(b.modId, b.id)} title={`Mod: ${b.modId}`}>
              {b.icon ? `${b.icon} ` : ''}{b.label}
            </button>
          ))}
          <SplitButton disabled={tab.sessionIds.length + (tab.app ? 1 : 0) >= tabCapacity(tab)} max={tabCapacity(tab)} />
          <LaunchMenu project={project} />
          <GitBadge project={project} place="header" />
          <button className={`icon-btn ${tree ? 'on' : ''}`} onClick={() => setUi({ tree: !tree })} title="Árvore de arquivos (⌘E)">🗂</button>
          <button
            className={`icon-btn agent-toggle ${dockOpen && dock?.tab === 'agent' ? 'on' : ''}`}
            onClick={() => toggleDock(project.id, 'agent')}
            title="Agente (⌘L)"
          >✦</button>
          <button
            className={`icon-btn ${dockOpen && dock?.tab === 'browser' ? 'on' : ''}`}
            onClick={() => toggleDock(project.id, 'browser')}
            title="Browser lateral (⌘⇧B)"
          >🌐</button>
          <button className="icon-btn" onClick={() => void openInCursor(project.path)} title="Abrir no Cursor">⌘</button>
          <FontButton />
          <ClaudeModsButton />
        </div>
      </header>
      <div className="project-body">
        <Allotment
          onDragStart={() => setDragging(true)}
          onDragEnd={(sizes) => {
            setDragging(false)
            const n = sizes.length
            if (tree && sizes[0]) setUi({ treeWidth: Math.round(sizes[0]) })
            if (dockOpen && sizes[n - 1]) setUi({ browserWidth: Math.round(sizes[n - 1]) })
          }}
        >
          {tree && (
            <Allotment.Pane preferredSize={treeWidth} minSize={180} maxSize={420} snap={false}>
              <FileTree project={project} />
            </Allotment.Pane>
          )}
          <Allotment.Pane minSize={300}>
            <PaneArea project={project} tab={tab} sessionsVersion={sessions} />
          </Allotment.Pane>
          {dockOpen && (
            <Allotment.Pane preferredSize={browserWidth} minSize={320}>
              <RightDock projectId={project.id} hidden={dragging} />
            </Allotment.Pane>
          )}
        </Allotment>
      </div>
    </div>
  )
}

function PaneArea({ project, tab }: { project: Project; tab: Tab; sessionsVersion: unknown }) {
  const sessions = useStore((s) => s.sessions)
  const [resetN, setResetN] = useState(0)
  const ids = tab.sessionIds.filter((id) => sessions[id])
  if (!ids.length && !tab.app) return <EmptyState project={project} />
  const { cells, fixed } = tabCells(tab)
  const preset = presetOf(tab.preset)
  const items = cells.filter((c): c is string => !!c)
  const closable = items.length > 1
  const cell = (id: string, index: number, max: boolean) =>
    id === APP_CELL ? (
      <AppSlot projectId={project.id} tabId={tab.id} maximized={max} />
    ) : (
      <PaneView session={sessions[id]} closable={closable} maximized={max} onMaximize={() => toggleMaximize(project.id, tab.id, id)} />
    )

  // Um item expandido ocupa a aba toda; os outros seguem vivos, só não aparecem.
  const maxIndex = tab.maximized ? cells.indexOf(tab.maximized) : -1
  if (maxIndex >= 0) {
    const hidden = items.length - 1
    return (
      <div className="pane-area maximized">
        {hidden > 0 && (
          <button className="max-bar" onClick={() => toggleMaximize(project.id, tab.id, tab.maximized!)} title="Voltar ao layout (⌘⇧↩)">
            ⤡ Expandido · {hidden} {hidden === 1 ? 'painel escondido' : 'painéis escondidos'} — clique para voltar ao layout
          </button>
        )}
        <Slot projectId={project.id} tabId={tab.id} index={maxIndex}>{cell(tab.maximized!, maxIndex, true)}</Slot>
      </div>
    )
  }

  // Sem layout (ou com mais itens do que espaços): todos lado a lado.
  const tree: LayoutNode = (fixed && preset ? pruneTree(preset.tree, tab.removed) : null) ?? { dir: 'row', parts: cells.map((_, i) => i), ratio: cells.map(() => 1) }
  const canRemove = fixed && tabCapacity(tab) > 1
  const render = (node: LayoutNode, path: string): React.ReactNode => {
    if (typeof node === 'number') {
      const id = cells[node]
      return (
        <Slot projectId={project.id} tabId={tab.id} index={node}>
          {id ? cell(id, node, false) : <EmptySlot projectId={project.id} tabId={tab.id} index={node} hasApp={!!tab.app} removable={canRemove} />}
        </Slot>
      )
    }
    const saved = tab.sizes?.[path]
    return (
      <Allotment
        vertical={node.dir === 'col'}
        defaultSizes={saved && saved.length === node.parts.length ? saved : node.ratio}
        onDragStart={() => actions.set({ resizing: true })}
        onDragEnd={(sizes) => {
          actions.set({ resizing: false })
          setPaneSizes(project.id, tab.id, path, sizes.map((s) => Math.round(s)))
        }}
        // Duplo clique na divisória: volta às proporções do layout.
        onReset={() => {
          setPaneSizes(project.id, tab.id, path, null)
          setResetN((n) => n + 1)
        }}
      >
        {node.parts.map((child, i) => (
          <Allotment.Pane key={i} minSize={node.dir === 'col' ? 120 : 220}>
            {render(child, `${path}.${i}`)}
          </Allotment.Pane>
        ))}
      </Allotment>
    )
  }
  // Muda a árvore (layout ou, no automático, a fila) → remonta as divisórias com os tamanhos salvos.
  const key = `${fixed && preset ? `${preset.id}-${(tab.removed ?? []).join('.')}` : `auto:${cells.join(',')}`}:${resetN}`
  return <div className="pane-area" key={key}>{render(tree, 'r')}</div>
}

// O browser do projeto dentro de um espaço do layout ("+ App").
function AppSlot({ projectId, tabId, maximized }: { projectId: string; tabId: string; maximized: boolean }) {
  const state = useStore((s) => s.browser[projectId])
  const [launch, setLaunch] = useState(false)
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const label = state?.url && !state.url.startsWith('about:') ? state.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'nada rodando'
  return (
    <div className="pane app-pane">
      <div
        className="pane-head"
        draggable
        title="Arraste para mudar o app de lugar"
        onDragStart={(e) => {
          if ((e.target as HTMLElement).closest('button')) return e.preventDefault()
          e.dataTransfer.setData('application/x-cockpit-pane', APP_CELL)
          e.dataTransfer.effectAllowed = 'move'
          setTimeout(() => actions.set({ draggingPane: APP_CELL }), 0)
        }}
        onDragEnd={() => actions.set({ draggingPane: null })}
      >
        <span className="app-icon">🌐</span>
        <span className="pane-title">App</span>
        <span className="pane-task">{label}</span>
        <span className="spacer" />
        <button className="icon-btn small max-btn" onClick={() => toggleMaximize(projectId, tabId, APP_CELL)} title={maximized ? 'Voltar ao layout (⌘⇧↩)' : 'Expandir para a aba toda (⌘⇧↩)'}>{maximized ? '⤡' : '⤢'}</button>
        <button className="tab-x" onClick={() => removeApp(projectId, tabId)} title="Tirar o app deste espaço">×</button>
      </div>
      <div className="app-body">
        <BrowserDock
          projectId={projectId}
          hidden={false}
          onClose={() => removeApp(projectId, tabId)}
          emptyExtra={
            project && (
              <div className="menu-wrap app-launch">
                <button className="ghost-btn small play" onClick={() => setLaunch(!launch)}>▶ Rodar o projeto</button>
                {launch && <LaunchList project={project} onDone={() => setLaunch(false)} align="left" />}
              </div>
            )
          }
        />
      </div>
    </div>
  )
}

// Um espaço do layout: recebe terminais arrastados pelo cabeçalho.
function Slot({ projectId, tabId, index, children }: { projectId: string; tabId: string; index: number; children: React.ReactNode }) {
  const dragging = useStore((s) => s.draggingPane)
  const [zone, setZone] = useState<DropZone | null>(null)
  const [edge, setEdge] = useState<'left' | 'right' | 'top' | 'bottom' | null>(null)
  const isPane = (e: React.DragEvent) => e.dataTransfer.types.includes('application/x-cockpit-pane')
  const onOver = (e: React.DragEvent) => {
    if (!isPane(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    const fy = (e.clientY - r.top) / r.height
    const m = 0.22
    const side = fx < m ? 'left' : fx > 1 - m ? 'right' : fy < m ? 'top' : fy > 1 - m ? 'bottom' : null
    setEdge(side)
    setZone(side === 'left' || side === 'top' ? 'before' : side ? 'after' : 'center')
  }
  const onDrop = (e: React.DragEvent) => {
    if (!isPane(e)) return
    e.preventDefault()
    e.stopPropagation()
    const id = e.dataTransfer.getData('application/x-cockpit-pane')
    if (id) moveSession(projectId, tabId, id, index, zone ?? 'center')
    setZone(null)
    actions.set({ draggingPane: null })
  }
  return (
    <div className="slot" onDragOverCapture={onOver} onDragLeave={() => setZone(null)} onDropCapture={onDrop}>
      {children}
      {dragging && <div className="drop-catch" />}
      {dragging && zone && <div className={`drop-hint ${zone === 'center' ? 'center' : edge}`} />}
    </div>
  )
}

function EmptySlot({ projectId, tabId, index, hasApp, removable }: { projectId: string; tabId: string; index: number; hasApp: boolean; removable: boolean }) {
  return (
    <div className="empty-slot">
      {removable && (
        <button className="tab-x empty-slot-x" onClick={() => removeSlot(projectId, tabId, index)} title="Remover este espaço (escolha o layout de novo no ▦ para recuperar)">×</button>
      )}
      <span className="muted">Espaço livre</span>
      <div className="empty-slot-actions">
        {(['shell', 'claude', 'codex'] as Agent[]).map((a) => (
          <button key={a} className="ghost-btn small" onClick={() => void spawnAt(projectId, tabId, index, a)}>+ {AGENT_LABEL[a]}</button>
        ))}
        {!hasApp && (
          <button className="ghost-btn small" onClick={() => void placeAppAt(projectId, tabId, index)} title="Mostra aqui o site do projeto (o localhost do ▶ Rodar ou um .html)">+ App</button>
        )}
      </div>
      <span className="hint">ou arraste um terminal até aqui</span>
    </div>
  )
}

function TabBar({ projectId, tabs, activeTabId }: { projectId: string; tabs: Tab[]; activeTabId: string }) {
  const sessions = useStore((s) => s.sessions)
  return (
    <div className="tabs">
      {tabs.map((t) => {
        const list = t.sessionIds.map((id) => sessions[id]).filter(Boolean)
        const agg = mostUrgent(list.filter((s) => s.lifecycle === 'running').map((s) => s.activity))
        const label = list.length ? list.map((s) => s.title).join(' · ') : 'Nova aba'
        return (
          <div key={t.id} className={`tab ${t.id === activeTabId ? 'active' : ''}`}>
            <button className="tab-btn" onClick={() => setLayout(projectId, { tabs, activeTabId: t.id })} title={label}>
              {list.length > 0 && <StatusDot activity={agg} size={7} />}
              <span className="tab-label">{label}</span>
            </button>
            {tabs.length > 1 && (
              <button
                className="tab-x"
                onClick={() => {
                  const running = list.some((s) => s.lifecycle === 'running')
                  if (!running || window.confirm('Fechar esta aba encerra as sessões dela. Continuar?')) closeTab(projectId, t.id)
                }}
                title="Fechar aba"
              >×</button>
            )}
          </div>
        )
      })}
      <button className="tab-add" onClick={() => newTab(projectId)} title="Nova aba (⌘T)">+</button>
    </div>
  )
}

function SplitButton({ disabled, max }: { disabled: boolean; max: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="menu-wrap">
      <button className="ghost-btn small" disabled={disabled} onClick={() => void split('shell')} title={disabled ? `Até ${max} terminais nesta aba (troque o layout no ▦)` : 'Dividir com terminal (⌘D)'}>
        ⊞ Dividir
      </button>
      <button className="ghost-btn small caret" disabled={disabled} onClick={() => setOpen(!open)}>▾</button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          {(['shell', 'claude', 'codex'] as Agent[]).map((a) => (
            <button key={a} className="dd-item" onClick={() => { setOpen(false); void split(a) }}>{AGENT_LABEL[a]}</button>
          ))}
        </Dropdown>
      )}
    </div>
  )
}

// aA: tamanho do texto de todos os terminais (o mesmo de Preferências e ⌘+ / ⌘−).
function FontButton() {
  const [open, setOpen] = useState(false)
  const size = useStore((s) => s.prefs.fontSize)
  return (
    <div className="menu-wrap">
      <button className={`icon-btn font-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Tamanho do texto dos terminais (⌘+ / ⌘−)">
        <span className="font-a-small">a</span>A
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          <div className="font-row">
            <button className="ghost-btn small" disabled={size <= 8} onClick={() => void setFont(-1)} title="Diminuir (⌘−)">A−</button>
            <span className="font-size">{size}px</span>
            <button className="ghost-btn small" disabled={size >= 22} onClick={() => void setFont(1)} title="Aumentar (⌘+)">A+</button>
          </div>
          <button className="dd-item" disabled={size === 13} onClick={() => void setFont(13 - size)}>Voltar ao padrão (13px)</button>
        </Dropdown>
      )}
    </div>
  )
}

function LaunchMenu({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="menu-wrap">
      <button className="ghost-btn small play" onClick={() => setOpen(!open)} title="Rodar o projeto">▶ Rodar</button>
      {open && <LaunchList project={project} onDone={() => setOpen(false)} />}
    </div>
  )
}

// Alvos do ▶ Rodar (apps, servidores, páginas) e a escolha "Abrir em".
function LaunchList({ project, onDone, align }: { project: Project; onDone: () => void; align?: 'left' | 'right' }) {
  const [targets, setTargets] = useState<LaunchTarget[] | null>(null)
  useEffect(() => {
    void window.cockpit.invoke('launch:targets', project.id).then(setTargets)
  }, [project.id])
  const groups: [LaunchTarget['kind'], string][] = [['app', 'Apps'], ['server', 'Servidores'], ['page', 'Páginas']]
  const openIn = project.openIn ?? 'cockpit'
  const setOpenIn = (v: 'cockpit' | 'external') => void window.cockpit.invoke('projects:update', project.id, { openIn: v })
  return (
    <Dropdown onClose={onDone} wide align={align}>
      {targets === null && <div className="dd-empty">Procurando…</div>}
      {targets?.length === 0 && <div className="dd-empty">Nada para rodar encontrado (apps, scripts dev/start, .html).</div>}
      {targets?.some((t) => t.kind !== 'app') && (
        <div className="dd-openin" title="Onde abrir servidores e páginas deste projeto">
          <span>Abrir em</span>
          <div className="seg">
            <button className={openIn === 'cockpit' ? 'on' : ''} onClick={() => setOpenIn('cockpit')}>Cockpit</button>
            <button className={openIn === 'external' ? 'on' : ''} onClick={() => setOpenIn('external')}>Navegador ↗</button>
          </div>
        </div>
      )}
      {targets &&
        groups.map(([kind, title]) => {
          const list = targets.filter((t) => t.kind === kind)
          if (!list.length) return null
          return (
            <div key={kind}>
              <div className="dd-title">{title}</div>
              {list.map((t) => (
                <button key={t.id} className="dd-item" onClick={() => { onDone(); void runLaunchTarget(project.id, t.id) }} title={t.command ?? t.path}>
                  <span>{t.title}</span>
                  <span className="dd-detail">{t.detail}</span>
                </button>
              ))}
            </div>
          )
        })}
    </Dropdown>
  )
}

// `align="left"` para menus de botões no canto esquerdo (senão o menu sairia do painel e ficaria atrás do vizinho).
export function Dropdown({ children, onClose, wide, align = 'right' }: { children: React.ReactNode; onClose: () => void; wide?: boolean; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    actions.set({ dropdownOpen: true })
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.body.classList.add('dropdown-open')
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('dropdown-open')
      actions.set({ dropdownOpen: false })
    }
  }, [onClose])
  return <div ref={ref} className={`dropdown ${wide ? 'wide' : ''} ${align === 'left' ? 'align-left' : ''}`}>{children}</div>
}

function EmptyState({ project }: { project: Project }) {
  const allRestorable = useStore((s) => s.restorable)
  const restorable = allRestorable.filter((r) => r.projectId === project.id)
  const agents: Agent[] = ['claude', 'codex', 'shell']
  const preferred = project.lastAgent
  return (
    <div className="empty">
      <div className="empty-card">
        <h2>Escolha como trabalhar neste projeto</h2>
        <p className="muted">{project.path}</p>
        <div className="empty-actions">
          {agents.map((a) => (
            <button key={a} className={`big-btn agent-${a} ${preferred === a ? 'preferred' : ''}`} onClick={() => void spawn(project.id, a)}>
              <span className="big-icon">{a === 'claude' ? '✻' : a === 'codex' ? '◎' : '›_'}</span>
              Abrir {AGENT_LABEL[a]}
            </button>
          ))}
        </div>
        {restorable.length > 0 && (
          <div className="restore">
            <div className="muted">Sessões abertas quando o Cockpit fechou:</div>
            {restorable.map((r, i) => (
              <button key={i} className="ghost-btn" onClick={() => {
                void spawn(project.id, r.agent, { resume: true, title: r.title, claudeSessionId: r.claudeSessionId })
                actions.set({ restorable: actions.get().restorable.filter((x) => x !== r) })
              }}>
                ↻ Retomar conversa — {r.title}
              </button>
            ))}
            <button className="link-btn" onClick={() => {
              void window.cockpit.invoke('sessions:forgetRestorable', project.id)
              actions.set({ restorable: actions.get().restorable.filter((x) => x.projectId !== project.id) })
            }}>esquecer</button>
          </div>
        )}
        <p className="muted small">
          {project.lastAgent ? `Última escolha: ${AGENT_LABEL[project.lastAgent]}. ` : ''}Modelos, skills e permissões continuam nos menus de cada agente.
        </p>
      </div>
    </div>
  )
}
