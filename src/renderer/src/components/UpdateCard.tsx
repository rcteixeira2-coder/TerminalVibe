import { useEffect, useState } from 'react'
import { UPDATE_STEPS } from '@shared/types'
import { actions, useStore } from '../state/store'
import { Button } from './ui'

// "Atualizar Cockpit": o que o cartão do topo esquerdo mostra enquanto scripts/install-mac.sh roda (igual ao Hermes).
// Não bloqueia a tela: dá para continuar usando o Cockpit enquanto compila.
export function UpdateCard() {
  const update = useStore((s) => s.update)
  const closingShells = useStore((s) => s.updateStatus?.closingShells ?? 0)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!update || update.failed) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [update])
  if (!update) return null

  const failed = !!update.failed
  const current = UPDATE_STEPS.findIndex((s) => s.id === update.step)
  const seconds = Math.max(0, Math.floor((now - update.startedAt) / 1000))
  const elapsed = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`

  return (
    <div className={`update-card ${failed ? 'failed' : ''}`} role="status" aria-live="polite">
      <div className="update-head">
        <span className="update-icon">{failed ? '⚠︎' : '↻'}</span>
        <div>
          <div className="update-title">{failed ? 'Não consegui atualizar' : 'Atualizando o Cockpit'}</div>
          <div className="update-sub">{failed ? 'A versão atual continua aberta.' : `${elapsed} · o Cockpit reabre sozinho no fim`}</div>
        </div>
      </div>
      <ol className="update-steps">
        {UPDATE_STEPS.map((s, i) => {
          const state = i < current ? 'done' : i === current ? (failed ? 'error' : 'current') : 'pending'
          const label = { done: 'feito', current: 'em andamento', error: 'falhou', pending: 'pendente' }[state]
          return (
            <li key={s.id} className={`update-step ${state}`} aria-label={`${s.title}: ${label}`}>
              <span className="update-mark">{state === 'done' ? '✓' : state === 'error' ? '✕' : state === 'current' ? <span className="update-spin" /> : ''}</span>
              {s.title}
            </li>
          )
        })}
      </ol>
      {failed ? (
        <>
          <pre className="update-log">{update.failed}</pre>
          <div className="update-actions">
            <Button size="sm" onClick={() => actions.set({ update: null })}>Fechar</Button>
            <Button size="sm" variant="primary" onClick={() => void window.cockpit.invoke('update:relaunch')}>Reiniciar sem atualizar</Button>
          </div>
        </>
      ) : (
        <>
          {update.line && <div className="update-line">{update.line}</div>}
          {closingShells > 0 && (
            <div className="update-warn">
              {closingShells === 1 ? '1 terminal shell será fechado' : `${closingShells} terminais shell serão fechados`} ao reiniciar. Claude e Codex reabrem para retomar.
            </div>
          )}
        </>
      )}
    </div>
  )
}
