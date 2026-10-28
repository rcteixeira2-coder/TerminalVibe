import { useState } from 'react'
import type { GitCommit, GitState, Project } from '@shared/types'
import { isDefaultBranch } from '@shared/types'
import { useStore } from '../state/store'
import { gitAction, refreshGit } from '../controller'
import { Dropdown } from './ProjectView'

function Octocat() {
  return (
    <svg className="octocat" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}

function since(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.round(s / 60)} min`
  if (s < 86400) return `há ${Math.round(s / 3600)} h`
  return `há ${Math.round(s / 86400)} d`
}

function ago(t?: number): string {
  return t ? `verificado ${since(t)}` : 'ainda não verificado'
}

// Resumo curto do estado, usado no ícone e no título.
export function gitSummary(st: GitState | undefined): { cls: string; marks: { text: string; cls: string }[]; title: string } {
  if (!st || st.kind === 'none') return { cls: 'off', marks: [], title: 'Não conectado ao GitHub' }
  const dirty = st.changed + st.untracked
  const marks: { text: string; cls: string }[] = []
  if (st.kind === 'local') {
    if (dirty) marks.push({ text: `●${dirty}`, cls: 'out' })
    return { cls: 'off', marks, title: 'Git sem GitHub (nenhum remote "origin")' }
  }
  if (st.behind) marks.push({ text: `↓${st.behind}`, cls: 'in' })
  if (!st.upstream && st.branch) marks.push({ text: '↑ novo', cls: 'out' })
  else if (st.ahead) marks.push({ text: `↑${st.ahead}`, cls: 'out' })
  if (dirty) marks.push({ text: `●${dirty}`, cls: 'out' })
  const parts: string[] = []
  if (st.behind) parts.push(`${st.behind} commit(s) novo(s) no GitHub`)
  if (st.ahead) parts.push(`${st.ahead} commit(s) para subir`)
  if (!st.upstream && st.branch) parts.push(`branch ${st.branch} ainda não publicada`)
  if (dirty) parts.push(`${dirty} arquivo(s) alterado(s) aqui`)
  if (st.error) return { cls: 'err', marks: marks.length ? marks : [{ text: '?', cls: 'err' }], title: `${st.error}${parts.length ? ` · ${parts.join(' · ')}` : ''}` }
  return {
    cls: marks.length ? (st.behind ? 'in' : 'out') : 'sync',
    marks,
    title: parts.length ? parts.join(' · ') : `Em dia com o GitHub (${ago(st.fetchedAt)})`,
  }
}

export function GitBadge({ project, place }: { project: Project; place: 'sidebar' | 'header' }) {
  const st = useStore((s) => s.git[project.id])
  const [anchor, setAnchor] = useState<{ top: number; left: number; align: 'left' | 'right'; up: boolean } | null>(null)
  const sum = gitSummary(st)
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (anchor) return setAnchor(null)
    const r = e.currentTarget.getBoundingClientRect()
    const right = r.left > window.innerWidth / 2
    // Perto do pé da tela, o painel abre para cima.
    const up = r.bottom > window.innerHeight * 0.55
    setAnchor({ top: up ? r.top : r.bottom, left: right ? r.right : r.left, align: right ? 'right' : 'left', up })
  }
  return (
    <>
      <button className={`git-badge gb-${place} ${sum.cls} ${st?.fetching ? 'fetching' : ''}`} onClick={toggle} title={sum.title}>
        <Octocat />
        {sum.marks.map((m) => (
          <span key={m.text} className={`gm ${m.cls}`}>{m.text}</span>
        ))}
      </button>
      {anchor && (
        // Posição fixa: o menu escapa da rolagem da barra lateral e fica por cima dos terminais.
        <div className={`git-anchor ${anchor.up ? 'up' : ''}`} style={{ top: anchor.top, left: anchor.left }}>
          <Dropdown onClose={() => setAnchor(null)} wide align={anchor.align}>
            <GitPanel project={project} st={st} close={() => setAnchor(null)} />
          </Dropdown>
        </div>
      )}
    </>
  )
}

function GitPanel({ project, st, close }: { project: Project; st: GitState | undefined; close: () => void }) {
  const run = (a: 'pull' | 'push' | 'claude') => {
    close()
    void gitAction(project.id, a)
  }
  if (!st || st.kind === 'none' || st.kind === 'local') {
    const dirty = st ? st.changed + st.untracked : 0
    return (
      <div className="git-panel">
        <div className="gp-head"><Octocat /> <b>{project.name}</b></div>
        <p className="gp-muted">
          {st?.kind === 'local' ? `Tem git${st.branch ? ` (branch ${st.branch})` : ''}, mas não está ligado ao GitHub.` : 'Esta pasta não está conectada ao GitHub.'}
          {dirty > 0 && ` ${dirty} arquivo(s) alterado(s).`}
        </p>
        <button className="ghost-btn small gp-primary" onClick={() => run('claude')}>Conectar ao GitHub</button>
        <p className="gp-hint">Abre um Claude com /UploadNoGithub, que guia a conexão.</p>
      </div>
    )
  }
  const dirty = st.changed + st.untracked
  const unpublished = !st.upstream && !!st.branch
  return (
    <div className="git-panel">
      <div className="gp-head">
        <Octocat />
        {st.webUrl ? (
          <button className="link-btn" onClick={() => void window.cockpit.invoke('links:open', st.webUrl!)} title="Abrir no GitHub">{st.repo}</button>
        ) : (
          <b>{project.name}</b>
        )}
        <span className="gp-branch">{st.branch ?? 'HEAD solto'}</span>
      </div>
      <div className="gp-row">
        <span className="gp-muted">{st.fetching ? 'verificando…' : ago(st.fetchedAt)}</span>
        <button className="ghost-btn small" disabled={st.fetching} onClick={() => void refreshGit(project.id)}>Verificar agora</button>
      </div>
      {st.error && <div className="gp-error">{st.error}</div>}
      {!st.behind && !st.ahead && !dirty && !unpublished && !st.error && <div className="gp-ok">✓ Em dia com o GitHub</div>}

      {st.behind > 0 && (
        <section>
          <div className="dd-title">No GitHub, faltando aqui ({st.behind})</div>
          {st.incoming.map((c) => <CommitLine key={c.hash} c={c} />)}
          <button className="ghost-btn small gp-primary" onClick={() => run('pull')}>↓ Baixar</button>
          {dirty > 0 && <p className="gp-hint">Há arquivos alterados aqui: se o pull recusar, use "Pedir ao Claude".</p>}
        </section>
      )}

      {(st.ahead > 0 || unpublished || dirty > 0) && (
        <section>
          <div className="dd-title">Aqui, faltando no GitHub</div>
          {unpublished && <div className="gp-line">Branch <code>{st.branch}</code> ainda não publicada</div>}
          {st.outgoing.map((c) => <CommitLine key={c.hash} c={c} />)}
          {dirty > 0 && (
            <div className="gp-line">
              {dirty} arquivo(s) alterado(s) ou novo(s)
              <div className="gp-files">{st.files.join(' · ')}{dirty > st.files.length ? ' …' : ''}</div>
            </div>
          )}
          <div className="gp-actions">
            {(st.ahead > 0 || unpublished) && dirty === 0 && st.behind === 0 && !isDefaultBranch(st.branch) && (
              <button className="ghost-btn small gp-primary" onClick={() => run('push')}>↑ Subir</button>
            )}
            <button className="ghost-btn small" onClick={() => run('claude')}>Pedir ao Claude para subir numa branch</button>
          </div>
        </section>
      )}
    </div>
  )
}

function CommitLine({ c }: { c: GitCommit }) {
  return (
    <div className="gp-commit" title={`${c.hash} · ${c.author}`}>
      <span className="gp-subject">{c.subject}</span>
      <span className="gp-muted">{c.author} · {since(c.at)}</span>
    </div>
  )
}
