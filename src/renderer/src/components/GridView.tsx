import { useEffect, useState } from 'react'
import type { SessionInfo } from '@shared/types'
import { needsMe } from '@shared/status'
import { needsMeOrder, useStore } from '../state/store'
import { focusSession } from '../controller'
import { tailText } from '../terminal/registry'
import { ActivityBadge, AgentIcon, StatusDot } from './StatusDot'

type Filter = 'all' | 'needs' | 'working'

// Todas as sessões de todos os projetos. Cards com as últimas linhas (1 fps): não criamos um segundo
// xterm por sessão e o pty nunca é redimensionado por causa da grade.
export function GridView() {
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const [filter, setFilter] = useState<Filter>('all')
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [])
  const list = needsMeOrder(Object.values(sessions)).filter((s) => {
    if (filter === 'needs') return s.lifecycle === 'running' && needsMe(s.activity)
    if (filter === 'working') return s.lifecycle === 'running' && s.activity === 'working'
    return true
  })
  const byId = new Map(projects.map((p) => [p.id, p]))
  return (
    <div className="grid-view">
      <div className="grid-head">
        <h2>Sessões</h2>
        <div className="seg">
          {([['all', 'Todas'], ['needs', 'Precisam de mim'], ['working', 'Trabalhando']] as [Filter, string][]).map(([f, l]) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{l}</button>
          ))}
        </div>
        <span className="muted small">Clique para abrir · ⌘G volta</span>
      </div>
      {list.length === 0 ? (
        <div className="empty"><p className="muted">Nenhuma sessão {filter === 'all' ? 'aberta' : 'neste filtro'}.</p></div>
      ) : (
        <div className="grid-cards">
          {list.map((s) => <Card key={s.id} s={s} color={byId.get(s.projectId)?.color ?? '#888'} project={byId.get(s.projectId)?.name ?? ''} />)}
        </div>
      )}
    </div>
  )
}

function Card({ s, color, project }: { s: SessionInfo; color: string; project: string }) {
  const alert = s.lifecycle === 'running' && needsMe(s.activity)
  return (
    <button className={`card ${alert ? 'alert' : ''} activity-${s.lifecycle === 'running' ? s.activity : 'dead'}`} style={{ ['--pc' as string]: color }} onClick={() => focusSession(s.id)}>
      <div className="card-head">
        <StatusDot activity={s.activity} lifecycle={s.lifecycle} />
        <span className="card-project">{project}</span>
        <AgentIcon agent={s.foreground ?? s.agent} />
        <span className="card-title">{s.title}</span>
        <span className="spacer" />
        <ActivityBadge activity={s.activity} lifecycle={s.lifecycle} source={s.activitySource} />
      </div>
      {s.taskTitle && <div className="card-task">{s.taskTitle}</div>}
      {s.activityDetail && alert && <div className={`card-detail banner-${s.activity}`}>{s.activityDetail}</div>}
      <pre className="card-tail">{tailText(s.id) || ' '}</pre>
    </button>
  )
}
