import { useMemo, useState } from 'react'
import type { Project, SessionInfo, SidebarGroup } from '@shared/types'
import { PROJECT_COLORS } from '@shared/types'
import { needsMe } from '@shared/status'
import { actions, countNeedsMe, projectActivity, useStore } from '../state/store'
import { focusSession, invokeMod, moveToGroup, newGroup, nextNeedsMe, openInCursor, refreshGit, runCommand, saveGroups, selectProject, startUpdate } from '../controller'
import { ActivityBadge, AgentIcon, StatusDot } from './StatusDot'
import { GitBadge } from './GitBadge'
import { LayoutMenu } from './LayoutMenu'
import { level, until } from './UsageView'

export function Sidebar() {
  const projects = useStore((s) => s.projects)
  const sessions = useStore((s) => s.sessions)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const view = useStore((s) => s.view)
  const groups = useStore((s) => s.groups)
  // Seletor estável (zustand 5): filtrar fora do seletor.
  const allButtons = useStore((s) => s.mods.buttons)
  const buttons = allButtons.filter((b) => b.location === 'sidebar')
  const [filter, setFilter] = useState('')
  const needs = countNeedsMe(sessions)

  const byProject = useMemo(() => {
    const m = new Map<string, SessionInfo[]>()
    for (const s of Object.values(sessions)) {
      const list = m.get(s.projectId) ?? []
      list.push(s)
      m.set(s.projectId, list)
    }
    for (const list of m.values()) list.sort((a, b) => a.startedAt - b.startedAt)
    return m
  }, [sessions])

  const q = filter.trim().toLowerCase()
  const visible = projects.filter((p) => !q || p.name.toLowerCase().includes(q))
  const favorites = visible.filter((p) => p.favorite)
  // Cada pasta aparece numa divisão só: favoritos > divisão do usuário > seções automáticas.
  const free = visible.filter((p) => !p.favorite && !p.group)
  // Projetos com sessões abertas sobem para "Em uso".
  const inUse = free.filter((p) => byProject.has(p.id))
  const desktop = free.filter((p) => !byProject.has(p.id) && p.source === 'desktop')
  const added = free.filter((p) => !byProject.has(p.id) && p.source === 'added')

  const rows = (list: Project[]) =>
    list.map((p) => <ProjectRow key={p.id} project={p} active={view === 'project' && p.id === activeProjectId} sessions={byProject.get(p.id) ?? []} />)

  const section = (title: string, list: Project[]) =>
    list.length > 0 && (
      <DropSection onDrop={(id) => void dropTo(id, { favorite: false, group: null })}>
        <div className="side-title">{title}</div>
        {rows(list)}
      </DropSection>
    )

  return (
    <aside className="sidebar">
      <div className="side-top">
        <span className="brand">Cockpit</span>
        <UpdateButton />
        <div className="side-top-actions">
          <button className={`chip ${needs ? 'chip-alert' : ''}`} onClick={() => nextNeedsMe()} title="Próxima sessão que precisa de você (⌘J)">
            {needs ? `${needs} precisa${needs > 1 ? 'm' : ''} de você` : 'tudo em dia'}
          </button>
          <LayoutMenu />
        </div>
      </div>
      <input className="side-filter" placeholder="Filtrar projetos…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="side-scroll">
        {(favorites.length > 0 || !q) && (
          <DropSection onDrop={(id) => void dropTo(id, { favorite: true })}>
            <div className="side-title">Favoritos</div>
            {favorites.length ? rows(favorites) : <div className="side-empty">Arraste pastas para cá ou use ★ Favoritar no clique direito.</div>}
          </DropSection>
        )}
        {groups.map((g, i) => {
          const list = visible.filter((p) => !p.favorite && p.group === g.id)
          if (q && !list.length) return null
          return (
            <DropSection key={g.id} onDrop={(id) => void dropTo(id, { favorite: false, group: g.id })}>
              <GroupTitle group={g} index={i} count={list.length} />
              {list.length ? rows(list) : <div className="side-empty">Arraste pastas para cá.</div>}
            </DropSection>
          )
        })}
        {section('Em uso', inUse)}
        {section('Mesa', desktop)}
        {section('Adicionadas', added)}
      </div>
      <div className="side-bottom">
        {buttons.map((b) => (
          <button key={`${b.modId}:${b.id}`} className="side-mod-btn" onClick={() => void invokeMod(b.modId, b.id)} title={`Mod: ${b.modId}`}>
            {b.icon ? <span className="mod-icon">{b.icon}</span> : null}
            {b.label}
          </button>
        ))}
        <UsageButton />
        <div className="side-bottom-row">
          <button className="ghost-btn" onClick={() => void window.cockpit.invoke('projects:add')}>+ Adicionar pasta</button>
          <button className="ghost-btn" onClick={() => void newGroup()} title="Criar uma divisão para agrupar pastas">+ Divisão</button>
          <button className="icon-btn" onClick={() => actions.set({ overlay: 'mods' })} title="Mods do Cockpit">⚙︎</button>
          <button className="icon-btn" onClick={() => actions.set({ overlay: 'prefs' })} title="Preferências (⌘,)">☰</button>
        </div>
      </div>
    </aside>
  )
}

const DRAG_TYPE = 'application/x-cockpit-project'

async function dropTo(projectId: string, patch: { favorite?: boolean; group?: string | null }) {
  await window.cockpit.invoke('projects:update', projectId, patch)
}

// Seção que aceita uma pasta arrastada da própria barra lateral.
function DropSection({ onDrop, children }: { onDrop: (projectId: string) => void; children: React.ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={`side-section ${over ? 'drop-over' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        setOver(false)
        const id = e.dataTransfer.getData(DRAG_TYPE)
        if (id) onDrop(id)
      }}
    >
      {children}
    </div>
  )
}

function GroupTitle({ group, index, count }: { group: SidebarGroup; index: number; count: number }) {
  const groups = useStore((s) => s.groups)
  const renaming = useStore((s) => s.renamingGroup === group.id)
  const save = (patch: SidebarGroup[]) => void saveGroups(patch)
  const move = (to: number) => {
    const next = [...groups]
    next.splice(index, 1)
    next.splice(to, 0, group)
    save(next)
  }
  const onMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    const r = await window.cockpit.invoke('ui:contextMenu', 'group', {
      first: index === 0 ? '1' : '0',
      last: index === groups.length - 1 ? '1' : '0',
    })
    if (r === 'rename') actions.set({ renamingGroup: group.id })
    if (r === 'up') move(index - 1)
    if (r === 'down') move(index + 1)
    if (r === 'delete') save(groups.filter((g) => g.id !== group.id))
  }
  if (renaming) {
    const finish = (name: string | null) => {
      actions.set({ renamingGroup: null })
      if (name !== null && name.trim() && name.trim() !== group.name) save(groups.map((g) => (g.id === group.id ? { ...g, name: name.trim() } : g)))
    }
    return (
      <div className="side-title">
        <input
          className="side-rename"
          defaultValue={group.name}
          autoFocus
          maxLength={40}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finish(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') finish(null)
          }}
        />
      </div>
    )
  }
  return (
    <div className="side-title user" onContextMenu={onMenu} onDoubleClick={() => actions.set({ renamingGroup: group.id })} title="Clique duplo para renomear · botão direito para mais opções">
      <span>{group.name}</span>
      {count > 0 && <span className="count">{count}</span>}
    </div>
  )
}

function ProjectRow({ project, active, sessions }: { project: Project; active: boolean; sessions: SessionInfo[] }) {
  const all = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const agg = projectActivity(project.id, all)
  const running = sessions.filter((s) => s.lifecycle === 'running')
  const onMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    const r = await window.cockpit.invoke('ui:contextMenu', 'project', {
      favorite: project.favorite ? '1' : '0',
      source: project.source,
      sessions: sessions.length ? '1' : '0',
      group: project.group ?? '',
      groups: JSON.stringify(groups),
    })
    // Ir para uma divisão tira dos favoritos; desfavoritar devolve a pasta à divisão dela.
    if (r === 'group:new') {
      if (project.favorite) await window.cockpit.invoke('projects:update', project.id, { favorite: false })
      void newGroup(project.id)
    } else if (r === 'group:none') void moveToGroup(project.id, null)
    else if (r?.startsWith('group:')) void dropTo(project.id, { favorite: false, group: r.slice(6) })
    if (r === 'favorite') void window.cockpit.invoke('projects:update', project.id, { favorite: !project.favorite })
    if (r === 'color') {
      const i = PROJECT_COLORS.indexOf(project.color)
      void window.cockpit.invoke('projects:update', project.id, { color: PROJECT_COLORS[(i + 1) % PROJECT_COLORS.length] })
    }
    if (r === 'reveal') void window.cockpit.invoke('projects:reveal', project.id)
    if (r === 'cursor') void openInCursor(project.path)
    if (r === 'remove') void window.cockpit.invoke('projects:remove', project.id)
    if (r === 'git') void refreshGit(project.id)
    if (r === 'close') void window.cockpit.invoke('projects:close', project.id)
  }
  return (
    <div className={`proj ${active ? 'active' : ''} ${project.missing ? 'missing' : ''}`} style={{ ['--pc' as string]: project.color }}>
      <div className="proj-line">
      <button
        className="proj-row"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, project.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => selectProject(project.id)}
        onContextMenu={onMenu} title={project.missing ? 'Pasta indisponível' : project.path}>
        <span className="proj-color" />
        <span className="proj-name">{project.name}</span>
        {project.favorite && <span className="star">★</span>}
        {running.length > 0 && (
          <span className="proj-agg">
            {running.length > 1 && <span className="count">{running.length}</span>}
            <StatusDot activity={agg} />
          </span>
        )}
      </button>
      {!project.missing && <GitBadge project={project} place="sidebar" />}
      </div>
      {sessions.length > 0 && (
        <div className="proj-sessions">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`sess-row ${needsMe(s.activity) && s.lifecycle === 'running' ? 'needs' : ''}`}
              onClick={() => focusSession(s.id)}
              title={s.taskTitle ?? s.title}
            >
              <AgentIcon agent={s.foreground ?? s.agent} />
              <span className="sess-title">{s.taskTitle || s.title}</span>
              <ActivityBadge activity={s.activity} lifecycle={s.lifecycle} source={s.activitySource} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Botão 📊: abre o painel de uso; a barrinha é a sessão de 5 h do Claude (o que mais acaba durante o dia).
function UsageButton() {
  const card = useStore((s) => s.usageCard)
  const session = card?.windows.find((w) => w.label.startsWith('Sessão'))
  const week = card?.windows.find((w) => w.label === 'Semana')
  const fresh = session && (!session.resetsAt || session.resetsAt > Date.now())
  const tip = fresh
    ? `Claude · sessão ${Math.round(session!.percent)}%${session!.resetsAt ? ` · renova em ${until(session!.resetsAt)}` : ''}${week ? ` · semana ${Math.round(week.percent)}%` : ''}`
    : 'Uso dos modelos (⌘⇧U)'
  return (
    <button className="usage-btn" onClick={() => void runCommand('usage')} title={tip}>
      <span>📊 Uso</span>
      {fresh && (
        <>
          <span className="usage-mini"><i className={level(session!.percent)} style={{ width: `${Math.min(100, session!.percent)}%` }} /></span>
          <span className={`usage-pct ${level(session!.percent)}`}>{Math.round(session!.percent)}%</span>
        </>
      )}
    </button>
  )
}

// "Atualizar Cockpit" (igual ao Hermes): recompila do código-fonte, instala e reabre. O ponto avisa que há código novo.
function UpdateButton() {
  const status = useStore((s) => s.updateStatus)
  const running = useStore((s) => !!s.update && !s.update.failed)
  if (!status?.supported) return null
  return (
    <button
      className={`icon-btn update-btn ${running ? 'busy' : ''} ${status.available && !running ? 'has-update' : ''}`}
      onClick={() => void startUpdate()}
      title={running ? 'Atualizando Cockpit…' : status.available ? 'Atualizar Cockpit (há código novo)' : 'Atualizar Cockpit'}
      aria-label={running ? 'Atualizando Cockpit' : 'Atualizar Cockpit'}
    >
      <span className="update-glyph">↻</span>
    </button>
  )
}
