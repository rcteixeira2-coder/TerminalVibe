import { useEffect, useState } from 'react'
import type { AgentProviderId } from '@shared/types'
import { actions, useStore } from '../../state/store'
import { loadAgentModels, selectAgentModel } from '../../controller'
import { Dropdown } from '../ProjectView'

export function ModelPicker() {
  const cfg = useStore((s) => s.agentConfig)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const current = cfg.providers.find((p) => p.id === cfg.provider)
  useEffect(() => {
    if (!open) return
    for (const p of cfg.providers) if (p.configured && !cfg.models[p.id]) void loadAgentModels(p.id, { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const pick = (provider: AgentProviderId, model: string) => {
    selectAgentModel(provider, model)
    setOpen(false)
  }
  const q = filter.toLowerCase()
  return (
    <div className="menu-wrap">
      <button className="ghost-btn small model-btn" onClick={() => setOpen(!open)} title="Escolher modelo">
        <span className="muted">{current?.label.split(' ')[0] ?? 'Modelo'}</span> {cfg.model || 'escolher'} ▾
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)} wide align="left">
          <input className="dd-filter" autoFocus placeholder="Filtrar modelos…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {cfg.providers.map((p) => {
            const list = (cfg.models[p.id] ?? (p.defaultModel ? [p.defaultModel] : [])).filter((m) => !q || m.toLowerCase().includes(q))
            return (
              <div key={p.id}>
                <div className="dd-title">{p.label}</div>
                {!p.configured ? (
                  <button className="dd-item" onClick={() => { setOpen(false); actions.set({ overlay: 'prefs' }) }}>
                    <span className="muted">configurar chave…</span>
                  </button>
                ) : cfg.modelErrors[p.id] && !cfg.models[p.id] ? (
                  <div className="dd-empty">
                    {cfg.modelErrors[p.id]}{' '}
                    <button className="link-btn" onClick={() => void loadAgentModels(p.id, { silent: true })}>tentar de novo</button>
                  </div>
                ) : list.length ? (
                  list.slice(0, 40).map((m) => (
                    <button key={m} className={`dd-item ${cfg.provider === p.id && cfg.model === m ? 'selected' : ''}`} onClick={() => pick(p.id, m)}>
                      {m}
                    </button>
                  ))
                ) : (
                  <div className="dd-empty">{cfg.models[p.id] ? 'Nenhum modelo.' : 'Carregando…'}</div>
                )}
              </div>
            )
          })}
        </Dropdown>
      )}
    </div>
  )
}
