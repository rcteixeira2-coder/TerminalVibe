// Troca de modelo e esforço pelo rodapé do painel. Só lógica pura: o renderer lê a tela e escreve no pty.

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable'
export const CLAUDE_FAMILIES: ClaudeFamily[] = ['opus', 'sonnet', 'haiku', 'fable']
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const FAMILY_NAME: Record<ClaudeFamily, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' }

const EFFORT_NAME: Record<string, string> = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
}

export interface CodexModel {
  slug: string
  name: string
  efforts: string[]
  defaultEffort?: string
}

// O mod auto-modelo faz o roteamento Automático; liga e desliga com /auto-modelo e guarda isso em ~/.claude/plugins/store.
export const AUTO_MOD = 'auto-modelo@auto-modelo'

// O que o rodapé precisa saber ao abrir: modelos do Codex, padrões do Claude e o modo do mod creditos-sessao.
export interface ModelCatalog {
  codex: CodexModel[]
  claudeModel?: string
  claudeEffort?: string
  // O mod auto-modelo (roteamento Automático) está ligado no Claude Code? E se ele está ativo (o store dele).
  autoAvailable: boolean
  autoOn: boolean
}

export function effortName(effort: string | undefined): string {
  return effort ? (EFFORT_NAME[effort] ?? effort) : '—'
}

export function familyOf(id: string | undefined): ClaudeFamily | undefined {
  const s = id?.toLowerCase()
  return CLAUDE_FAMILIES.find((f) => s?.includes(f))
}

/** "claude-opus-5-5" → "Opus 5.5"; um apelido ("sonnet") → "Sonnet". */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id)
  if (m) {
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
  }
  const f = familyOf(id)
  return f ? FAMILY_NAME[f] : id
}

/** Rótulo de uma família no segmentado: com versão quando a sessão já disse qual é. */
export function familyLabel(f: ClaudeFamily, currentId?: string): string {
  return currentId && familyOf(currentId) === f ? prettyModel(currentId) : FAMILY_NAME[f]
}

// ---- Claude: comandos digitados no prompt ----

export interface ModelChange {
  model?: string
  effort?: string
  auto?: boolean
}

/** Os comandos que o Claude Code entende, na ordem certa (o Auto antes do modelo). */
export function claudeCommands(c: ModelChange): string[] {
  const out: string[] = []
  // Mod auto-modelo: Opus por padrão, Sonnet ou Haiku em pedidos simples.
  if (c.auto !== undefined) out.push(`/auto-modelo ${c.auto ? 'on' : 'off'}`)
  if (c.model && CLAUDE_FAMILIES.includes(c.model as ClaudeFamily)) out.push(`/model ${c.model}`)
  if (c.effort && (CLAUDE_EFFORTS as readonly string[]).includes(c.effort)) out.push(`/effort ${c.effort}`)
  return out
}

// ---- Codex: o menu do /model, lido na tela ----
//
// Codex 0.164 (capturado em tests/fixtures/codex-model-menu.txt):
//   "Select Model and Effort"  → linhas "› 1. GPT-6.1-Sol (current)"; o número escolhe o modelo.
//   "Select Reasoning Level for X" → Low…Extra high e "More reasoning…" (submenu "Advanced Reasoning" com Max/Ultra).
//   Rodapé: "enter default · s session · esc back". Enter grava no ~/.codex/config.toml; `s` vale só nesta sessão.

export const CODEX_KEYS = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', session: 's' }

export type CodexScreen = 'models' | 'efforts' | 'advanced' | 'other'

export function codexScreen(lines: string[]): CodexScreen {
  const text = lines.join('\n')
  if (/Advanced Reasoning/.test(text) && /\bs session\b/.test(text)) return 'advanced'
  if (/Select Reasoning Level for /.test(text)) return 'efforts'
  if (/Select Model and Effort/.test(text)) return 'models'
  return 'other'
}

interface MenuItem {
  n: number
  label: string
  selected: boolean
}

// Itens numerados do menu visível: "› 2. Medium (default)   descrição".
export function codexMenuItems(lines: string[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const line of lines) {
    const m = /^\s*(›)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?$/.exec(line)
    if (!m) continue
    out.push({ n: Number(m[2]), selected: !!m[1], label: m[3].replace(/\s*\((current|default)\)\s*$/i, '').trim() })
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')

/** A tecla (número) que escolhe o modelo na primeira tela, ou null se ele não estiver na lista. */
export function codexModelKey(lines: string[], model: CodexModel): string | null {
  const item = codexMenuItems(lines).find((i) => norm(i.label) === norm(model.name) || norm(i.label) === norm(model.slug))
  return item && item.n <= 9 ? String(item.n) : null
}

const ADVANCED = new Set(['max', 'ultra'])

/**
 * Teclas para levar o cursor até o esforço e aplicar só nesta sessão (`s`).
 * Max e Ultra moram no submenu: devolve `submenu: true` e as teclas até "More reasoning…" + Enter.
 */
export function codexEffortKeys(lines: string[], effort: string): { keys: string; submenu: boolean } | null {
  const items = codexMenuItems(lines)
  const cur = items.findIndex((i) => i.selected)
  if (cur < 0) return null
  const screen = codexScreen(lines)
  const want = EFFORT_NAME[effort] ?? effort
  let target = items.findIndex((i) => norm(i.label) === norm(want))
  let submenu = false
  if (target < 0 && screen === 'efforts' && ADVANCED.has(effort)) {
    target = items.findIndex((i) => /^more reasoning/i.test(i.label))
    submenu = true
  }
  if (target < 0) return null
  const d = target - cur
  const move = (d > 0 ? CODEX_KEYS.down : CODEX_KEYS.up).repeat(Math.abs(d))
  return { keys: move + (submenu ? CODEX_KEYS.enter : CODEX_KEYS.session), submenu }
}

/** O rodapé do Codex mostra "GPT-6.1-Sol high · ~/pasta": modelo e esforço atuais. */
export function parseCodexFooter(lines: string[], models: CodexModel[]): { model?: string; effort?: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*(\S.*?)\s+(minimal|low|medium|high|xhigh|max|ultra)\s+·\s/.exec(lines[i])
    if (!m) continue
    const found = models.find((x) => norm(x.name) === norm(m[1]) || norm(x.slug) === norm(m[1]))
    return { model: found?.slug ?? m[1], effort: m[2] }
  }
  return null
}

/** Os modelos visíveis do ~/.codex/models_cache.json (o mesmo que o /model do Codex lista). */
export function parseCodexCache(json: unknown): CodexModel[] {
  const models = (json as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  const out: CodexModel[] = []
  for (const m of models as Record<string, unknown>[]) {
    if (m.visibility !== 'list' || typeof m.slug !== 'string') continue
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
    out.push({
      slug: m.slug,
      name: typeof m.display_name === 'string' ? m.display_name : m.slug,
      efforts: levels.map((l: { effort?: unknown }) => l?.effort).filter((e): e is string => typeof e === 'string'),
      defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
    })
  }
  return out
}

/**
 * O prompt está vazio? Claude ("❯ ") e Codex ("› ") põem o cursor logo depois do marcador quando não há
 * rascunho (o texto de exemplo fica depois do cursor). Sem o marcador na linha do cursor (diálogo aberto,
 * rascunho de várias linhas) não dá para saber: quem chama não digita nada.
 */
export function promptState(cursorLine: string, cursorX: number): 'empty' | 'draft' | 'unknown' {
  const m = /^(\s*)[❯›>][\s ]/.exec(cursorLine)
  if (!m) return 'unknown'
  return cursorX > m[1].length + 2 ? 'draft' : 'empty'
}
