import { useState } from 'react'
import { useStore } from '../state/store'
import { applyPreset, cellIds, runCommand } from '../controller'
import { PRESET_GROUPS, slotRects, type LayoutNode } from '../layout/presets'
import { Dropdown } from './ProjectView'

export function LayoutIcon({ tree }: { tree: LayoutNode }) {
  const W = 26
  const H = 17
  const g = 1.2
  return (
    <svg className="layout-icon" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {slotRects(tree).map((r) => (
        <rect key={r.slot} x={r.x * W + g / 2} y={r.y * H + g / 2} width={Math.max(1, r.w * W - g)} height={Math.max(1, r.h * H - g)} rx={1.5} />
      ))}
    </svg>
  )
}

const AUTO: LayoutNode = { dir: 'row', parts: [0, 1, 2], ratio: [1, 1, 1] }

// Botão ▦ da barra lateral: escolhe o layout dos terminais da aba atual (e abre a grade de todas as sessões).
export function LayoutMenu() {
  const [open, setOpen] = useState(false)
  const view = useStore((s) => s.view)
  const pid = useStore((s) => s.activeProjectId)
  // Lê do estado (sem criar layout durante o render).
  const layout = useStore((s) => (pid ? s.layouts[pid] : undefined))
  useStore((s) => s.sessions)
  const tab = layout ? (layout.tabs.find((t) => t.id === layout.activeTabId) ?? layout.tabs[0] ?? null) : null
  const count = tab ? cellIds(tab).length : 0
  const pick = (id: string | null) => {
    setOpen(false)
    applyPreset(id)
  }
  return (
    <div className="menu-wrap">
      <button className={`icon-btn ${open || view === 'grid' ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Layout dos terminais">▦</button>
      {open && (
        <Dropdown onClose={() => setOpen(false)} align="left">
          <div className="layout-menu">
            <div className="dd-title">{pid ? 'Layout da aba' : 'Abra um projeto para escolher o layout'}</div>
            <button className={`layout-item ${tab && !tab.preset ? 'on' : ''}`} disabled={!pid} onClick={() => pick(null)}>
              <LayoutIcon tree={AUTO} />
              <span>Automático (lado a lado)</span>
            </button>
            {PRESET_GROUPS.map((group, gi) => (
              <div key={gi}>
                <div className="dd-sep" />
                {group.map((p) => {
                  const tooSmall = count > p.slots
                  return (
                    <button
                      key={p.id}
                      className={`layout-item ${tab?.preset === p.id ? 'on' : ''}`}
                      disabled={!pid || tooSmall}
                      title={tooSmall ? `A aba tem ${count} itens e este layout tem ${p.slots} espaço(s).` : undefined}
                      onClick={() => pick(p.id)}
                    >
                      <LayoutIcon tree={p.tree} />
                      <span>{p.label}</span>
                      <span className="li-count">{p.slots}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            <div className="dd-sep" />
            <button className={`layout-item ${view === 'grid' ? 'on' : ''}`} onClick={() => { setOpen(false); void runCommand('grid') }}>
              <span className="layout-icon-text">⊞</span>
              <span>Grade de todas as sessões</span>
              <span className="li-count">⌘G</span>
            </button>
            <div className="hint" style={{ padding: '6px 8px 2px', fontSize: 11, color: 'var(--muted)' }}>
              Arraste um terminal pelo cabeçalho para trocar de lugar. As divisórias ficam salvas.
            </div>
          </div>
        </Dropdown>
      )}
    </div>
  )
}
