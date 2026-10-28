import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, LaunchTarget } from '@shared/types'
import { AGENT_LABEL } from '@shared/types'
import { ACTIVITY_LABEL } from '@shared/status'
import { actions, useStore } from '../state/store'
import { focusSession, invokeMod, runCommand, runLaunchTarget, selectProject, sidebarOrder, spawn } from '../controller'

interface Item {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

function score(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const i = t.indexOf(q)
  if (i >= 0) return 100 - i
  // subsequência
  let ti = 0
  for (const c of q) {
    ti = t.indexOf(c, ti)
    if (ti < 0) return 0
    ti++
  }
  return 10
}

export function Palette() {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [targets, setTargets] = useState<LaunchTarget[]>([])
  const input = useRef<HTMLInputElement>(null)
  const sessions = useStore((s) => s.sessions)
  const projectsState = useStore((s) => s.projects)
  const pid = useStore((s) => s.activeProjectId)
  const commands = useStore((s) => s.mods.commands)
  const close = () => actions.set({ overlay: null })

  useEffect(() => {
    input.current?.focus()
    if (pid) void window.cockpit.invoke('launch:targets', pid).then(setTargets)
  }, [pid])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const project = projectsState.find((p) => p.id === pid)
    if (project) {
      for (const a of ['claude', 'codex', 'shell'] as Agent[])
        out.push({ id: `new:${a}`, group: project.name, label: `Novo ${AGENT_LABEL[a]} em ${project.name}`, run: () => void spawn(project.id, a) })
      for (const t of targets)
        out.push({ id: `run:${t.id}`, group: 'Rodar', label: `▶ ${t.title}`, hint: t.detail, run: () => void runLaunchTarget(project.id, t.id) })
    }
    for (const s of Object.values(sessions)) {
      const p = projectsState.find((x) => x.id === s.projectId)
      out.push({
        id: `s:${s.id}`, group: 'Sessões', label: `${p?.name ?? ''} · ${s.taskTitle || s.title}`,
        hint: s.lifecycle === 'running' ? ACTIVITY_LABEL[s.activity] : 'parada', run: () => focusSession(s.id),
      })
    }
    for (const c of commands) out.push({ id: `m:${c.modId}:${c.id}`, group: 'Mods', label: c.title, hint: c.modId, run: () => void invokeMod(c.modId, c.id) })
    const cmds: [string, string, string][] = [
      ['grid', 'Grade de sessões', '⌘G'], ['nextNeedsMe', 'Próxima que precisa de mim', '⌘J'], ['newTab', 'Nova aba', '⌘T'],
      ['split:shell', 'Dividir com terminal', '⌘D'], ['split:claude', 'Dividir com Claude', '⌘⇧D'], ['split:codex', 'Dividir com Codex', ''],
      ['tree', 'Mostrar/esconder arquivos', '⌘E'], ['browser', 'Mostrar/esconder browser', '⌘⇧B'], ['sidebar', 'Mostrar/esconder barra lateral', '⌘B'],
      ['mods', 'Gerenciar mods', ''], ['claudeMods', 'Mods do Claude', ''], ['prefs', 'Preferências', '⌘,'], ['usage', 'Uso dos modelos (Claude, Codex, APIs)', '⌘⇧U'], ['components', 'Componentes (base de design)', ''], ['find', 'Buscar no terminal', '⌘F'], ['clear', 'Limpar tela', '⌘⇧K'], ['update', 'Atualizar Cockpit (recompilar e reiniciar)', ''],
    ]
    for (const [c, l, h] of cmds) out.push({ id: `c:${c}`, group: 'Comandos', label: l, hint: h, run: () => void runCommand(c) })
    for (const p of sidebarOrder()) out.push({ id: `p:${p.id}`, group: 'Projetos', label: p.name, hint: p.favorite ? '★' : '', run: () => selectProject(p.id) })
    return out
  }, [sessions, projectsState, pid, targets, commands])

  const query = q.trim().toLowerCase()
  const filtered = items
    .map((it) => ({ it, s: score(`${it.label} ${it.hint ?? ''}`, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map((x) => x.it)

  useEffect(() => setIdx(0), [q])

  const pick = (it?: Item) => {
    if (!it) return
    close()
    it.run()
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Ir para projeto, sessão, comando ou mod…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(filtered.length - 1, i + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
            else if (e.key === 'Enter') pick(filtered[idx])
          }}
        />
        <div className="palette-list">
          {filtered.map((it, i) => (
            <button key={it.id} className={`palette-item ${i === idx ? 'on' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => pick(it)}>
              <span className="pi-group">{it.group}</span>
              <span className="pi-label">{it.label}</span>
              {it.hint && <span className="pi-hint">{it.hint}</span>}
            </button>
          ))}
          {!filtered.length && <div className="dd-empty">Nada encontrado.</div>}
        </div>
      </div>
    </div>
  )
}
