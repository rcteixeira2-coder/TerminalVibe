import { actions, useStore } from '../state/store'
import { useModal } from './useModal'

const PERM_LABEL: Record<string, string> = {
  'session.events': 'ver o estado das sessões (nunca o conteúdo)',
  'session.write': 'digitar nas sessões (pede sua confirmação)',
  notify: 'mostrar avisos',
  browser: 'abrir páginas no browser lateral',
}

export function ModsView() {
  const snap = useStore((s) => s.mods)
  const close = () => actions.set({ overlay: null })
  const dialog = useModal<HTMLDivElement>(close)
  const refresh = async (p: Promise<unknown>) => {
    await p
    actions.set({ mods: await window.cockpit.invoke('mods:snapshot') })
  }
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="sheet" ref={dialog} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Mods do Cockpit</h2>
          <span className="spacer" />
          <button className="ghost-btn small" onClick={() => void window.cockpit.invoke('mods:openFolder')}>Abrir pasta</button>
          <button className="ghost-btn small" onClick={() => void refresh(window.cockpit.invoke('mods:reload'))}>Recarregar</button>
          <button className="icon-btn" onClick={close}>×</button>
        </div>
        <p className="muted small">
          Mods ficam em <code>~/.cockpit/mods/&lt;id&gt;/manifest.json</code>. Eles adicionam botões, comandos (⌘K), painéis e reações aos eventos
          das sessões, rodando isolados e sem acesso à internet. Não confunda com os mods do Claude Code (<code>~/.claude/mods</code>), que rodam
          dentro do próprio Claude e continuam funcionando aqui.
        </p>
        {snap.mods.length === 0 && <div className="dd-empty">Nenhum mod instalado.</div>}
        {snap.mods.map((m) => (
          <div key={m.id} className={`mod-row ${m.error ? 'err' : ''}`}>
            <div className="mod-main">
              <div className="mod-name">
                {m.name} <span className="muted small">v{m.version} · {m.id}{m.hasScript ? ' · script' : ' · declarativo'}</span>
              </div>
              {m.description && <div className="small">{m.description}</div>}
              {m.error && <div className="error small">{m.error}</div>}
              {m.permissions.length > 0 && (
                <ul className="perms">
                  {m.permissions.map((p) => <li key={p}>{PERM_LABEL[p] ?? p}</li>)}
                </ul>
              )}
              <div className="mod-panels">
                {snap.panels.filter((p) => p.modId === m.id).map((p) => (
                  <button key={p.id} className="ghost-btn small" onClick={() => actions.set({ overlay: null, modPanel: { modId: m.id, id: p.id } })}>
                    Abrir painel: {p.title}
                  </button>
                ))}
              </div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={m.enabled} onChange={(e) => void refresh(window.cockpit.invoke('mods:setEnabled', m.id, e.target.checked))} />
              <span />
            </label>
          </div>
        ))}
      </div>
    </div>
  )
}

// Painel HTML de mod: iframe sandbox (sem mesmo-origem), conversa por postMessage.
export function ModPanelDrawer() {
  const modPanel = useStore((s) => s.modPanel)
  const panels = useStore((s) => s.mods.panels)
  if (!modPanel) return null
  const p = panels.find((x) => x.modId === modPanel.modId && x.id === modPanel.id)
  if (!p) return null
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span>{p.title}</span>
        <span className="muted small">mod: {p.modId}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => actions.set({ modPanel: null })}>×</button>
      </div>
      <iframe key={`${p.modId}:${p.id}`} className="drawer-frame" src={p.url} sandbox="allow-scripts" data-mod={p.modId} data-panel={p.id} title={p.title} />
    </div>
  )
}
