import { useState } from 'react'
import { actions } from '../state/store'
import { useModal } from './useModal'
import { Button, Card, Chip, ChoiceList, Eyebrow, ProgressBar, Segmented, Stat, Switch } from './ui'

// Vitrine da base de design: os blocos dos mods do app desktop do Claude, montados com components/ui.
// Serve de referência para refazer cada mod do Claude Code como painel do Cockpit.
export function ComponentsView() {
  const close = () => actions.set({ overlay: null })
  const dialog = useModal<HTMLDivElement>(close)
  const [where, setWhere] = useState('project')
  const [model, setModel] = useState('opus')
  const [effort, setEffort] = useState('xhigh')
  const [auto, setAuto] = useState(false)
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="sheet showcase" ref={dialog} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Componentes</h2>
          <span className="spacer" />
          <button className="tab-x" onClick={close} title="Fechar (Esc)">×</button>
        </div>

        <Card icon="💡" iconTone="gold" eyebrow="Você deveria saber" eyebrowTone="gold" title={<>Cada clipe do Kling <Chip>custa cerca de $0,45</Chip></>} subtitle={<><Chip>Kie AI</Chip> cobra 90 créditos por clipe de 5 segundos.</>} />
        <div className="showcase-row">
          <Button variant="primary">Me conta mais</Button>
          <Button>Eu já sabia</Button>
          <Button variant="text">Dispensar</Button>
        </div>

        <Card icon="⧉" eyebrow="Cache tax" title="Sua mensagem está em espera" subtitle="O cache do prompt esfriou há 6h38m.">
          <div className="showcase-split">
            <div>
              <div className="muted">Enviar agora</div>
              <div className="showcase-big tone-accent">$0,52</div>
              <ProgressBar value={92} tone="accent" />
              <div className="muted small">reescreve até 51.929 tokens a $10/MTok</div>
            </div>
            <div>
              <div className="muted">Um turno quente</div>
              <div className="showcase-big tone-green">$0,03</div>
              <ProgressBar value={5} tone="green" />
              <div className="muted small">quanto teria custado</div>
            </div>
          </div>
        </Card>

        <Card icon="🗑" iconTone="red" glow title={<><code>rm -rf build</code> vai apagar <Chip glow>9 arquivos · 286 KB</Chip></>} subtitle="em demo-app">
          {[['vendor.81d3aa.js', 79], ['app.4f9c2e.js', 63], ['styles.c07b1d.css', 29]].map(([f, kb]) => (
            <div key={f} className="showcase-file">
              <Chip>{f}</Chip>
              <span className="spacer" />
              <span className="muted">{kb} KB</span>
              <div className="showcase-bar"><ProgressBar value={Number(kb)} tone="muted" /></div>
            </div>
          ))}
        </Card>

        <Card icon="🔖" iconTone="green" eyebrow="Salvar como regra?" eyebrowTone="green" aside="95% de certeza" title="“Use pnpm em vez de npm neste projeto.”">
          <Eyebrow tone="muted">Onde vai</Eyebrow>
          <ChoiceList
            value={where}
            onChange={setWhere}
            choices={[
              { value: 'project', icon: '▢', label: 'Só este projeto', detail: 'weather-station/CLAUDE.md' },
              { value: 'all', icon: '◎', label: 'Todos os seus projetos', detail: '~/.claude/CLAUDE.md' },
            ]}
          />
        </Card>

        <div className="showcase-stats">
          <Stat label="Custo" value="≈$0,25" />
          <Stat label="Tokens" value="252k" />
          <Stat label="Tempo" value="0:55" />
        </div>

        <div className="showcase-row">
          <Switch on={auto} onChange={setAuto} label="Auto" />
          <span className="spacer" />
          <Segmented ariaLabel="Modelo" value={model} onChange={setModel} ghost={auto} options={[{ value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }, { value: 'fable', label: 'Fable' }]} />
          <Segmented ariaLabel="Esforço" value={effort} onChange={setEffort} options={['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v === 'xhigh' ? 'Extra high' : v.charAt(0).toUpperCase() + v.slice(1) }))} />
        </div>
      </div>
    </div>
  )
}
