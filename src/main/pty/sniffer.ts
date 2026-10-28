// Lê o fluxo bruto do pty no main (independe do renderer estar montado):
// - responde às consultas que o xterm.js não responde (OSC 7501 `?`, XTVERSION);
// - extrai OSC 7501 (status do Claude), OSC 9/777 (avisos), OSC 0/2 (título) e BEL.
// Sequências podem chegar partidas entre blocos; o estado é mantido entre chamadas.

export type SnifferEvent =
  | { type: 'program'; data: string }
  | { type: 'notify'; code: 9 | 777; data: string }
  | { type: 'title'; title: string }
  | { type: 'bell' }

export interface SnifferOptions {
  answerProgramStatus: boolean
  xtversion: string
}

const MAX_OSC = 64 * 1024
const ESC = 0x1b
const BEL = 0x07

type State = 'ground' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'dcs' | 'dcsEsc'

export class StreamSniffer {
  private state: State = 'ground'
  private buf = ''
  private csiParams = ''
  private oscOverflow = false

  constructor(private opts: SnifferOptions) {}

  setAnswerProgramStatus(v: boolean): void {
    this.opts.answerProgramStatus = v
  }

  // Retorna eventos e as respostas a escrever de volta no pty.
  feed(chunk: string): { events: SnifferEvent[]; replies: string[] } {
    const events: SnifferEvent[] = []
    const replies: string[] = []
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i)
      switch (this.state) {
        case 'ground':
          if (c === ESC) this.state = 'esc'
          else if (c === BEL) events.push({ type: 'bell' })
          else if (c === 0x9b) this.startCsi()
          break
        case 'esc':
          if (c === 0x5d /* ] */) {
            this.state = 'osc'
            this.buf = ''
            this.oscOverflow = false
          } else if (c === 0x5b /* [ */) this.startCsi()
          else if (c === 0x50 /* P */) this.state = 'dcs'
          else this.state = c === ESC ? 'esc' : 'ground'
          break
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) {
            this.finishCsi(String.fromCharCode(c), replies)
            this.state = 'ground'
          } else if (this.csiParams.length < 64) this.csiParams += chunk[i]
          else this.state = 'ground'
          break
        case 'osc':
          if (c === BEL) {
            this.finishOsc(events, replies)
            this.state = 'ground'
          } else if (c === ESC) this.state = 'oscEsc'
          else if (this.buf.length < MAX_OSC) this.buf += chunk[i]
          else {
            // Payload acima de 64 KB: descarta o conteúdo, mas continua consumindo até o terminador.
            this.buf = ''
            this.oscOverflow = true
          }
          break
        case 'oscEsc':
          if (c === 0x5c /* \ */) this.finishOsc(events, replies)
          this.state = c === ESC ? 'esc' : 'ground'
          break
        case 'dcs':
          if (c === ESC) this.state = 'dcsEsc'
          break
        case 'dcsEsc':
          this.state = c === 0x5c ? 'ground' : 'dcs'
          break
      }
    }
    return { events, replies }
  }

  private startCsi(): void {
    this.state = 'csi'
    this.csiParams = ''
  }

  private finishCsi(final: string, replies: string[]): void {
    // XTVERSION: CSI > q ou CSI > 0 q
    if (final === 'q' && (this.csiParams === '>' || this.csiParams === '>0')) {
      replies.push(`\x1bP>|${this.opts.xtversion}\x1b\\`)
    }
  }

  private finishOsc(events: SnifferEvent[], replies: string[]): void {
    const data = this.buf
    this.buf = ''
    if (this.oscOverflow) {
      this.oscOverflow = false
      return
    }
    const semi = data.indexOf(';')
    const code = semi >= 0 ? data.slice(0, semi) : data
    const body = semi >= 0 ? data.slice(semi + 1) : ''
    switch (code) {
      case '7501':
        if (body.startsWith('?')) {
          if (this.opts.answerProgramStatus) replies.push('\x1b]7501;?\x1b\\')
        } else events.push({ type: 'program', data: body })
        break
      case '9':
        // OSC 9;4 é progresso (ConEmu), não aviso.
        if (!body.startsWith('4;')) events.push({ type: 'notify', code: 9, data: body.slice(0, 500) })
        break
      case '777':
        if (body.startsWith('notify;')) events.push({ type: 'notify', code: 777, data: body.slice(7, 507) })
        break
      case '0':
      case '2':
        events.push({ type: 'title', title: body.slice(0, 200) })
        break
    }
  }
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

// URLs de dev server na saída (0.0.0.0 vira localhost).
const LOCAL_URL = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s'"`)\]]*)?/g

export function findLocalUrls(text: string): string[] {
  const out: string[] = []
  for (const m of stripAnsi(text).matchAll(LOCAL_URL)) {
    const port = Number(m[3])
    if (port < 1 || port > 65535) continue
    const host = m[2] === '0.0.0.0' || m[2] === '[::1]' ? 'localhost' : m[2]
    out.push(`${m[1]}://${host}:${port}${(m[4] ?? '/').replace(/[.,;:]+$/, '')}`)
  }
  return out
}
