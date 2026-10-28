import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import type { AgentApproval } from '@shared/types'
import { answerApproval, deleteConversation, ensureAgentConfig, loadAgentSummaries, openConversation } from '../../controller'
import { Dropdown } from '../ProjectView'
import { ModelPicker } from './ModelPicker'
import { Composer } from './Composer'
import { MessageView, MessageActions, onMarkdownClick, renderMarkdown, Thinking, ToolChips } from './MessageView'

const SUGGESTIONS = ['Explique a estrutura deste projeto', 'Onde está o ponto de entrada do app?', 'O que o último terminal mostrou de erro?']

export function AgentPanel({ projectId }: { projectId: string }) {
  const pane = useStore((s) => s.agent[projectId])
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const cfg = useStore((s) => s.agentConfig)
  const approvals = useStore((s) => s.agent[projectId]?.approvals) ?? []
  const scroller = useRef<HTMLDivElement>(null)
  const [listOpen, setListOpen] = useState(false)
  const conv = pane?.conversation
  const streaming = pane?.streaming
  const anyConfigured = cfg.providers.some((p) => p.configured && (p.needsKey || p.id === 'claudecode'))

  useEffect(() => {
    ensureAgentConfig()
    void loadAgentSummaries(projectId)
  }, [projectId])

  // Rola junto com a resposta, a menos que o usuário tenha subido para ler.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [conv?.messages.length, streaming?.text, streaming?.tools.length, approvals.length])

  const liveHtml = useMemo(() => (streaming?.text ? renderMarkdown(streaming.text) : ''), [streaming?.text])

  return (
    <div className="agent">
      <div className="agent-head">
        <ModelPicker />
        <span className="spacer" />
        <div className="menu-wrap">
          <button className="ghost-btn small" onClick={() => setListOpen(!listOpen)} title="Conversas deste projeto">
            {conv ? conv.title.slice(0, 22) : 'Nova conversa'} ▾
          </button>
          {listOpen && (
            <Dropdown onClose={() => setListOpen(false)} wide>
              <button className="dd-item" onClick={() => { setListOpen(false); void openConversation(projectId, null) }}>＋ Nova conversa</button>
              {(pane?.summaries ?? []).length > 0 && <div className="dd-title">Anteriores</div>}
              {(pane?.summaries ?? []).map((c) => (
                <div key={c.id} className="dd-row">
                  <button className="dd-item" onClick={() => { setListOpen(false); void openConversation(projectId, c.id) }}>
                    <span>{c.title}</span>
                    <span className="dd-detail">{new Date(c.updatedAt).toLocaleString('pt-BR')} · {c.messages} msgs</span>
                  </button>
                  <button className="tab-x" title="Apagar conversa" onClick={() => void deleteConversation(projectId, c.id)}>×</button>
                </div>
              ))}
            </Dropdown>
          )}
        </div>
      </div>
      <div className="agent-scroll" ref={scroller}>
        {!conv && !streaming && (
          <div className="agent-empty">
            <div className="agent-empty-icon">✦</div>
            <h3>Agente de {project?.name ?? 'projeto'}</h3>
            <p className="muted small">
              Pergunte sobre o código: ele lê, lista e busca arquivos e vê a saída dos terminais deste projeto. Só leitura — nunca altera nada.
            </p>
            {!anyConfigured && (
              <p className="small">Instale e faça login no Claude Code para usar sua assinatura, ou configure uma chave (Grok, Claude API ou OpenAI) em <b>Preferências → Agente</b>.</p>
            )}
            <div className="agent-suggestions">
              {SUGGESTIONS.map((t) => (
                <button key={t} className="ghost-btn small" onClick={() => useStore.setState({ agent: { ...useStore.getState().agent, [projectId]: { ...(pane ?? { summaries: [], attachments: [] }), draft: t } } })}>{t}</button>
              ))}
            </div>
          </div>
        )}
        {conv?.messages.map((m) => <MessageView key={m.id} m={m} projectId={projectId} />)}
        {streaming && (
          <div className="msg assistant streaming">
            <Thinking text={streaming.thinking} live={!streaming.text} />
            <ToolChips tools={streaming.tools} />
            {streaming.text ? (
              <div className="md" onClick={(e) => void onMarkdownClick(e, projectId)} dangerouslySetInnerHTML={{ __html: liveHtml }} />
            ) : (
              !streaming.tools.length && <div className="typing"><span /><span /><span /></div>
            )}
            {streaming.notice && <div className="msg-notice">{streaming.notice}</div>}
            {streaming.text && <div className="msg-meta"><span className="spacer" /><MessageActions text={streaming.text} /></div>}
          </div>
        )}
        {approvals.map((a) => <ApprovalCard key={a.id} a={a} />)}
      </div>
      <Composer projectId={projectId} />
    </div>
  )
}

const APPROVAL_ICON: Record<AgentApproval['kind'], string> = { write: '📝', edit: '✏️', move: '↪️', mkdir: '📁', trash: '🗑', type: '⌨️', spawn: '▶' }

// Ação do agente parada esperando você: nada acontece até Aplicar.
function ApprovalCard({ a }: { a: AgentApproval }) {
  const [busy, setBusy] = useState(false)
  const decide = (ok: boolean) => {
    setBusy(true)
    answerApproval(a.id, ok)
  }
  return (
    <div className="approval-card">
      <div className="approval-head">
        <span>{APPROVAL_ICON[a.kind]}</span>
        <strong>{a.title}</strong>
        {a.project && <span className="muted small">· {a.project}</span>}
      </div>
      {a.detail && <pre className="approval-detail">{a.detail}</pre>}
      <div className="row">
        <span className="spacer" />
        <button className="ghost-btn small" disabled={busy} onClick={() => decide(false)}>Recusar</button>
        <button className="ghost-btn small send" disabled={busy} onClick={() => decide(true)}>Aplicar</button>
      </div>
    </div>
  )
}
