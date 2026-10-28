import { useEffect, useState } from 'react'
import type { Prefs } from '@shared/types'
import { actions, useStore } from '../state/store'
import { setFontSize } from '../terminal/registry'
import { useModal } from './useModal'
import { refreshAgentConfig } from '../controller'
import type { AdminKeyId, AgentProviderInfo } from '@shared/types'

export function PrefsView() {
  const prefs = useStore((s) => s.prefs)
  const [notifier, setNotifier] = useState<{ installed: boolean; muted: boolean } | null>(null)
  const close = () => actions.set({ overlay: null })
  const dialog = useModal<HTMLDivElement>(close)
  useEffect(() => {
    void window.cockpit.invoke('notifier:status').then(setNotifier)
  }, [])
  const patch = async (p: Partial<Prefs>) => {
    const next = await window.cockpit.invoke('prefs:set', p)
    actions.set({ prefs: next })
    setFontSize(next.fontSize)
  }
  const toggle = (k: keyof Prefs, label: string, help?: string) => (
    <label className="pref">
      <div>
        <div>{label}</div>
        {help && <div className="muted small">{help}</div>}
      </div>
      <span className="switch">
        <input type="checkbox" checked={!!prefs[k]} onChange={(e) => void patch({ [k]: e.target.checked })} />
        <span />
      </span>
    </label>
  )
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="sheet" ref={dialog} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Preferências</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={close}>×</button>
        </div>
        {toggle('notifications', 'Notificações do macOS', 'Quando uma sessão precisa de aprovação, espera você, termina ou dá erro — só se você não estiver olhando para ela.')}
        {toggle('sound', 'Som nas notificações')}
        {toggle('oscStatus', 'Status direto do Claude (OSC 7501)', 'O Claude Code informa sozinho trabalhando/aguardando. Desligue só se notar algo estranho; os hooks continuam valendo.')}
        <div className="pref">
          <div>
            <div>Tamanho da fonte</div>
            <div className="muted small">⌘= e ⌘- também ajustam.</div>
          </div>
          <div className="stepper">
            <button className="ghost-btn small" onClick={() => void patch({ fontSize: prefs.fontSize - 1 })}>−</button>
            <span>{prefs.fontSize}</span>
            <button className="ghost-btn small" onClick={() => void patch({ fontSize: prefs.fontSize + 1 })}>+</button>
          </div>
        </div>
        <AgentPrefs />
        <AdminPrefs />
        {notifier?.installed && (
          <div className="pref-box">
            <div><strong>Claude Notifier detectado</strong></div>
            <div className="muted small">
              Os hooks do claude-notifier também mostram avisos e tocam som, então você pode receber avisos duplicados. Você escolhe:
              silenciar o claude-notifier (cria o arquivo <code>~/.claude/hooks/claude-notifier-muted</code>, reversível e global — vale também no Cursor)
              ou deixar o Cockpit quieto nas sessões do Claude.
            </div>
            <div className="row">
              <button className="ghost-btn small" onClick={() => void window.cockpit.invoke('notifier:mute', !notifier.muted).then(setNotifier)}>
                {notifier.muted ? 'Reativar o claude-notifier' : 'Silenciar o claude-notifier'}
              </button>
            </div>
            {toggle('silentWhenNotifier', 'Cockpit em silêncio nas sessões do Claude enquanto o claude-notifier estiver ativo')}
          </div>
        )}
      </div>
    </div>
  )
}

// Chaves dos provedores do agente: vão direto ao main (Keychain); a tela só mostra se está configurada.
function AgentPrefs() {
  const providers = useStore((s) => s.agentConfig.providers)
  const encryption = useStore((s) => s.agentConfig.encryption)
  // Abrir Preferências não toca no Keychain; só "Mostrar chaves" (ou o Agente já usado nesta sessão).
  const loaded = useStore((s) => s.agentConfig.loaded)
  const [busy, setBusy] = useState(false)
  return (
    <div className="pref-box">
      <div><strong>Agente</strong> <span className="muted small">— chaves guardadas criptografadas no Keychain do Mac; nunca aparecem na tela.</span></div>
      {!loaded ? (
        <div className="row">
          <span className="muted small">O macOS pode pedir a senha do Keychain ("Cockpit Safe Storage"). O terminal não depende disso.</span>
          <span className="spacer" />
          <button className="ghost-btn small" disabled={busy} onClick={() => { setBusy(true); void refreshAgentConfig().finally(() => setBusy(false)) }}>
            {busy ? 'Abrindo…' : 'Mostrar chaves'}
          </button>
        </div>
      ) : (
        <>
          {!encryption && <div className="error small">A criptografia do Keychain não está disponível; não é possível salvar chaves.</div>}
          {providers.map((p) => <ProviderRow key={p.id} p={p} />)}
        </>
      )}
    </div>
  )
}

function ProviderRow({ p }: { p: AgentProviderInfo }) {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (v: string | null) => {
    const r = p.needsKey ? await window.cockpit.invoke('agent:setKey', p.id, v) : await window.cockpit.invoke('agent:setBaseUrl', p.id, v)
    setValue('')
    await refreshAgentConfig()
    if (!r.ok) setStatus({ ok: false, text: r.error ?? 'Erro.' })
    else if (v) await test()
    else setStatus(null)
  }
  const test = async () => {
    setBusy(true)
    const r = await window.cockpit.invoke('agent:test', p.id)
    setBusy(false)
    setStatus({ ok: r.ok, text: r.message })
  }
  // Assinatura: usa o login do Claude Code deste Mac, sem chave nem endereço.
  if (p.id === 'claudecode') {
    return (
      <div className="provider-row">
        <div className="provider-name">
          {p.label}
          <span className={`badge ${p.configured ? 'badge-done' : 'badge-dead'}`}>{p.configured ? 'Claude Code ✓' : 'não instalado'}</span>
        </div>
        <div className="row">
          <span className="muted small">Usa o login do Claude Code (Pro/Max) — sem chave de API e sem custo por token.</span>
          <span className="spacer" />
          <button className="ghost-btn small" disabled={busy || !p.configured} onClick={() => void test()}>{busy ? 'Testando…' : 'Testar'}</button>
        </div>
        {status && <div className={`small ${status.ok ? 'ok-text' : 'error'}`}>{status.text}</div>}
      </div>
    )
  }
  return (
    <div className="provider-row">
      <div className="provider-name">
        {p.label}
        <span className={`badge ${p.configured ? 'badge-done' : 'badge-dead'}`}>{p.needsKey ? (p.configured ? 'configurada ✓' : 'sem chave') : 'local'}</span>
      </div>
      <div className="row">
        <input
          className="pref-input"
          type={p.needsKey ? 'password' : 'text'}
          placeholder={p.needsKey ? (p.configured ? 'Colar nova chave para trocar' : 'Colar a chave da API') : p.baseUrl}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save(value.trim())}
        />
        <button className="ghost-btn small" disabled={!value.trim()} onClick={() => void save(value.trim())}>Salvar</button>
        <button className="ghost-btn small" disabled={busy || (p.needsKey && !p.configured)} onClick={() => void test()}>{busy ? 'Testando…' : 'Testar'}</button>
        {p.needsKey && p.configured && <button className="ghost-btn small danger" onClick={() => void save(null)}>Remover</button>}
      </div>
      {status && <div className={`small ${status.ok ? 'ok-text' : 'error'}`}>{status.text}</div>}
    </div>
  )
}

// Chaves Admin: só leitura dos relatórios de uso e custo da conta inteira (painel 📊 → API).
function AdminPrefs() {
  const loaded = useStore((s) => s.agentConfig.loaded)
  const [status, setStatus] = useState<Record<AdminKeyId, boolean> | null>(null)
  useEffect(() => {
    if (loaded) void window.cockpit.invoke('usage:adminStatus').then(setStatus)
  }, [loaded])
  const rows: [AdminKeyId, string, string][] = [
    ['anthropic-admin', 'Anthropic (Console)', 'sk-ant-admin…  ·  Console → Settings → Admin keys'],
    ['openai-admin', 'OpenAI (Platform)', 'sk-admin-…  ·  Organization → Admin keys'],
  ]
  return (
    <div className="pref-box">
      <div><strong>Uso da conta inteira</strong> <span className="muted small">— chaves Admin, só para ler uso e custo no painel 📊. Nenhum modelo é chamado com elas.</span></div>
      {!loaded || !status ? (
        <div className="muted small">Use "Mostrar chaves" acima para ver e configurar.</div>
      ) : (
        rows.map(([id, label, hint]) => (
          <AdminRow key={id} id={id} label={label} hint={hint} configured={status[id]} onChange={() => void window.cockpit.invoke('usage:adminStatus').then(setStatus)} />
        ))
      )}
      <div className="muted small">xAI: não há relatório de uso por API para contas comuns; o gasto fica em console.x.ai → Usage.</div>
    </div>
  )
}

function AdminRow({ id, label, hint, configured, onChange }: { id: AdminKeyId; label: string; hint: string; configured: boolean; onChange: () => void }) {
  const [value, setValue] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const test = async () => {
    setBusy(true)
    const r = await window.cockpit.invoke('usage:testAdmin', id)
    setBusy(false)
    setMsg({ ok: r.ok, text: r.message })
  }
  const save = async (v: string | null) => {
    const r = await window.cockpit.invoke('usage:setAdminKey', id, v)
    setValue('')
    onChange()
    if (!r.ok) setMsg({ ok: false, text: r.error ?? 'Erro.' })
    else if (v) await test()
    else setMsg(null)
  }
  return (
    <div className="provider-row">
      <div className="provider-name">
        {label}
        <span className={`badge ${configured ? 'badge-done' : 'badge-dead'}`}>{configured ? 'configurada ✓' : 'sem chave'}</span>
      </div>
      <div className="row">
        <input className="pref-input" type="password" placeholder={configured ? 'Colar nova chave para trocar' : hint} value={value}
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save(value.trim())} />
        <button className="ghost-btn small" disabled={!value.trim()} onClick={() => void save(value.trim())}>Salvar</button>
        <button className="ghost-btn small" disabled={busy || !configured} onClick={() => void test()}>{busy ? 'Testando…' : 'Testar'}</button>
        {configured && <button className="ghost-btn small danger" onClick={() => void save(null)}>Remover</button>}
      </div>
      {msg && <div className={`small ${msg.ok ? 'ok-text' : 'error'}`}>{msg.text}</div>}
    </div>
  )
}
