// Mod de exemplo. Roda isolado (sem internet, sem acesso a arquivos) e usa só window.cockpit.
const PRECISA = new Set(['needs_approval', 'your_turn', 'error'])
const NOMES = { needs_approval: 'aprovação', your_turn: 'sua vez', error: 'erro' }

async function pendentes() {
  const sessions = await cockpit.listSessions()
  return sessions.filter((s) => s.lifecycle === 'running' && PRECISA.has(s.activity))
}

async function atualizarPainel() {
  const lista = await pendentes()
  await cockpit.postToPanel('painel', lista.map((s) => ({ projeto: s.projectName, titulo: s.title, estado: NOMES[s.activity], detalhe: s.detail || '' })))
}

cockpit.onAction(async (actionId) => {
  if (actionId !== 'listar') return
  const lista = await pendentes()
  if (!lista.length) return cockpit.notify('Tudo em dia', 'Nenhuma sessão precisa de você agora.')
  const texto = lista.map((s) => `${s.projectName} · ${s.title}: ${NOMES[s.activity]}`).join('\n')
  await cockpit.notify(`${lista.length} sessão(ões) esperando você`, texto)
})

cockpit.onSessionEvent(() => void atualizarPainel())
cockpit.onPanelMessage((_panelId, msg) => {
  if (msg === 'ready') void atualizarPainel()
})
