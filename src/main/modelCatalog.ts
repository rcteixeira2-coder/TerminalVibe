import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AUTO_MOD, type ModelCatalog, parseCodexCache } from '@shared/modelSwitch'
import { claudeModsSnapshot } from './claudeMods'

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// Sem nada gravado o mod começa ligado (`enabled !== false`, como no register.ts dele).
function autoModeSaved(home: string): boolean {
  const dir = join(home, '.claude', 'plugins', 'store')
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith('auto-modelo_auto-modelo-') && f.endsWith('.json')) : undefined
  return !file || (readJson(join(dir, file)) as { enabled?: unknown } | null)?.enabled !== false
}

// Só leitura: nada aqui grava nas configurações do Claude ou do Codex.
export function modelCatalog(home = homedir()): ModelCatalog {
  const settings = (readJson(join(home, '.claude', 'settings.json')) ?? {}) as {
    model?: unknown
    effortLevel?: unknown
    modelSettings?: Record<string, { effortLevel?: unknown }>
  }
  const claudeModel = typeof settings.model === 'string' ? settings.model : undefined
  // O esforço pode ser por modelo (modelSettings["claude-opus-5-5"]); sem ele vale o geral.
  const perModel = Object.entries(settings.modelSettings ?? {}).find(([id]) => claudeModel && id.includes(claudeModel))?.[1]?.effortLevel
  const effort = typeof perModel === 'string' ? perModel : typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined
  const autoAvailable = claudeModsSnapshot().mods.some((m) => m.key === AUTO_MOD && m.enabled)
  return {
    codex: parseCodexCache(readJson(join(home, '.codex', 'models_cache.json'))),
    claudeModel,
    claudeEffort: effort,
    autoAvailable,
    autoOn: autoAvailable && autoModeSaved(home),
  }
}
