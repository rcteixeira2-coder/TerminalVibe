import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import type { Activity, Prefs, Project, SessionInfo } from '@shared/types'
import { ACTIVITY_LABEL } from '@shared/status'

const DEDUPE_MS = 10_000
const HOOKS_DIR = join(homedir(), '.claude', 'hooks')
const MUTE_FLAG = join(HOOKS_DIR, 'claude-notifier-muted')

export function claudeNotifierStatus(): { installed: boolean; muted: boolean } {
  const installed = existsSync(join(HOOKS_DIR, 'claude-notifier-on-stop.js')) || existsSync(join(HOOKS_DIR, 'claude-notifier-config.json'))
  return { installed, muted: existsSync(MUTE_FLAG) }
}

// Silenciar o claude-notifier = criar o flag dele (reversível, global). Só por ação explícita do usuário.
export function setClaudeNotifierMuted(muted: boolean): { installed: boolean; muted: boolean } {
  if (claudeNotifierStatus().installed) {
    if (muted) writeFileSync(MUTE_FLAG, 'silenciado pelo Cockpit\n')
    else if (existsSync(MUTE_FLAG)) rmSync(MUTE_FLAG)
  }
  return claudeNotifierStatus()
}

const BODY: Partial<Record<Activity, string>> = {
  needs_approval: 'precisa da sua aprovação',
  your_turn: 'está esperando você',
  done: 'concluiu a tarefa',
  error: 'deu erro',
}

export class Notifier {
  private last = new Map<string, number>()
  private active: Notification[] = []

  constructor(private prefs: () => Prefs, private onClick: (sessionId: string) => void) {}

  activity(info: SessionInfo, project: Project | undefined, activity: Activity, visibleAndFocused: boolean): void {
    const p = this.prefs()
    if (!p.notifications || visibleAndFocused) return
    if (!BODY[activity]) return
    // Com o claude-notifier ativo e a opção ligada, o Cockpit fica em silêncio para não duplicar.
    if (p.silentWhenNotifier && info.agent === 'claude') {
      const n = claudeNotifierStatus()
      if (n.installed && !n.muted) return
    }
    const key = `${info.id}:${activity}`
    const now = Date.now()
    if ((this.last.get(key) ?? 0) > now - DEDUPE_MS) return
    this.last.set(key, now)
    const projectName = project?.name ?? 'Projeto'
    const title = `${info.title} · ${projectName}`
    const body = info.activityDetail ? `${ACTIVITY_LABEL[activity]}: ${info.activityDetail}` : `${info.title} ${BODY[activity]}`
    this.show(title, body, info.id)
  }

  program(info: SessionInfo, project: Project | undefined, text: string, visibleAndFocused: boolean): void {
    if (!this.prefs().notifications || visibleAndFocused || info.agent === 'claude') return
    const key = `${info.id}:program`
    const now = Date.now()
    if ((this.last.get(key) ?? 0) > now - DEDUPE_MS) return
    this.last.set(key, now)
    this.show(`${info.title} · ${project?.name ?? ''}`, text || 'Aviso do programa', info.id)
  }

  show(title: string, body: string, sessionId?: string): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body: body.slice(0, 300), silent: !this.prefs().sound })
    if (sessionId) n.on('click', () => this.onClick(sessionId))
    n.on('close', () => (this.active = this.active.filter((x) => x !== n)))
    // Referência viva: sem isso o GC pode descartar o handler de clique.
    this.active.push(n)
    if (this.active.length > 20) this.active.shift()
    n.show()
  }
}
