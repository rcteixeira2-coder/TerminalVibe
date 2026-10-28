import { useEffect, useState } from 'react'
import type { PreviewInfo } from '@shared/types'
import { actions, useStore } from '../state/store'
import { insertPath, openBrowser, openInCursor } from '../controller'
import { useModal } from './useModal'

export function PreviewModal() {
  const path = useStore((s) => s.previewPath)
  const projectId = useStore((s) => s.activeProjectId)
  const [info, setInfo] = useState<PreviewInfo | { error: string } | null>(null)
  const close = () => actions.set({ overlay: null, previewPath: null })

  useEffect(() => {
    if (!path || !projectId) return
    setInfo(null)
    void window.cockpit.invoke('files:preview', projectId, path).then(setInfo)
  }, [path, projectId])

  const dialog = useModal<HTMLDivElement>(close)

  if (!path || !projectId) return null
  const name = path.split('/').pop()
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="preview" ref={dialog} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3 title={path}>{name}</h3>
          <span className="spacer" />
          <button className="ghost-btn small" onClick={() => void window.cockpit.invoke('files:quickLook', projectId, path)}>Quick Look</button>
          <button className="ghost-btn small" onClick={() => { close(); void insertPath(path) }}>Inserir no terminal</button>
          <button className="ghost-btn small" onClick={() => void openInCursor(path)}>Abrir no Cursor</button>
          <button className="icon-btn" onClick={close}>×</button>
        </div>
        <div className="preview-body">
          {!info && <div className="muted">Carregando…</div>}
          {info && 'error' in info && <div className="error">{info.error}</div>}
          {info && !('error' in info) && <Body info={info} projectId={projectId} onClose={close} />}
        </div>
      </div>
    </div>
  )
}

function Body({ info, projectId, onClose }: { info: PreviewInfo; projectId: string; onClose: () => void }) {
  switch (info.kind) {
    case 'image':
      return <img className="pv-media" src={info.url} alt="" />
    case 'video':
      return <video className="pv-media" src={info.url} controls autoPlay={false} />
    case 'audio':
      return <audio src={info.url} controls />
    case 'html':
      return (
        <div className="pv-other">
          <p>Página HTML.</p>
          <button className="ghost-btn" onClick={() => { onClose(); void openBrowser(projectId, info.path) }}>Ver no browser lateral (recarrega ao salvar)</button>
        </div>
      )
    case 'text':
      return <pre className="pv-text">{info.text}</pre>
    default:
      return (
        <div className="pv-other">
          <p>{info.tooLarge ? 'Arquivo grande demais para a prévia (mais de 1 MB).' : 'Sem prévia no app para este tipo.'}</p>
          <button className="ghost-btn" onClick={() => void window.cockpit.invoke('files:quickLook', projectId, info.path)}>Abrir no Quick Look</button>
        </div>
      )
  }
}
