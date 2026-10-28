import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Manda ao Cockpit os limites do plano (sessão de 5 h, semana) que o próprio Claude recebe a cada resposta.
// Usa o mesmo canal dos hooks (report.sh → socket privado com token); fora do Cockpit o report.sh não faz nada.

let sent = ''
let sentAt = 0

async function report($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<void> {
  if (!limits.length) return
  const body = JSON.stringify({
    hook_event_name: 'CockpitUsage',
    rateLimits: limits.map((l) => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  })
  const now = await $.clock.now()
  // Repete a mesma leitura no máximo a cada 5 minutos.
  if (body === sent && now - sentAt < 5 * 60_000) return
  sent = body
  sentAt = now
  await $.process.run(['/bin/sh', `${$.plugin.root}/hooks/report.sh`], { stdin: body, timeoutMs: 5000 }).catch(() => undefined)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await report($, (await $.session.usage()).rateLimits)
    } catch {
      // Antes da 1ª resposta não há leitura: o session.measure traz.
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await report($, e.rateLimits)
    return next(e)
  }).catch(($, e, next) => next(e))
}
