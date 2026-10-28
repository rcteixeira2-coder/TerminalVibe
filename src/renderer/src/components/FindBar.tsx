import { useEffect, useRef, useState } from 'react'
import { actions, useStore } from '../state/store'
import { clearSearch, findNext, focusTerminal } from '../terminal/registry'

export function FindBar() {
  const id = useStore((s) => s.focusedSessionId)
  const [q, setQ] = useState('')
  const [miss, setMiss] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  if (!id) return null
  const close = () => {
    clearSearch(id)
    actions.set({ overlay: null })
    focusTerminal(id)
  }
  const go = (back = false) => setMiss(!findNext(id, q, back))
  return (
    <div className="findbar">
      <input
        ref={input}
        value={q}
        className={miss && q ? 'miss' : ''}
        placeholder="Buscar no terminal…"
        onChange={(e) => {
          setQ(e.target.value)
          setMiss(!findNext(id, e.target.value))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          if (e.key === 'Enter') go(e.shiftKey)
        }}
      />
      <button className="icon-btn small" onClick={() => go(true)}>↑</button>
      <button className="icon-btn small" onClick={() => go(false)}>↓</button>
      <button className="icon-btn small" onClick={close}>×</button>
    </div>
  )
}
