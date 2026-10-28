import { useCallback, useEffect, useState } from 'react'
import type { Project, TreeEntry } from '@shared/types'
import { insertPath, openBrowser, openInCursor, openPreview } from '../controller'
import { toast } from '../state/store'

interface DirState {
  entries: TreeEntry[]
  truncated: number
  error?: string
}

const ICON: Record<string, string> = {
  ts: '🟦', tsx: '🟦', js: '🟨', jsx: '🟨', json: '🧾', md: '📝', html: '🌐', css: '🎨', py: '🐍', swift: '🕊',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼', mp4: '🎞', mov: '🎞', wav: '🎵', mp3: '🎵',
  xls: '📊', xlsx: '📊', csv: '📊', pdf: '📕', zip: '🗜', sh: '⚙️', yml: '⚙️', yaml: '⚙️', toml: '⚙️', lock: '🔒',
}

function iconFor(e: TreeEntry, open: boolean): string {
  if (e.kind === 'dir') return open ? '📂' : '📁'
  if (e.kind === 'symlink') return '🔗'
  if (e.kind === 'package') return '📦'
  return ICON[e.name.split('.').pop()?.toLowerCase() ?? ''] ?? '📄'
}

// Só leitura, um nível por vez (porte do FileTree.swift do Hermes).
export function FileTree({ project }: { project: Project }) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(
    async (dir: string) => {
      const r = await window.cockpit.invoke('files:list', project.id, dir)
      setDirs((d) => ({ ...d, [dir]: 'error' in r ? { entries: [], truncated: 0, error: r.error } : r }))
    },
    [project.id],
  )

  useEffect(() => {
    setDirs({})
    setOpen(new Set())
    void load(project.path)
  }, [project.path, load])

  const toggle = (e: TreeEntry) => {
    const next = new Set(open)
    if (next.has(e.path)) next.delete(e.path)
    else {
      next.add(e.path)
      if (!dirs[e.path]) void load(e.path)
    }
    setOpen(next)
  }

  const onMenu = async (ev: React.MouseEvent, e: TreeEntry) => {
    ev.preventDefault()
    setSelected(e.path)
    if (e.kind === 'dir') {
      const r = await window.cockpit.invoke('ui:contextMenu', 'file', { html: '0' })
      act(r, e)
      return
    }
    const r = await window.cockpit.invoke('ui:contextMenu', 'file', { html: /\.html?$/i.test(e.name) ? '1' : '0' })
    act(r, e)
  }

  const act = (r: string | null, e: TreeEntry) => {
    switch (r) {
      case 'preview':
        if (e.kind === 'file') openPreview(e.path)
        else void window.cockpit.invoke('files:quickLook', project.id, e.path)
        break
      case 'quicklook':
        void window.cockpit.invoke('files:quickLook', project.id, e.path)
        break
      case 'browser':
        void openBrowser(project.id, e.path)
        break
      case 'insert':
        void insertPath(e.path)
        break
      case 'copy':
        void window.cockpit.invoke('files:copyPath', project.id, e.path).then(() => toast('Caminho copiado.'))
        break
      case 'reveal':
        void window.cockpit.invoke('files:reveal', project.id, e.path)
        break
      case 'cursor':
        void openInCursor(e.path)
        break
    }
  }

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const st = dirs[dir]
    if (!st) return <div className="tree-row muted" style={{ paddingLeft: 12 + depth * 14 }}>…</div>
    if (st.error) return <div className="tree-row muted" style={{ paddingLeft: 12 + depth * 14 }}>{st.error}</div>
    return (
      <>
        {st.entries.map((e) => {
          const isOpen = open.has(e.path)
          return (
            <div key={e.path}>
              <div
                className={`tree-row ${e.hidden ? 'hidden-file' : ''} ${selected === e.path ? 'selected' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                tabIndex={0}
                draggable={e.kind !== 'dir'}
                onDragStart={(ev) => ev.dataTransfer.setData('application/x-cockpit-path', e.path)}
                onClick={() => {
                  setSelected(e.path)
                  if (e.kind === 'dir') toggle(e)
                }}
                onDoubleClick={() => {
                  if (e.kind === 'file') openPreview(e.path)
                  else if (e.kind === 'package') void window.cockpit.invoke('files:quickLook', project.id, e.path)
                }}
                onKeyDown={(ev) => {
                  if (ev.key === ' ') {
                    ev.preventDefault()
                    void window.cockpit.invoke('files:quickLook', project.id, e.path)
                  } else if (ev.key === 'Enter') {
                    if (e.kind === 'dir') toggle(e)
                    else openPreview(e.path)
                  }
                }}
                onContextMenu={(ev) => void onMenu(ev, e)}
                title={e.kind === 'symlink' ? 'Link simbólico (não é seguido)' : e.name}
              >
                <span className="tree-caret">{e.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>
                <span className="tree-icon">{iconFor(e, isOpen)}</span>
                <span className="tree-name">{e.name}</span>
              </div>
              {e.kind === 'dir' && isOpen && renderDir(e.path, depth + 1)}
            </div>
          )
        })}
        {st.truncated > 0 && <div className="tree-row muted" style={{ paddingLeft: 12 + depth * 14 }}>… mais {st.truncated} itens</div>}
      </>
    )
  }

  return (
    <div className="tree">
      <div className="tree-head">
        <span>Arquivos</span>
        <span className="spacer" />
        <button className="icon-btn small" title="Atualizar" onClick={() => { setDirs({}); void load(project.path); for (const d of open) void load(d) }}>↻</button>
        <button className="icon-btn small" title="Recolher tudo" onClick={() => setOpen(new Set())}>⇤</button>
      </div>
      <div className="tree-scroll">{renderDir(project.path, 0)}</div>
    </div>
  )
}
