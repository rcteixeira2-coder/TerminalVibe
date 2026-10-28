import { timingSafeEqual } from 'node:crypto'
import { stripAnsi } from '../pty/sniffer'

// Canal de controle do Hermes (control.sock): uma linha JSON por mensagem, versão 1.
// Hermes → Cockpit: { id, cmd, ... }; Cockpit → Hermes: { id, ok, error? } ou eventos { event, ... }.
export const CONTROL_VERSION = 1
export const MAX_LINE = 64 * 1024
export const MAX_PROMPT = 8000
// Acompanhamento colado num Claude já rodando (mesmo limite do terminal antigo do Hermes).
export const MAX_FOLLOW_UP = 1000
export const UNTRUSTED = 'untrusted'

export type ControlCommand =
  | { id: number; cmd: 'hello'; token: string; version: number }
  | { id: number; cmd: 'open'; projectPath: string }
  | { id: number; cmd: 'request'; projectPath: string; prompt: string; remoteName: string }
  | { id: number; cmd: 'finish'; projectPath: string }
  | { id: number; cmd: 'interruptHermes' }
  // Robô das sessões (no Hermes): ver as sessões vivas, ler a saída, responder numa delas e trazê-la à frente.
  | { id: number; cmd: 'sessions' }
  | { id: number; cmd: 'tail'; sessionId: string; lines: number }
  | { id: number; cmd: 'send'; sessionId: string; text: string; enter: boolean }
  | { id: number; cmd: 'focus'; sessionId: string }

export type ControlReply = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string }

export const MAX_TAIL = 200

// Sessão como o Hermes a vê: só o necessário para avisar e responder.
export interface ControlSession {
  id: string
  projectPath: string
  projectName: string
  agent: string
  title: string
  activity: string
  detail?: string
  needsMe: boolean
  origin?: 'hermes'
}

// Só os campos conhecidos, com tipo e tamanho conferidos; o resto da linha é ignorado.
export function parseCommand(line: string): ControlCommand | null {
  if (line.length > MAX_LINE) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = o.id
  if (typeof id !== 'number' || !Number.isInteger(id)) return null
  const str = (k: string, max: number): string | null => (typeof o[k] === 'string' && (o[k] as string).length <= max ? (o[k] as string) : null)
  switch (o.cmd) {
    case 'hello': {
      const token = str('token', 200)
      return token !== null && typeof o.version === 'number' ? { id, cmd: 'hello', token, version: o.version } : null
    }
    case 'open':
    case 'finish': {
      const projectPath = str('projectPath', 4096)
      return projectPath ? { id, cmd: o.cmd, projectPath } : null
    }
    case 'request': {
      const projectPath = str('projectPath', 4096)
      const prompt = str('prompt', MAX_PROMPT)
      const remoteName = str('remoteName', 200)
      return projectPath && prompt?.trim() && remoteName !== null ? { id, cmd: 'request', projectPath, prompt, remoteName } : null
    }
    case 'interruptHermes':
      return { id, cmd: 'interruptHermes' }
    case 'sessions':
      return { id, cmd: 'sessions' }
    case 'tail': {
      const sessionId = str('sessionId', 64)
      const lines = typeof o.lines === 'number' && Number.isInteger(o.lines) ? Math.min(Math.max(o.lines, 1), MAX_TAIL) : 60
      return sessionId ? { id, cmd: 'tail', sessionId, lines } : null
    }
    case 'send': {
      const sessionId = str('sessionId', 64)
      const text = str('text', MAX_FOLLOW_UP)
      return sessionId && text?.trim() ? { id, cmd: 'send', sessionId, text, enter: o.enter !== false } : null
    }
    case 'focus': {
      const sessionId = str('sessionId', 64)
      return sessionId ? { id, cmd: 'focus', sessionId } : null
    }
  }
  return null
}

// Segredos na saída do terminal nunca saem do Cockpit (mesma lista do SecretMask do Hermes).
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g, /xai-[A-Za-z0-9_-]{12,}/g, /dz_(live|test)_[A-Za-z0-9_-]{6,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g, /xox[abposr]-[A-Za-z0-9-]{10,}/g, /AKIA[0-9A-Z]{16}/g,
  /bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(password|senha|token|secret|api[_-]?key)\s*[:=]\s*\S{6,}/gi,
  /\b[0-9a-fA-F]{32,}\b/g, /[A-Za-z0-9+/]{40,}={0,2}/g,
]

export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[oculto]'), text)
}

// Avisos "precisa de você" para o Hermes: só depois de `delayMs` no mesmo estado (o Claude passa
// rápido por your_turn entre ferramentas) e uma vez por entrada; a saída do estado avisa também.
export class AttentionTracker {
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  private announced = new Set<string>()

  constructor(
    private emit: (event: Record<string, unknown>) => void,
    private describe: (id: string) => Record<string, unknown> | null,
    private delayMs = 4000,
  ) {}

  update(id: string, wants: boolean): void {
    if (wants) {
      if (this.announced.has(id) || this.pending.has(id)) return
      this.pending.set(id, setTimeout(() => {
        this.pending.delete(id)
        const info = this.describe(id)
        if (!info) return
        this.announced.add(id)
        this.emit({ event: 'attention', ...info })
      }, this.delayMs))
      return
    }
    this.clear(id)
  }

  clear(id: string): void {
    const t = this.pending.get(id)
    if (t) clearTimeout(t)
    this.pending.delete(id)
    if (this.announced.delete(id)) this.emit({ event: 'attentionCleared', sessionId: id })
  }

  // Quem precisa de você agora (para um Hermes que acabou de conectar).
  current(): string[] {
    return [...this.announced]
  }
}

export function tokenMatches(given: string, expected: string): boolean {
  const x = Buffer.from(given)
  const y = Buffer.from(expected)
  return x.length === y.length && timingSafeEqual(x, y)
}

// Nome da sessão no app do Claude: texto curto, sem caracteres de controle e sem cara de opção.
export function remoteControlName(name: string): string {
  const clean = name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^-+/, '').slice(0, 60).trim()
  return `${clean || 'Projeto'} · Hermes`
}

// Acompanhamento num Claude já rodando: colagem entre colchetes (uma mensagem, mesmo com quebras de linha).
// Caracteres de controle saem, para o texto nunca encerrar a colagem nem mandar teclas por conta própria.
// O Enter vai separado, depois (digitar rápido + Enter vira colagem no Claude/Codex).
export function pasteText(text: string): string {
  const clean = [...text.slice(0, MAX_FOLLOW_UP)].filter((c) => c === '\n' || !/[\x00-\x1f\x7f-\x9f]/.test(c)).join('')
  return `\x1b[200~${clean}\x1b[201~`
}

// ---- Leitura do Remote Control na tela (porte de DevRemote em DevProtocol.swift do Hermes) ----

const SESSION_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]{8,80}/

export function sessionUrl(text: string): string | null {
  return SESSION_URL.exec(plain(text))?.[0] ?? null
}

// O Claude parou na pergunta de confiar na pasta: precisa ser aceita uma vez no Mac.
export function asksTrust(text: string): boolean {
  const flat = plain(text).replace(/ /g, '').toLowerCase()
  return flat.includes('quicksafetycheck') || flat.includes('itrustthisfolder') || flat.includes('workspacenottrusted')
}

function plain(text: string): string {
  return stripAnsi(text).replace(/[\r\n]/g, ' ')
}

// Procura o link (ou o aviso de confiança) na saída de uma sessão por até 3 min; avisa uma vez.
export class RemoteScan {
  private tail = ''
  private readonly until: number

  constructor(now = Date.now(), windowMs = 3 * 60_000) {
    this.until = now + windowMs
  }

  expired(now = Date.now()): boolean {
    return now > this.until
  }

  // Devolve o link, UNTRUSTED ou null (ainda nada).
  feed(data: string): string | null {
    this.tail = (this.tail + data).slice(-16_000)
    return sessionUrl(this.tail) ?? (asksTrust(this.tail) ? UNTRUSTED : null)
  }
}
