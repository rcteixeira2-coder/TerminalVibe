import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeModInfo, ClaudeModsSnapshot } from '@shared/types'

// Mods do Claude Code = plugins em ~/.claude/mods/<pasta>, ligados por `enabledPlugins["nome@marketplace"]`
// no ~/.claude/settings.json. Só mexemos nessa chave (e no registro do marketplace ao ligar um mod novo),
// sempre por ação explícita do usuário; vale para as próximas sessões do Claude.
export const CLAUDE_MODS_DIR = join(homedir(), '.claude', 'mods')
const SETTINGS = join(homedir(), '.claude', 'settings.json')

type Settings = {
  enabledPlugins?: Record<string, boolean>
  extraKnownMarketplaces?: Record<string, { source: { source: string; path?: string } }>
  [k: string]: unknown
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

const BAD_SETTINGS = 'Não consegui ler ~/.claude/settings.json (JSON inválido).'

// null = arquivo existe mas não é um objeto JSON; nesse caso nunca gravamos.
function readSettings(): Settings | null {
  if (!existsSync(SETTINGS)) return {}
  const s = readJson<Settings>(SETTINGS)
  return s && typeof s === 'object' && !Array.isArray(s) ? s : null
}

function scanMods(): { key: string; marketplace: string; dir: string; name: string; version?: string; description?: string }[] {
  if (!existsSync(CLAUDE_MODS_DIR)) return []
  const out = []
  for (const ent of readdirSync(CLAUDE_MODS_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    const dir = join(CLAUDE_MODS_DIR, ent.name)
    const plugin = readJson<{ name?: string; version?: string; description?: string }>(join(dir, '.claude-plugin', 'plugin.json'))
    if (!plugin?.name) continue
    const market = readJson<{ name?: string }>(join(dir, '.claude-plugin', 'marketplace.json'))
    const marketplace = market?.name ?? ent.name
    out.push({ key: `${plugin.name}@${marketplace}`, marketplace, dir, name: plugin.name, version: plugin.version, description: plugin.description })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function claudeModsSnapshot(): ClaudeModsSnapshot {
  const settings = readSettings()
  const enabled = settings?.enabledPlugins ?? {}
  const mods: ClaudeModInfo[] = scanMods().map((m) => ({
    key: m.key, name: m.name, version: m.version, description: m.description, enabled: enabled[m.key] === true, kind: 'mod',
  }))
  const modKeys = new Set(mods.map((m) => m.key))
  const plugins: ClaudeModInfo[] = Object.keys(enabled)
    .filter((k) => !modKeys.has(k))
    .sort()
    .map((k) => ({ key: k, name: k.split('@')[0], enabled: enabled[k] === true, kind: 'plugin' }))
  return settings ? { mods, plugins } : { mods, plugins, error: BAD_SETTINGS }
}

export function setClaudeModEnabled(key: string, on: boolean): ClaudeModsSnapshot | { error: string } {
  // Lê de novo na hora de gravar: o próprio Claude também escreve nesse arquivo.
  const settings = readSettings()
  if (!settings) return { error: BAD_SETTINGS }
  const mod = scanMods().find((m) => m.key === key)
  // Só chaves que a tela mostrou: um mod da pasta ou um plugin já presente em enabledPlugins.
  if (!mod && !(settings.enabledPlugins && key in settings.enabledPlugins)) return { error: 'Mod desconhecido.' }
  settings.enabledPlugins = { ...settings.enabledPlugins, [key]: on }
  if (mod && on && !settings.extraKnownMarketplaces?.[mod.marketplace]) {
    settings.extraKnownMarketplaces = { ...settings.extraKnownMarketplaces, [mod.marketplace]: { source: { source: 'directory', path: mod.dir } } }
  }
  const tmp = `${SETTINGS}.cockpit-${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  renameSync(tmp, SETTINGS)
  return claudeModsSnapshot()
}
