import { useEffect, useRef } from 'react'
import type { SessionInfo } from '@shared/types'
import { needsMe } from '@shared/status'
import { actions, toast, useStore } from '../state/store'
import { closePane, spawn } from '../controller'
import { attachTerminal, detachTerminal, fitTerminal, focusTerminal } from '../terminal/registry'
import { AgentIcon, StatePill, stateText } from './StatusDot'
import { ModelBar } from './ModelBar'

// Painéis montados = visíveis; o main usa isso para decidir se avisa (notificação) ou não.
const mounted = new Set<string>()
function reportVisible() {
  window.cockpit.send('session:visible', [...mounted])
}

export function PaneView({ session, closable, maximized, onMaximize }: { session: SessionInfo; closable: boolean; maximized?: boolean; onMaximize?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const focused = useStore((s) => s.focusedSessionId === session.id)
  const running = session.lifecycle === 'running'
  const stopping = session.lifecycle === 'stopping'
  const id = session.id

  useEffect(() => {
    const el = host.current
    if (!el) return
    attachTerminal(id, el)
    mounted.add(id)
    reportVisible()
    let timer: number | null = null
    const ro = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer)
      // Debounce: o Claude refaz o layout a cada resize; animações dos mods quebram se for contínuo.
      timer = window.setTimeout(() => fitTerminal(id), 80)
    })
    ro.observe(el)
    requestAnimationFrame(() => {
      fitTerminal(id)
      // O foco pedido antes do xterm abrir no DOM se perde: aplica agora.
      if (actions.get().focusedSessionId === id) focusTerminal(id)
    })
    return () => {
      ro.disconnect()
      if (timer) window.clearTimeout(timer)
      mounted.delete(id)
      reportVisible()
      detachTerminal(id)
    }
  }, [id])

  useEffect(() => {
    if (focused) focusTerminal(id)
  }, [focused, id])

  const onDrop = (e: React.DragEvent) => {
    // Terminal arrastado pelo cabeçalho: quem trata é o espaço do layout.
    if (e.dataTransfer.types.includes('application/x-cockpit-pane')) return
    e.preventDefault()
    const paths: string[] = []
    const internal = e.dataTransfer.getData('application/x-cockpit-path')
    if (internal) paths.push(internal)
    else for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.cockpit.pathForFile(f)
      if (p) paths.push(p)
    }
    // Arrastar arquivo = caminho entre aspas, sem Enter.
    for (const p of paths) void window.cockpit.invoke('sessions:insertPath', id, p).then((ok) => {
      if (!ok) {
        toast('Não foi possível inserir este caminho (arquivo inexistente ou nome com caracteres de controle).', 'error')
      }
    })
    focusTerminal(id)
  }

  const onMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    const r = await window.cockpit.invoke('ui:contextMenu', 'session', {})
    if (r === 'interrupt') void window.cockpit.invoke('sessions:interrupt', id)
    if (r === 'kill') void window.cockpit.invoke('sessions:kill', id)
    if (r === 'close') void closePane(id)
  }

  const agent = session.foreground ?? session.agent
  // Precisa de você (sua vez, aprovação, erro): cabeçalho em cor sólida + moldura + botão para responder.
  const urgent = running && needsMe(session.activity)
  const cta = session.activity === 'needs_approval' ? 'Ver aprovação ↵' : session.activity === 'error' ? 'Ver erro ↵' : 'Responder ↵'
  const focusHere = () => {
    actions.set({ focusedSessionId: id })
    setTimeout(() => focusTerminal(id), 0)
  }
  return (
    <div className={`pane ${focused ? 'focused' : ''} activity-${running ? session.activity : 'dead'} ${urgent ? 'needs-me' : ''}`}>
      {/* Duas linhas de altura fixa: trocar de estado nunca muda o tamanho do terminal (sem refit/redesenho). */}
      <div className="pane-cap">
        <div
          className="pane-head"
          onContextMenu={onMenu}
          onDoubleClick={() => focusTerminal(id)}
          draggable
          title="Arraste para mudar o terminal de lugar"
          onDragStart={(e) => {
            if ((e.target as HTMLElement).closest('button')) return e.preventDefault()
            e.dataTransfer.setData('application/x-cockpit-pane', id)
            e.dataTransfer.effectAllowed = 'move'
            // Mudar o DOM dentro do dragstart cancela o arrasto no Chromium: as áreas de soltar aparecem no próximo tick.
            setTimeout(() => actions.set({ draggingPane: id }), 0)
          }}
          onDragEnd={() => actions.set({ draggingPane: null })}
        >
          <AgentIcon agent={agent} />
          {/* A tarefa é o que importa; "Claude 3" vem pequeno ao lado. */}
          {session.taskTitle && <span className="pane-task" title={session.taskTitle}>{session.taskTitle}</span>}
          <span className="pane-title">{session.title}</span>
          {session.modTyped && <span className="badge badge-mod" title="Um mod digitou nesta sessão">mod digitou</span>}
          <span className="spacer" />
          {/* Ações repetidas em todo painel: só no hover ou no painel em foco (continuam no DOM, sem mudar a largura). */}
          <span className="pane-actions">
            {agent === 'claude' && (
              <button
                className="ghost-btn small claude-mods-btn"
                onClick={() => actions.set({ overlay: 'claudeMods', claudeModsFor: id })}
                title="Ligar e desligar os mods do Claude Code"
              >✳ Mods</button>
            )}
            {(running || stopping) && (
              <>
                {/* Painel estreito: rótulo curto (o nome acessível continua o longo). */}
                <button className="ghost-btn small" aria-label="Interromper" onClick={() => void window.cockpit.invoke('sessions:interrupt', id)} title="Interromper — envia ⌃C (⌘.)">
                  <span className="lbl-long">Interromper</span><span className="lbl-short">⌃C</span>
                </button>
                <button className="ghost-btn small danger" aria-label="Encerrar" disabled={stopping} onClick={() => void window.cockpit.invoke('sessions:kill', id)} title="Encerrar a sessão">
                  <span className="lbl-long">Encerrar</span><span className="lbl-short">■</span>
                </button>
              </>
            )}
          </span>
          {onMaximize && (
            <button className="icon-btn small max-btn" onClick={onMaximize} title={maximized ? 'Voltar ao layout (⌘⇧↩)' : 'Expandir para a aba toda (⌘⇧↩)'}>{maximized ? '⤡' : '⤢'}</button>
          )}
          {closable && <button className="tab-x" onClick={() => void closePane(id)} title="Fechar painel">×</button>}
        </div>
        <div className="pane-status">
          <StatePill activity={session.activity} lifecycle={session.lifecycle} source={session.activitySource} />
          <span className="pane-status-text">{stateText(session.activity, running, session.activityDetail, session.message)}</span>
          {urgent && (
            <button className="pane-cta" aria-label={cta.replace(' ↵', '')} onClick={focusHere}>
              <span className="lbl-long">{cta}</span><span className="lbl-short">{cta.split(' ')[0]} ↵</span>
            </button>
          )}
          {/* Sessão parada: o que fazer fica na linha do estado (o cabeçalho só tem identidade, ⤢ e ×). */}
          {!(running || stopping) && (
            <>
              {session.agent !== 'shell' && (
                <button className="ghost-btn small" onClick={() => void restart(session, true)}>↻ Retomar conversa</button>
              )}
              <button className="ghost-btn small" onClick={() => void restart(session, false)}>Nova sessão</button>
            </>
          )}
        </div>
        <div className="pane-progress" />
      </div>
      <div
        className="pane-body"
        ref={host}
        onMouseDown={focusHere}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      />
      <ModelBar session={session} />
    </div>
  )
}

// Retomar/Nova sessão: a sessão nova ocupa o lugar do painel parado (e retoma exatamente a conversa dele).
async function restart(s: SessionInfo, resume: boolean) {
  const next = await spawn(s.projectId, s.agent, {
    resume, title: s.title, replace: s.id, claudeSessionId: resume ? s.claudeSessionId : undefined,
  })
  if (next) void window.cockpit.invoke('sessions:dispose', s.id)
}
