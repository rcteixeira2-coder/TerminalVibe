import { useEffect, useRef, useState } from 'react'
import type { AgentAttachment } from '@shared/types'
import { actions, agentPane, setAgentPane, toast, useStore } from '../../state/store'
import { sendToAgent, stopAgent } from '../../controller'

export function Composer({ projectId }: { projectId: string }) {
  const draft = useStore((s) => s.agent[projectId]?.draft ?? '')
  const attachments = useStore((s) => s.agent[projectId]?.attachments) ?? []
  const streaming = useStore((s) => !!s.agent[projectId]?.streaming)
  const [picker, setPicker] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ta.current?.focus()
  }, [projectId])

  // @arquivo: autocomplete enquanto digita depois de "@"
  useEffect(() => {
    const m = draft.match(/(?:^|\s)@([\w./-]*)$/)
    if (!m) {
      setPicker(null)
      return
    }
    setQuery(m[1])
    const t = setTimeout(() => void window.cockpit.invoke('agent:findFiles', projectId, m[1]).then(setPicker), 120)
    return () => clearTimeout(t)
  }, [draft, projectId])

  const addAttachment = (a: AgentAttachment) => {
    const cur = agentPane(projectId).attachments
    if (cur.some((x) => x.kind === a.kind && x.path === a.path && x.sessionId === a.sessionId)) return
    setAgentPane(projectId, { attachments: [...cur, a] })
  }

  const pickFile = (rel: string) => {
    addAttachment({ kind: 'file', label: rel, path: rel })
    setAgentPane(projectId, { draft: draft.replace(/@[\w./-]*$/, '') })
    setPicker(null)
    ta.current?.focus()
  }

  const attachTerminal = () => {
    const { focusedSessionId, sessions } = actions.get()
    const focused = focusedSessionId ? sessions[focusedSessionId] : undefined
    const s = (focused?.projectId === projectId ? focused : undefined) ??
      Object.values(sessions).find((x) => x.projectId === projectId && x.lifecycle === 'running')
    if (!s) {
      toast('Nenhum terminal aberto neste projeto.')
      return
    }
    addAttachment({ kind: 'terminal', label: `saída de ${s.title}`, sessionId: s.id })
  }

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a, i) => (
            <span key={i} className="attach-chip">
              {a.kind === 'file' ? '📄' : '›_'} {a.label}
              <button className="chip-x" onClick={() => setAgentPane(projectId, { attachments: attachments.filter((_, j) => j !== i) })}>×</button>
            </span>
          ))}
        </div>
      )}
      {picker && picker.length > 0 && (
        <div className="file-picker">
          {picker.slice(0, 12).map((f) => (
            <button key={f} className="dd-item" onMouseDown={(e) => { e.preventDefault(); pickFile(f) }}>{f}</button>
          ))}
          <div className="muted small">@{query} · Enter escolhe o primeiro</div>
        </div>
      )}
      <textarea
        ref={ta}
        value={draft}
        placeholder="Pergunte sobre o projeto…  (@ anexa arquivo · Shift+Enter quebra linha)"
        rows={3}
        onChange={(e) => setAgentPane(projectId, { draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (picker && picker.length) pickFile(picker[0])
            else void sendToAgent(projectId)
          }
          if (e.key === 'Escape' && picker) setPicker(null)
        }}
      />
      <div className="composer-bar">
        <button className="icon-btn small" title="Anexar arquivo (@)" onClick={() => { setAgentPane(projectId, { draft: `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@` }); ta.current?.focus() }}>@</button>
        <button className="icon-btn small" title="Anexar a saída recente do terminal focado" onClick={attachTerminal}>›_ terminal</button>
        <span className="spacer" />
        {streaming ? (
          <button className="ghost-btn small danger" onClick={() => stopAgent(projectId)}>■ Parar</button>
        ) : (
          <button className="ghost-btn small send" disabled={!draft.trim()} onClick={() => void sendToAgent(projectId)}>Enviar ↵</button>
        )}
      </div>
    </div>
  )
}
