import { describe, expect, it } from 'vitest'
import { activityFromHook, activityFromProgramStatus, endsWithQuestion, mostUrgent, ptDetail, parseProgramStatus, resolveIdle } from '../../src/shared/status'
import { StreamSniffer, findLocalUrls } from '../../src/main/pty/sniffer'
import { expectedLength, parseHookMessage } from '../../src/main/status/hookServer'

const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('OSC 7501', () => {
  it('interpreta o formato observado no spike', () => {
    const s = parseProgramStatus(`state=blocked:app=claude-code:kind=permission:progress=40:title=${b64('Rodar testes')}:msg=${b64('Bash: npm test')}`)!
    expect(s).toMatchObject({ state: 'blocked', kind: 'permission', progress: 40, title: 'Rodar testes', msg: 'Bash: npm test' })
    expect(activityFromProgramStatus(s)).toBe('needs_approval')
  })
  it('mapeia estados', () => {
    const a = (d: string) => activityFromProgramStatus(parseProgramStatus(d)!)
    expect(a('state=working:app=claude-code')).toBe('working')
    expect(a('state=done:app=claude-code')).toBe('idle')
    expect(a('state=idle:app=claude-code')).toBe('idle')
    expect(a('state=blocked:app=claude-code:kind=question')).toBe('your_turn')
    expect(a('state=blocked:app=claude-code:kind=auth')).toBe('your_turn')
    // Diálogo qualquer aberto (sem kind) não é pergunta.
    expect(a('state=blocked:app=claude-code')).toBeNull()
    expect(a('state=error:app=claude-code')).toBe('error')
    expect(a('state=clear')).toBe('clear')
    // Tarefas em segundo plano (id=) não mudam o estado principal.
    expect(a('state=working:app=claude-code:id=bg1')).toBeNull()
  })
  it('consulta não é status', () => expect(parseProgramStatus('?')).toBeNull())
})

describe('StreamSniffer', () => {
  const mk = () => new StreamSniffer({ answerProgramStatus: true, xtversion: 'xterm.js(6.0.0)' })
  it('responde à consulta 7501 e ao XTVERSION', () => {
    const r = mk().feed('a\x1b]7501;?\x1b\\b\x1b[>0qc')
    expect(r.replies).toEqual(['\x1b]7501;?\x1b\\', '\x1bP>|xterm.js(6.0.0)\x1b\\'])
  })
  it('não responde 7501 quando desligado', () => {
    const s = new StreamSniffer({ answerProgramStatus: false, xtversion: 'x' })
    expect(s.feed('\x1b]7501;?\x07').replies).toEqual([])
  })
  it('junta sequências partidas entre blocos', () => {
    const s = mk()
    expect(s.feed('xx\x1b]75').events).toEqual([])
    expect(s.feed('01;state=work').events).toEqual([])
    expect(s.feed('ing:app=claude-code\x07yy').events).toEqual([{ type: 'program', data: 'state=working:app=claude-code' }])
  })
  it('extrai OSC 9, 777, título e BEL', () => {
    const ev = mk().feed('\x1b]9;Codex terminou\x07\x1b]9;4;1;50\x07\x1b]777;notify;T;B\x07\x1b]0;Tarefa\x07\x07').events
    expect(ev).toEqual([
      { type: 'notify', code: 9, data: 'Codex terminou' },
      { type: 'notify', code: 777, data: 'T;B' },
      { type: 'title', title: 'Tarefa' },
      { type: 'bell' },
    ])
  })
  it('descarta OSC acima de 64 KB', () => {
    const ev = mk().feed(`\x1b]0;${'x'.repeat(70 * 1024)}\x07`).events
    expect(ev.filter((e) => e.type === 'title')).toEqual([])
  })
})

describe('hooks', () => {
  it('mapeia eventos', () => {
    expect(activityFromHook({ hook_event_name: 'UserPromptSubmit' }).activity).toBe('working')
    expect(activityFromHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toMatchObject({ activity: 'needs_approval', detail: 'Permissão: Bash' })
    expect(activityFromHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).activity).toBe('needs_approval')
    expect(activityFromHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).activity).toBe('idle')
    expect(activityFromHook({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }).activity).toBe('your_turn')
    expect(activityFromHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }).activity).toBe('your_turn')
    expect(activityFromHook({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' }).detail).toBe('Plano pronto para revisão')
    expect(activityFromHook({ hook_event_name: 'Stop', background_tasks: [] }).activity).toBe('done')
    expect(activityFromHook({ hook_event_name: 'Stop', background_tasks: [{}] }).activity).toBe('working')
    expect(activityFromHook({ hook_event_name: 'StopFailure', error: 'rate' }).activity).toBe('error')
    expect(activityFromHook({ hook_event_name: 'SessionEnd' }).ended).toBe(true)
  })
  it('Stop: pergunta no fim = sua vez; sem pergunta = concluído', () => {
    const stop = (m: string) => activityFromHook({ hook_event_name: 'Stop', last_assistant_message: m }).activity
    expect(stop('Pronto, corrigi o bug.\n\nQuer que eu suba para o GitHub?')).toBe('your_turn')
    expect(stop('Pronto, corrigi o bug.')).toBe('done')
    expect(stop('Por que quebrava? O cache.\n\nCorrigido e testado.')).toBe('done')
    expect(stop('Feito.\n\n---\nTOPICO: X\nRESUMO: e agora?\nPROXIMO PASSO: subir\n---')).toBe('done')
    expect(stop('Qual cor você prefere?\n\n---\nTOPICO: X\nPROXIMO PASSO: responder\n---')).toBe('your_turn')
    expect(endsWithQuestion('')).toBe(false)
  })
  it('"parado" não apaga terminou; aba nova parada é sua vez', () => {
    expect(resolveIdle('working')).toBe('done')
    expect(resolveIdle('done')).toBe('done')
    expect(resolveIdle('your_turn')).toBe('your_turn')
    expect(resolveIdle('unknown')).toBe('your_turn')
    expect(resolveIdle('error')).toBe('error')
    expect(resolveIdle('needs_approval')).toBe('your_turn')
  })
  it('diálogo aberto depois de terminar continua "Terminou"', () => {
    let act: ReturnType<typeof resolveIdle> = 'working'
    for (const d of ['state=done:app=claude-code', 'state=blocked:app=claude-code', 'state=done:app=claude-code']) {
      const a = activityFromProgramStatus(parseProgramStatus(d)!)
      if (a === 'idle') act = resolveIdle(act)
      else if (a && a !== 'clear') act = a
    }
    expect(act).toBe('done')
  })
  it('valida token e id do painel', () => {
    const pane = '6a59950f-22b9-4f9f-a236-e6a0612b1e8b'
    const body = JSON.stringify({ hook_event_name: 'Stop' })
    const msg = `tok ${pane} ${Buffer.byteLength(body)}\n${body}`
    expect(parseHookMessage(msg, 'tok')).toMatchObject({ paneId: pane })
    expect(parseHookMessage(msg, 'outro')).toBeNull()
    expect(parseHookMessage(`tok ../etc 2\n{}`, 'tok')).toBeNull()
    expect(parseHookMessage(`tok ${pane} 2\n[]`, 'tok')).toBeNull()
    expect(expectedLength(Buffer.from(msg))).toBe(Buffer.byteLength(msg))
  })
})

describe('urgência e localhost', () => {
  it('aprovação vence tudo', () => expect(mostUrgent(['working', 'done', 'needs_approval', 'your_turn'])).toBe('needs_approval'))
  it('acha URLs de dev server', () => {
    expect(findLocalUrls('\x1b[32m  ➜  Local:   http://localhost:5173/\x1b[0m')).toEqual(['http://localhost:5173/'])
    expect(findLocalUrls('ready on http://0.0.0.0:3000.')).toEqual(['http://localhost:3000/'])
    expect(findLocalUrls('https://127.0.0.1:8443/app')).toEqual(['https://127.0.0.1:8443/app'])
    expect(findLocalUrls('https://example.com:3000')).toEqual([])
  })
})

describe('correções da revisão', () => {
  it('OSC acima de 64 KB é descartado sem virar BEL', () => {
    const ev = new StreamSniffer({ answerProgramStatus: true, xtversion: 'x' }).feed(`\x1b]0;${'x'.repeat(70 * 1024)}\x07depois`).events
    expect(ev).toEqual([])
  })
})

describe('avisos do Claude em pt-BR', () => {
  it('traduz os avisos conhecidos e deixa o resto igual', () => {
    expect(ptDetail('Claude is waiting for your input')).toBe('Esperando você')
    expect(ptDetail('Claude needs your permission to use Bash')).toBe('Pede permissão para usar Bash')
    expect(ptDetail('Algo em português')).toBe('Algo em português')
    expect(activityFromHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' }))
      .toEqual({ activity: 'needs_approval', detail: 'Pede permissão para usar Write' })
  })
})
