import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo } from '@shared/types'
import { CLAUDE_EFFORTS, CLAUDE_FAMILIES, effortName, familyLabel, familyOf, prettyModel } from '@shared/modelSwitch'
import { codexCurrent, enableAutoAndRestart, loadCatalog, requestModelChange, shownChoice, useModels } from '../modelSwitch'
import { actions, toast } from '../state/store'
import { Dropdown } from './ProjectView'
import { Segmented, Switch, type SegOption } from './ui'

// Rodapé do painel (como o composer do app do Claude): Auto à esquerda, modelo e esforço à direita.
// Altura fixa: entra uma vez e nunca muda o tamanho do terminal.
export function ModelBar({ session }: { session: SessionInfo }) {
  const agent = session.foreground ?? session.agent
  const catalog = useModels((s) => s.catalog)
  const pane = useModels((s) => s.panes[session.id])
  const running = session.lifecycle === 'running'

  useEffect(() => {
    void loadCatalog()
  }, [])

  // Codex: o modelo e o esforço reais estão no rodapé dele; relê de tempos em tempos.
  const [codexNow, setCodexNow] = useState<{ model?: string; effort?: string } | null>(null)
  useEffect(() => {
    if (agent !== 'codex' || !catalog) return
    const read = () => setCodexNow((prev) => {
      const next = codexCurrent(session.id, catalog.codex)
      return next && (next.model !== prev?.model || next.effort !== prev?.effort) ? next : prev
    })
    read()
    const t = window.setInterval(read, 2000)
    return () => window.clearInterval(t)
  }, [agent, catalog, session.id])

  if (agent !== 'claude' && agent !== 'codex') return null
  const disabled = !running
  const pending = !!pane?.pending || !!pane?.busy || !!pane?.restart
  const set = (change: Parameters<typeof requestModelChange>[1]) => requestModelChange(session.id, change)

  return (
    <div className={`pane-foot ${pending ? 'is-pending' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
      {agent === 'claude'
        ? <ClaudeControls session={session} disabled={disabled} set={set} />
        : <CodexControls now={{ ...codexNow, ...definedOnly(shownChoice(pane)) }} disabled={disabled} set={set} />}
      {pending && <span className="pf-pending" title={pane?.busy ? 'Aplicando…' : pane?.restart ? 'Reinicia e liga o Automático quando a sessão terminar o que está fazendo' : 'Aplica quando a sessão terminar o que está fazendo'} />}
    </div>
  )
}

const definedOnly = (c: { model?: string; effort?: string }) => ({
  ...(c.model !== undefined && { model: c.model }),
  ...(c.effort !== undefined && { effort: c.effort }),
})

type SetFn = (change: { model?: string; effort?: string; auto?: boolean }) => void

function ClaudeControls({ session, disabled, set }: { session: SessionInfo; disabled: boolean; set: SetFn }) {
  const catalog = useModels((s) => s.catalog)
  const pane = useModels((s) => s.panes[session.id])
  const want = shownChoice(pane)
  // O /auto-modelo só existe se o mod estava ligado quando a sessão abriu (sem o dado, como o Claude digitado num shell, vale o catálogo).
  const modLoaded = session.agent === 'claude' && session.autoModelo !== undefined ? session.autoModelo : !!catalog?.autoAvailable
  const canRestart = session.agent === 'claude' && !!session.claudeSessionId
  const auto = !!pane?.restart || (want.auto ?? pane?.auto ?? (modLoaded && catalog?.autoAvailable ? catalog.autoOn : false))
  // A escolha do painel (mesmo ainda sendo aplicada) e, sem ela, o que a sessão usou por último (transcript).
  const family = familyOf(want.model ?? pane?.model ?? session.model ?? catalog?.claudeModel) ?? 'opus'
  const effort = want.effort ?? pane?.effort ?? catalog?.claudeEffort
  const noEffort = family === 'haiku'
  const models: SegOption[] = useMemo(
    () => CLAUDE_FAMILIES.map((f) => ({ value: f, label: familyLabel(f, session.model) })),
    [session.model],
  )
  const efforts: SegOption[] = CLAUDE_EFFORTS.map((e) => ({ value: e, label: effortName(e) }))
  const routed = auto && session.model ? `Auto → ${prettyModel(session.model)}` : 'Auto'
  return (
    <>
      <Switch
        on={auto}
        onChange={(v) => {
          if (modLoaded) return set({ auto: v })
          if (!v) return
          // Sem o mod nesta sessão: liga o mod, reinicia retomando a conversa e liga o Automático.
          if (canRestart) return enableAutoAndRestart(session.id)
          // Claude digitado num shell: não dá para reiniciá-lo por fora.
          actions.set({ overlay: 'claudeMods', claudeModsFor: session.id })
          toast('Ligue o mod auto-modelo e reinicie o Claude (/exit e abra de novo) para usar o Automático.')
        }}
        disabled={disabled || !!pane?.restart}
        label={routed}
        title={modLoaded
          ? 'Automático (mod auto-modelo): Opus por padrão, Sonnet ou Haiku em pedidos simples'
          : 'Liga o mod auto-modelo e reinicia esta sessão retomando a mesma conversa'}
      />
      <span className="spacer" />
      <Picker
        label="Modelo"
        options={models}
        value={auto ? undefined : family}
        display={auto ? 'Auto' : familyLabel(family, session.model)}
        ghost={auto}
        disabled={disabled}
        onChange={(v) => set(auto ? { auto: false, model: v } : { model: v })}
      />
      <Picker
        label="Esforço"
        options={efforts}
        value={noEffort ? undefined : effort}
        display={noEffort ? '—' : effortName(effort)}
        disabled={disabled || noEffort}
        onChange={(v) => set({ effort: v })}
      />
    </>
  )
}

function CodexControls({ now, disabled, set }: { now: { model?: string; effort?: string } | null; disabled: boolean; set: SetFn }) {
  const catalog = useModels((s) => s.catalog)
  const list = catalog?.codex ?? []
  const current = list.find((m) => m.slug === now?.model)
  const models: SegOption[] = list.map((m) => ({ value: m.slug, label: m.name }))
  const efforts: SegOption[] = (current?.efforts ?? []).map((e) => ({ value: e, label: effortName(e) }))
  return (
    <>
      <span className="pf-agent">Codex</span>
      <span className="spacer" />
      {/* Oito modelos não cabem lado a lado: sempre em lista. */}
      <Picker label="Modelo" options={models} value={now?.model} display={current?.name ?? now?.model ?? '—'} disabled={disabled || !list.length} alwaysCompact onChange={(v) => set({ model: v })} />
      <Picker label="Esforço" options={efforts} value={now?.effort} display={effortName(now?.effort)} disabled={disabled || !efforts.length} onChange={(v) => set({ effort: v })} />
    </>
  )
}

// Segmentado no painel largo; no estreito (ou com muitas opções) vira um texto "Opus 5.5 ▾" que abre a lista.
function Picker({
  label, options, value, display, onChange, disabled, ghost, alwaysCompact,
}: {
  label: string; options: SegOption[]; value?: string; display: string; onChange: (v: string) => void
  disabled?: boolean; ghost?: boolean; alwaysCompact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const close = useMemo(() => () => setOpen(false), [])
  return (
    <div className={`pf-picker ${alwaysCompact ? 'compact-only' : ''}`}>
      {!alwaysCompact && <Segmented ariaLabel={label} options={options} value={value} onChange={onChange} disabled={disabled} ghost={ghost} />}
      <div className="menu-wrap pf-compact drop-up">
        <button type="button" className="pf-text-btn" disabled={disabled} aria-label={`${label}: ${display}`} onClick={() => setOpen(!open)}>
          {display} <span className="pf-caret">▾</span>
        </button>
        {open && (
          <Dropdown onClose={close}>
            <div className="dd-title">{label}</div>
            {options.map((o) => (
              <button key={o.value} className={`dd-item ${o.value === value ? 'selected' : ''}`} onClick={() => { setOpen(false); if (o.value !== value) onChange(o.value) }}>
                {o.label}
              </button>
            ))}
          </Dropdown>
        )}
      </div>
    </div>
  )
}
