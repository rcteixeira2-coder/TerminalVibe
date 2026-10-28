import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// Base de design do Cockpit (visual "Claude warm"): os mesmos blocos dos mods do app desktop do Claude.
// Classes com prefixo `ui-` (styles.css, seção "Base de design").

type Tone = 'accent' | 'gold' | 'green' | 'blue' | 'red' | 'muted'

export function Button({
  variant = 'secondary', size, children, ...rest
}: { variant?: 'primary' | 'secondary' | 'text' | 'danger'; size?: 'sm' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`ui-btn ui-btn-${variant} ${size === 'sm' ? 'ui-btn-sm' : ''} ${rest.className ?? ''}`}>{children}</button>
}

export function Eyebrow({ tone = 'accent', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`ui-eyebrow tone-${tone}`}>{children}</div>
}

export function IconTile({ tone = 'accent', round, children }: { tone?: Tone; round?: boolean; children: ReactNode }) {
  return <span className={`ui-icon-tile tone-${tone} ${round ? 'round' : ''}`}>{children}</span>
}

export function Chip({ children, glow }: { children: ReactNode; glow?: boolean }) {
  return <span className={`ui-chip ${glow ? 'ui-glow' : ''}`}>{children}</span>
}

export function Card({
  icon, iconTone, eyebrow, eyebrowTone, title, subtitle, aside, glow, children,
}: {
  icon?: ReactNode; iconTone?: Tone; eyebrow?: ReactNode; eyebrowTone?: Tone; title?: ReactNode; subtitle?: ReactNode
  aside?: ReactNode; glow?: boolean; children?: ReactNode
}) {
  return (
    <section className={`ui-card ${glow ? 'ui-glow' : ''}`}>
      {(icon || eyebrow || title) && (
        <header className="ui-card-head">
          {icon && <IconTile tone={iconTone}>{icon}</IconTile>}
          <div className="ui-card-titles">
            {eyebrow && <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow>}
            {title && <div className="ui-card-title">{title}</div>}
            {subtitle && <div className="ui-card-sub">{subtitle}</div>}
          </div>
          {aside && <div className="ui-card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className="ui-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`ui-progress-fill tone-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Switch({ on, onChange, label, disabled, title }: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} title={title} className={`ui-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="ui-switch-track"><span className="ui-switch-thumb" /></span>
      {label && <span className="ui-switch-label">{label}</span>}
    </button>
  )
}

export interface SegOption {
  value: string
  label: ReactNode
  title?: string
}

// Opções lado a lado; a pílula do ativo desliza até a opção escolhida.
export function Segmented({
  options, value, onChange, disabled, ariaLabel, ghost,
}: { options: SegOption[]; value?: string; onChange: (v: string) => void; disabled?: boolean; ariaLabel: string; ghost?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const measure = () => {
      const el = box.querySelector<HTMLElement>('.ui-seg-item.on')
      setPill(el && el.offsetWidth ? { left: el.offsetLeft, width: el.offsetWidth } : null)
    }
    measure()
    // Escondido (painel estreito) mede zero: mede de novo quando aparecer ou mudar de largura.
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [value, options])
  return (
    <div ref={ref} className={`ui-seg ${ghost ? 'ghost' : ''}`} role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled}>
      {pill && <span className="ui-seg-pill" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          title={o.title}
          className={`ui-seg-item ${o.value === value ? 'on' : ''}`}
          onClick={() => o.value !== value && onChange(o.value)}
        >{o.label}</button>
      ))}
    </div>
  )
}

export interface Choice {
  value: string
  icon?: ReactNode
  label: ReactNode
  detail?: ReactNode
}

// Lista de escolha (ícone + rótulo + detalhe mono à direita); a escolhida fica tingida de verde.
export function ChoiceList({ choices, value, onChange }: { choices: Choice[]; value?: string; onChange: (v: string) => void }) {
  return (
    <div className="ui-choices" role="radiogroup">
      {choices.map((c) => (
        <button key={c.value} type="button" role="radio" aria-checked={c.value === value} className={`ui-choice ${c.value === value ? 'on' : ''}`} onClick={() => onChange(c.value)}>
          {c.icon && <span className="ui-choice-icon">{c.icon}</span>}
          <span className="ui-choice-label">{c.label}</span>
          {c.detail && <span className="ui-choice-detail">{c.detail}</span>}
        </button>
      ))}
    </div>
  )
}

export function Stat({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="ui-stat">
      <div className="ui-stat-label">{label}</div>
      <div className="ui-stat-value">{value}</div>
    </div>
  )
}
