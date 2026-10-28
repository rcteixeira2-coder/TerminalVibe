import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import * as pty from 'node-pty'
import type { Activity, Agent, SessionInfo, SpawnRequest } from '@shared/types'
import { AGENT_LABEL } from '@shared/types'
import { activityFromHook, activityFromProgramStatus, parseProgramStatus, resolveIdle, type HookPayload } from '@shared/status'
import { buildEnv, canonicalDirectory } from '../security'
import { lastAssistantModel, lastAssistantText } from '../status/transcript'
import { launchSpec } from './launch'
import { descendants, killOrphans, psSnapshot, terminateTree, type ProcessIdentity } from './processTree'
import { findLocalUrls, StreamSniffer, stripAnsi } from './sniffer'

const RING_LIMIT = 2 * 1024 * 1024
const FLUSH_MS = 8
const FLUSH_BYTES = 64 * 1024
const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024
const TREE_MS = 400
// Heurística (camada D): saída recente = trabalhando; silêncio depois de trabalhar = sua vez (provável).
const WORKING_WINDOW = 1500
const IDLE_AFTER = 4000
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Rec {
  info: SessionInfo
  proc: pty.IPty | null
  sniffer: StreamSniffer
  ring: string[]
  ringBytes: number
  outBuf: string
  flushTimer: NodeJS.Timeout | null
  pending: number
  paused: boolean
  known: Map<number, ProcessIdentity>
  root: ProcessIdentity | null
  treeTimer: NodeJS.Timeout | null
  heuristicTimer: NodeJS.Timeout | null
  exactStatus: boolean // recebeu OSC 7501 ou hook: heurística desligada
  userStopped: boolean
  cwd: string
  urlsSeen: Set<string>
  urlScanTail: string
  // Resolvida em onExit; dispose espera por ela para o estado final nunca chegar depois de 'removed'.
  exited: Promise<void>
  resolveExited: () => void
  killing: Promise<void> | null
  disposed: boolean
}

export interface SessionDeps {
  projectPath(projectId: string): string | null
  version: string
  sock: string
  token: string
  pluginDir: string | null
  loginEnv: Record<string, string> | undefined
  oscStatus(): boolean
  // Sessões do Claude: MCP do navegador do Cockpit preso ao projeto (null = sem). dispose() quando a sessão sai.
  browserMcp?(sessionId: string, projectId: string): { config: string; dispose(): void } | null
  binaryOverride?: Partial<Record<Agent, string>>
  // O mod auto-modelo está ligado agora? Gravado na sessão do Claude ao abrir.
  autoModelo?(): boolean
}

export interface SessionEvents {
  update: [SessionInfo]
  removed: [string]
  data: [string, string]
  activity: [SessionInfo, Activity, Activity] // info, anterior, nova
  notify: [SessionInfo, string]
  localUrl: [SessionInfo, string]
  workingChanged: [boolean]
}

export class SessionManager extends EventEmitter<SessionEvents> {
  private recs = new Map<string, Rec>()
  private claudeToPane = new Map<string, string>()
  private anyWorking = false
  // Sem renderer pronto (carregando/caiu), bytes enviados nunca serão confirmados: não contam para o fluxo.
  private flowEnabled = false

  constructor(private deps: SessionDeps) {
    super()
  }

  list(): SessionInfo[] {
    return [...this.recs.values()].map((r) => ({ ...r.info }))
  }

  get(id: string): SessionInfo | undefined {
    const r = this.recs.get(id)
    return r ? { ...r.info } : undefined
  }

  projectOf(id: string): string | undefined {
    return this.recs.get(id)?.info.projectId
  }

  cwdOf(id: string): string | undefined {
    return this.recs.get(id)?.cwd
  }

  isRunning(id: string): boolean {
    return this.recs.get(id)?.info.lifecycle === 'running'
  }

  spawn(req: SpawnRequest, previous?: { claudeSessionId?: string }): SessionInfo | { error: string } {
    const projectPath = this.deps.projectPath(req.projectId)
    const cwd = projectPath ? canonicalDirectory(projectPath) : null
    if (!cwd) return { error: 'A pasta do projeto foi movida ou apagada.' }
    const id = randomUUID()
    const newClaudeSessionId = req.agent === 'claude' && !req.resume ? randomUUID() : undefined
    const env = buildEnv(process.env, {
      paneId: id, sock: this.deps.sock, token: this.deps.token, version: this.deps.version, login: this.deps.loginEnv,
    })
    const mcp = req.agent === 'claude' ? (this.deps.browserMcp?.(id, req.projectId) ?? null) : null
    const spec = launchSpec(req.agent, env.PATH, {
      resume: req.resume,
      claudeSessionId: previous?.claudeSessionId,
      newClaudeSessionId,
      pluginDir: this.deps.pluginDir ?? undefined,
      initialPrompt: req.initialPrompt,
      mcpConfig: mcp?.config,
      remoteControl: req.remoteControl,
    }, this.deps.binaryOverride?.[req.agent])
    if ('error' in spec) {
      mcp?.dispose()
      return spec
    }
    const cols = clamp(req.cols, 20, 500)
    const rows = clamp(req.rows, 5, 300)
    const info: SessionInfo = {
      id,
      projectId: req.projectId,
      agent: req.agent,
      title: req.title ?? this.nextTitle(req.projectId, req.agent),
      lifecycle: 'running',
      activity: 'unknown',
      claudeSessionId: newClaudeSessionId ?? previous?.claudeSessionId,
      startedAt: Date.now(),
      lastOutputAt: 0,
      cols,
      rows,
      origin: req.origin,
      ...(req.agent === 'claude' && this.deps.autoModelo && { autoModelo: this.deps.autoModelo() }),
    }
    let proc: pty.IPty
    try {
      proc = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cwd,
        env,
        cols,
        rows,
        encoding: 'utf8',
      })
    } catch (e) {
      mcp?.dispose()
      return { error: `Não foi possível iniciar: ${(e as Error).message}` }
    }
    let resolveExited = () => {}
    const exited = new Promise<void>((r) => (resolveExited = r))
    const rec: Rec = {
      info,
      proc,
      sniffer: new StreamSniffer({ answerProgramStatus: this.deps.oscStatus(), xtversion: 'xterm.js(6.0.0)' }),
      ring: [],
      ringBytes: 0,
      outBuf: '',
      flushTimer: null,
      pending: 0,
      paused: false,
      known: new Map(),
      root: null,
      treeTimer: null,
      heuristicTimer: null,
      exactStatus: false,
      userStopped: false,
      cwd,
      urlsSeen: new Set(),
      urlScanTail: '',
      exited,
      resolveExited,
      killing: null,
      disposed: false,
    }
    this.recs.set(id, rec)
    if (info.claudeSessionId) this.claudeToPane.set(info.claudeSessionId, id)
    proc.onData((d) => this.onData(rec, d))
    proc.onExit(({ exitCode, signal }) => {
      mcp?.dispose()
      this.onExit(rec, exitCode, signal)
    })
    void this.captureRoot(rec)
    rec.treeTimer = setInterval(() => void this.scanTree(rec), TREE_MS)
    if (req.initialInput) setTimeout(() => rec.proc?.write(req.initialInput!), 350)
    this.emit('update', { ...info })
    return { ...info }
  }

  write(id: string, data: string): void {
    const r = this.recs.get(id)
    if (!r?.proc || r.info.lifecycle !== 'running') return
    r.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const r = this.recs.get(id)
    if (!r?.proc || r.info.lifecycle !== 'running') return
    const c = clamp(cols, 20, 500)
    const h = clamp(rows, 5, 300)
    try {
      r.proc.resize(c, h)
      r.info.cols = c
      r.info.rows = h
    } catch {
      // pty já fechado
    }
  }

  ack(id: string, bytes: number): void {
    const r = this.recs.get(id)
    if (!r) return
    r.pending = Math.max(0, r.pending - bytes)
    if (r.paused && r.pending < LOW_WATER) {
      r.paused = false
      r.proc?.resume()
    }
  }

  // Renderer novo registrou os ouvintes: zera o que nunca será confirmado e volta a contar.
  // Antes disso (carregando/caiu) o fluxo fica desligado, para nenhuma sessão congelar.
  setFlowEnabled(v: boolean): void {
    this.flowEnabled = v
    this.resetFlow()
  }

  resetFlow(): void {
    for (const r of this.recs.values()) {
      r.pending = 0
      if (r.paused) {
        r.paused = false
        r.proc?.resume()
      }
    }
  }

  interrupt(id: string): void {
    this.write(id, '\x03')
  }

  kill(id: string): Promise<void> {
    const r = this.recs.get(id)
    if (!r) return Promise.resolve()
    // Um encerramento já em curso: quem chama espera o mesmo.
    if (r.killing) return r.killing
    if (r.info.lifecycle !== 'running') return Promise.resolve()
    r.userStopped = true
    this.patch(r, { lifecycle: 'stopping', message: 'Encerrando sessão…' })
    r.killing = (async () => {
      await terminateTree(r.root, [...r.known.values()])
      try {
        r.proc?.kill()
      } catch {
        // já saiu
      }
    })()
    return r.killing
  }

  async dispose(id: string): Promise<void> {
    const r = this.recs.get(id)
    if (!r || r.disposed) return
    if (r.info.lifecycle === 'running' || r.info.lifecycle === 'stopping') {
      await this.kill(id)
      // O 'exit' do node-pty chega depois do SIGKILL; sem esperar, o estado final apareceria como painel fantasma.
      await Promise.race([r.exited, new Promise((res) => setTimeout(res, 2000))])
    }
    r.disposed = true
    this.cleanupTimers(r)
    this.recs.delete(id)
    if (r.info.claudeSessionId) this.claudeToPane.delete(r.info.claudeSessionId)
    this.emit('removed', id)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.recs.values()].map((r) => (r.info.lifecycle === 'running' ? this.kill(r.info.id) : (r.killing ?? Promise.resolve()))))
  }

  // O anel já contém todo byte recebido. Antes do snapshot, despacha o que está na fila de 8 ms:
  // como o IPC é ordenado, esses bytes chegam ao renderer ANTES da resposta e são descartados lá,
  // em vez de chegarem depois e duplicarem o texto.
  buffer(id: string): string {
    const r = this.recs.get(id)
    if (!r) return ''
    this.flush(r)
    return r.ring.join('')
  }

  // Últimas linhas visíveis em texto puro (cards da grade).
  tail(id: string, lines = 12): string {
    const text = stripAnsi(this.buffer(id).slice(-16000)).replace(/\r/g, '')
    return text.split('\n').slice(-lines).join('\n')
  }

  setOscStatus(v: boolean): void {
    for (const r of this.recs.values()) r.sniffer.setAnswerProgramStatus(v)
  }

  markModTyped(id: string): void {
    const r = this.recs.get(id)
    if (r) this.patch(r, { modTyped: true })
  }

  // ---- camada B: hooks ----

  applyHook(paneId: string, payload: HookPayload): void {
    const r = this.recs.get(paneId)
    if (!r) return
    // Só ids no formato UUID: o valor pode virar argumento de `claude --resume`.
    const sid = typeof payload.session_id === 'string' && UUID_RE.test(payload.session_id) ? payload.session_id : undefined
    if (sid && sid !== r.info.claudeSessionId) {
      // /clear, /resume e fork trocam o id da conversa no mesmo painel.
      if (r.info.claudeSessionId) this.claudeToPane.delete(r.info.claudeSessionId)
      this.claudeToPane.set(sid, paneId)
      this.patch(r, { claudeSessionId: sid })
    }
    // Sem a última resposta no payload, busca no transcript para saber se o Claude terminou perguntando.
    if (payload.hook_event_name === 'Stop' && typeof payload.last_assistant_message !== 'string')
      payload = { ...payload, last_assistant_message: lastAssistantText(payload.transcript_path) }
    if (payload.hook_event_name === 'Stop') {
      const model = lastAssistantModel(payload.transcript_path)
      if (model && model !== r.info.model) this.patch(r, { model })
    }
    const h = activityFromHook(payload)
    if (h.ended) return
    if (h.activity) {
      r.exactStatus = true
      if (h.activity === 'idle') this.applyIdle(r, 'hook')
      else this.setActivity(r, h.activity, 'hook', h.detail)
    }
  }

  // ---- internos ----

  private onData(r: Rec, d: string): void {
    if (r.disposed) return
    r.info.lastOutputAt = Date.now()
    const { events, replies } = r.sniffer.feed(d)
    for (const reply of replies) r.proc?.write(reply)
    for (const ev of events) this.onSnifferEvent(r, ev)
    this.appendRing(r, d)
    this.scanUrls(r, d)
    r.outBuf += d
    if (this.flowEnabled) r.pending += d.length
    if (!r.paused && r.pending > HIGH_WATER) {
      r.paused = true
      r.proc?.pause()
    }
    if (r.outBuf.length >= FLUSH_BYTES) this.flush(r)
    else if (!r.flushTimer) r.flushTimer = setTimeout(() => this.flush(r), FLUSH_MS)
    if (!r.exactStatus) this.heuristicOutput(r)
  }

  private flush(r: Rec): void {
    if (r.flushTimer) clearTimeout(r.flushTimer)
    r.flushTimer = null
    if (!r.outBuf || r.disposed) return
    const data = r.outBuf
    r.outBuf = ''
    this.emit('data', r.info.id, data)
  }

  private appendRing(r: Rec, d: string): void {
    r.ring.push(d)
    r.ringBytes += d.length
    while (r.ringBytes > RING_LIMIT && r.ring.length > 1) r.ringBytes -= r.ring.shift()!.length
  }

  private scanUrls(r: Rec, d: string): void {
    const text = r.urlScanTail + d
    r.urlScanTail = text.slice(-200)
    for (const url of findLocalUrls(text)) {
      const u = new URL(url)
      if (r.urlsSeen.has(u.port)) continue
      r.urlsSeen.add(u.port)
      // Só a origem: um texto qualquer na saída não escolhe o caminho que o browser carrega.
      this.emit('localUrl', { ...r.info }, `${u.protocol}//${u.host}/`)
    }
  }

  reportPort(id: string, port: number): void {
    const r = this.recs.get(id)
    if (!r || r.urlsSeen.has(String(port))) return
    r.urlsSeen.add(String(port))
    this.emit('localUrl', { ...r.info }, `http://localhost:${port}/`)
  }

  private onSnifferEvent(r: Rec, ev: ReturnType<StreamSniffer['feed']>['events'][number]): void {
    switch (ev.type) {
      case 'program': {
        const st = parseProgramStatus(ev.data)
        if (!st) return
        const a = activityFromProgramStatus(st)
        if (a === null) return
        r.exactStatus = true
        if (st.title && r.info.taskTitle !== st.title) this.patch(r, { taskTitle: st.title })
        if (a === 'clear') {
          this.setActivity(r, 'unknown', 'osc')
          return
        }
        if (a === 'idle') {
          this.applyIdle(r, 'osc', st.msg)
          return
        }
        const detail = st.msg || (st.state === 'blocked' && st.kind === 'permission' ? 'Pedido de permissão' : undefined)
        this.setActivity(r, a, 'osc', detail)
        break
      }
      case 'notify':
        // Codex (OSC 9) e outros: aviso explícito do programa = sua vez.
        if (!r.exactStatus) this.setActivity(r, 'your_turn', 'heuristic', ev.data || undefined)
        this.emit('notify', { ...r.info }, ev.data)
        break
      case 'title':
        if (r.info.agent !== 'shell' || r.info.foreground) {
          const t = ev.title.replace(/^[^\p{L}\p{N}]+/u, '').trim()
          if (t && t !== 'Claude Code' && t !== r.info.taskTitle) this.patch(r, { taskTitle: t.slice(0, 120) })
        }
        break
      case 'bell':
        if (!r.exactStatus && r.info.agent !== 'shell') this.setActivity(r, 'your_turn', 'heuristic')
        break
    }
  }

  private heuristicOutput(r: Rec): void {
    if (r.info.agent === 'shell' && !r.info.foreground) return
    const now = Date.now()
    // Ignora o redesenho inicial da TUI.
    if (now - r.info.startedAt < 2500) return
    if (r.info.activity !== 'working') this.setActivity(r, 'working', 'heuristic')
    if (r.heuristicTimer) clearTimeout(r.heuristicTimer)
    r.heuristicTimer = setTimeout(() => {
      if (r.exactStatus || r.info.lifecycle !== 'running') return
      if (Date.now() - r.info.lastOutputAt >= WORKING_WINDOW && r.info.activity === 'working') {
        this.setActivity(r, 'done', 'heuristic', 'Provavelmente terminou')
      }
    }, IDLE_AFTER)
  }

  // "Parado" só muda o selo se o Claude estava trabalhando (ou esperando aprovação); senão mantém o que havia.
  private applyIdle(r: Rec, source: SessionInfo['activitySource'], detail?: string): void {
    const next = resolveIdle(r.info.activity)
    if (next !== r.info.activity) this.setActivity(r, next, source, detail)
  }

  private setActivity(r: Rec, a: Activity, source: SessionInfo['activitySource'], detail?: string): void {
    const prev = r.info.activity
    if (prev === a && r.info.activityDetail === detail) return
    this.patch(r, { activity: a, activitySource: source, activityDetail: detail })
    if (prev !== a && !r.disposed) this.emit('activity', { ...r.info }, prev, a)
    this.updateWorking()
  }

  private updateWorking(): void {
    const any = [...this.recs.values()].some((r) => r.info.lifecycle === 'running' && r.info.activity === 'working')
    if (any !== this.anyWorking) {
      this.anyWorking = any
      this.emit('workingChanged', any)
    }
  }

  private async captureRoot(r: Rec): Promise<void> {
    const pid = r.proc?.pid
    if (!pid) return
    const rows = await psSnapshot()
    const row = rows.find((x) => x.pid === pid)
    if (row) r.root = { pid, start: row.start }
  }

  private async scanTree(r: Rec): Promise<void> {
    if (!r.root || r.info.lifecycle !== 'running') return
    const rows = await psSnapshot()
    if (r.disposed || r.info.lifecycle !== 'running') return
    const desc = descendants(rows, r.root.pid)
    for (const d of desc) r.known.set(d.pid, { pid: d.pid, start: d.start })
    // Esquece identidades que já não existem.
    const alive = new Set(rows.map((x) => `${x.pid}:${x.start}`))
    for (const [pid, k] of r.known) if (!alive.has(`${k.pid}:${k.start}`)) r.known.delete(pid)
    if (r.info.agent === 'shell') {
      let fg: Agent | undefined
      for (const d of desc) {
        const name = basename(d.command)
        if (name === 'claude') fg = 'claude'
        else if (name === 'codex' && !fg) fg = 'codex'
      }
      if (fg !== r.info.foreground) {
        this.patch(r, { foreground: fg })
        if (!fg) {
          // O agente saiu do shell: o último status exato dele não vale mais.
          r.exactStatus = false
          if (r.heuristicTimer) clearTimeout(r.heuristicTimer)
          this.setActivity(r, 'unknown', 'heuristic')
        }
      }
    }
  }

  private onExit(r: Rec, exitCode: number, signal?: number): void {
    r.resolveExited()
    this.flush(r)
    const known = [...r.known.values()]
    this.cleanupTimers(r)
    r.proc = null
    // Órfãos morrem com o líder.
    void killOrphans(known)
    const stopped = r.userStopped
    const failed = !stopped && exitCode !== 0 && !signal
    this.patch(r, {
      lifecycle: stopped ? 'exited' : failed ? 'failed' : 'exited',
      exitCode,
      message: stopped ? 'Sessão encerrada.' : failed ? `O processo terminou com código ${exitCode}.` : 'O processo terminou.',
    })
    const prev = r.info.activity
    const next: Activity = failed ? 'error' : 'unknown'
    if (prev !== next) {
      this.patch(r, { activity: next, activityDetail: undefined })
      this.emit('activity', { ...r.info }, prev, next)
    }
    this.updateWorking()
  }

  private cleanupTimers(r: Rec): void {
    if (r.treeTimer) clearInterval(r.treeTimer)
    if (r.heuristicTimer) clearTimeout(r.heuristicTimer)
    if (r.flushTimer) clearTimeout(r.flushTimer)
    r.treeTimer = r.heuristicTimer = r.flushTimer = null
  }

  private patch(r: Rec, p: Partial<SessionInfo>): void {
    Object.assign(r.info, p)
    // Depois de 'removed', nenhum evento pode ressuscitar o painel.
    if (r.disposed || this.recs.get(r.info.id) !== r) return
    this.emit('update', { ...r.info })
  }

  private nextTitle(projectId: string, agent: Agent): string {
    const base = AGENT_LABEL[agent]
    const used = new Set([...this.recs.values()].filter((r) => r.info.projectId === projectId).map((r) => r.info.title))
    if (!used.has(base)) return base
    for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(v) ? v : min)))
}
