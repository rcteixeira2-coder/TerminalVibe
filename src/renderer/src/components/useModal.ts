import { useEffect, useRef } from 'react'
import { actions } from '../state/store'
import { focusTerminal } from '../terminal/registry'

// Modais: tiram o foco do xterm (senão Esc vira ⎋ no Claude) e fecham com Esc na fase de captura.
// Ao fechar, o foco volta ao terminal que estava em uso.
export function useModal<T extends HTMLElement>(close: () => void) {
  const ref = useRef<T>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const id = actions.get().focusedSessionId
      if (id) setTimeout(() => focusTerminal(id), 0)
    }
  }, [])
  return ref
}
