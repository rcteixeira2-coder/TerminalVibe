import { useEffect, useState } from 'react'
import type { ClaudeModInfo, ClaudeModsSnapshot } from '@shared/types'
import { actions, useStore } from '../state/store'
import { restartClaude } from '../controller'
import { useModal } from './useModal'
import { loadCatalog } from '../modelSwitch'

// Botão do canto superior direito do projeto: abre os mods do Claude Code.
export function ClaudeModsButton() {
  const open = useStore((s) => s.overlay === 'claudeMods')
  return (
    <button className={`ghost-btn small claude-mods-btn ${open ? 'on' : ''}`} onClick={() => actions.set({ overlay: open ? null : 'claudeMods', claudeModsFor: null })} title="Mods do Claude Code">
      ✳ Mods
    </button>
  )
}

export function ClaudeModsView() {
  const [snap, setSnap] = useState<ClaudeModsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const forId = useStore((s) => s.claudeModsFor)
  const forSession = useStore((s) => (forId ? s.sessions[forId] : undefined))
  const [restarting, setRestarting] = useState(false)
  const close = () => actions.set({ overlay: null, claudeModsFor: null })
  const dialog = useModal<HTMLDivElement>(close)
  const load = async () => setSnap(await window.cockpit.invoke('claudeMods:snapshot'))
  useEffect(() => {
    void load()
  }, [])
  const toggle = async (key: string, on: boolean) => {
    const r = await window.cockpit.invoke('claudeMods:setEnabled', key, on)
    if (!('mods' in r)) return setError(r.error)
    setError(null)
    setChanged(true)
    setSnap(r)
    void loadCatalog(true)
  }
  const row = (m: ClaudeModInfo) => (
    <label key={m.key} className="pref">
      <div>
        <div className="mod-name">
          {m.name} <span className="muted small">{m.version ? `v${m.version} · ` : ''}{m.key}</span>
        </div>
        {m.description && <div className="muted small">{m.description}</div>}
      </div>
      <span className="switch">
        <input type="checkbox" checked={m.enabled} onChange={(e) => void toggle(m.key, e.target.checked)} />
        <span />
      </span>
    </label>
  )
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="sheet" ref={dialog} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Mods do Claude</h2>
          <span className="spacer" />
          <button className="ghost-btn small" onClick={() => void window.cockpit.invoke('claudeMods:openFolder')}>Abrir pasta</button>
          <button className="ghost-btn small" onClick={() => void load()}>Recarregar</button>
          <button className="icon-btn" onClick={close}>×</button>
        </div>
        <p className="muted small">
          Liga e desliga os mods de <code>~/.claude/mods</code> (e os outros plugins) no <code>~/.claude/settings.json</code>. Vale para todas as
          sessões novas do Claude, aqui e no Cursor; as que já estão abertas precisam ser reiniciadas.
        </p>
        {changed && <div className="ok-text small">Salvo. Abra uma sessão nova do Claude (ou reinicie a atual) para aplicar.</div>}
        {changed && forSession && (
          <div className="claude-mods-restart">
            {forSession.agent === 'claude' && forSession.claudeSessionId ? (
              <>
                <span className="small">Aplicar agora em <b>{forSession.taskTitle || forSession.title}</b>: encerra e retoma a mesma conversa.</span>
                <button
                  className="ghost-btn small send"
                  disabled={restarting}
                  onClick={async () => {
                    setRestarting(true)
                    const ok = !!(await restartClaude(forSession.id))
                    setRestarting(false)
                    if (ok) close()
                    else setError('Não consegui reiniciar esta sessão. Use "↻ Retomar conversa" no painel.')
                  }}
                >{restarting ? 'Reiniciando…' : '↻ Reiniciar e retomar'}</button>
              </>
            ) : (
              <span className="small muted">Este Claude foi aberto dentro de um terminal: saia dele (/exit) e abra de novo para aplicar.</span>
            )}
          </div>
        )}
        {(error || snap?.error) && <div className="error small">{error ?? snap?.error}</div>}
        {snap && snap.mods.length === 0 && <div className="dd-empty">Nenhum mod em ~/.claude/mods.</div>}
        {snap?.mods.map(row)}
        {snap && snap.plugins.length > 0 && (
          <>
            <div className="side-title claude-mods-sub">Outros plugins</div>
            {snap.plugins.map(row)}
          </>
        )}
      </div>
    </div>
  )
}
