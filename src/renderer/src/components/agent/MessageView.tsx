import { useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { AgentMessage, AgentToolCall } from '@shared/types'
import { actions, toast } from '../../state/store'
import { openPreview } from '../../controller'
import { pasteText, focusTerminal } from '../../terminal/registry'

marked.setOptions({ gfm: true, breaks: false })

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'] })
}

const PATHISH = /^[\w@./-]+\.[A-Za-z0-9]{1,10}(:\d+){0,2}$/

// Cliques no Markdown: links abrem fora (validados no main); `caminho:linha` abre a prévia.
export async function onMarkdownClick(e: React.MouseEvent, projectId: string): Promise<void> {
  const el = e.target as HTMLElement
  const a = el.closest('a')
  if (a) {
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:/i.test(href)) void window.cockpit.invoke('links:open', href)
    else if (href) await openPath(projectId, href)
    return
  }
  if (el.tagName === 'CODE' && !el.closest('pre') && PATHISH.test(el.textContent ?? '')) await openPath(projectId, el.textContent!)
}

async function openPath(projectId: string, text: string): Promise<void> {
  const r = await window.cockpit.invoke('files:resolveProjectPath', projectId, text)
  if (r) openPreview(r.path)
  else toast(`Arquivo não encontrado no projeto: ${text}`)
}

export function ToolChips({ tools }: { tools: AgentToolCall[] }) {
  if (!tools.length) return null
  return (
    <div className="tool-chips">
      {tools.map((t) => (
        <span key={t.id} className={`tool-chip ${t.ok === false ? 'fail' : t.ok ? 'ok' : 'run'}`} title={t.name}>
          {t.name === 'read_file' ? '📄' : t.name === 'search' ? '🔎' : t.name === 'list_dir' ? '📁' : t.name === 'terminal_tail' ? '›_' : '⚙︎'} {t.summary}
          {t.ok === undefined && <span className="spin" />}
        </span>
      ))}
    </div>
  )
}

export function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="thinking">
      <button className="link-btn" onClick={() => setOpen(!open)}>{live ? 'Pensando…' : 'Raciocínio'} {open ? '▾' : '▸'}</button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  )
}

export function MessageView({ m, projectId }: { m: AgentMessage; projectId: string }) {
  const html = useMemo(() => (m.role === 'assistant' ? renderMarkdown(m.text) : ''), [m.role, m.text])
  if (m.role === 'user') {
    return (
      <div className="msg user">
        {m.attachments && m.attachments.length > 0 && (
          <div className="attach-row">{m.attachments.map((a, i) => <span key={i} className="attach-chip">{a.kind === 'file' ? '📄' : '›_'} {a.label}</span>)}</div>
        )}
        <div className="msg-text">{m.text}</div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      <Thinking text={m.thinking ?? ''} />
      <ToolChips tools={m.tools ?? []} />
      {m.text && <div className="md" onClick={(e) => void onMarkdownClick(e, projectId)} dangerouslySetInnerHTML={{ __html: html }} />}
      {m.notice && <div className="msg-notice">{m.notice}</div>}
      {m.error && <div className="msg-error">{m.error}</div>}
      <div className="msg-meta">
        <span className="muted small">{m.model}{m.usage ? ` · ${fmtTokens(m.usage.input)} entrada${m.usage.cacheRead ? ` (${fmtTokens(m.usage.cacheRead)} em cache)` : ''} · ${fmtTokens(m.usage.output)} saída` : ''}</span>
        <span className="spacer" />
        {m.text && <MessageActions text={m.text} />}
      </div>
    </div>
  )
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function MessageActions({ text }: { text: string }) {
  const target = () => {
    const { focusedSessionId, sessions, activeProjectId } = actions.get()
    const focused = focusedSessionId ? sessions[focusedSessionId] : undefined
    if (focused && focused.lifecycle === 'running') return focused
    return Object.values(sessions).find((s) => s.projectId === activeProjectId && s.lifecycle === 'running' && (s.foreground ?? s.agent) !== 'shell')
  }
  const sendTo = () => {
    const s = target()
    if (!s) {
      toast('Abra um Claude ou Codex neste projeto para enviar.')
      return
    }
    // Cola sem Enter: você revisa e envia.
    if (pasteText(s.id, text)) {
      focusTerminal(s.id)
      toast(`Colado em ${s.title} (sem enviar).`)
    }
  }
  return (
    <span className="msg-actions">
      <button className="link-btn" onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copiado.'))}>Copiar</button>
      <button className="link-btn" onClick={sendTo} title="Cola a resposta no Claude/Codex focado, sem enviar">Enviar para a sessão</button>
    </span>
  )
}
