import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// HOME falso antes de importar: o módulo resolve ~/.claude na carga.
const home = mkdtempSync(join(tmpdir(), 'cockpit-claude-mods-'))
process.env.HOME = home
const settingsPath = join(home, '.claude', 'settings.json')

function mod(dir: string, name: string, market = name) {
  const base = join(home, '.claude', 'mods', dir, '.claude-plugin')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: `desc ${name}` }))
  writeFileSync(join(base, 'marketplace.json'), JSON.stringify({ name: market, plugins: [{ name, source: './' }] }))
}

let m: typeof import('../../src/main/claudeMods')

beforeAll(async () => {
  mod('ligado', 'ligado')
  mod('novo', 'novo', 'mercado-novo')
  writeFileSync(settingsPath, JSON.stringify({ model: 'opus', enabledPlugins: { 'ligado@ligado': true, 'outro@market': false } }, null, 2) + '\n')
  m = await import('../../src/main/claudeMods')
})

describe('mods do Claude', () => {
  it('lista mods da pasta e os outros plugins', () => {
    const s = m.claudeModsSnapshot()
    expect(s.mods.map((x) => [x.key, x.enabled])).toEqual([['ligado@ligado', true], ['novo@mercado-novo', false]])
    expect(s.plugins.map((x) => [x.key, x.enabled])).toEqual([['outro@market', false]])
  })

  it('liga um mod novo registrando o marketplace e preserva o resto', () => {
    const r = m.setClaudeModEnabled('novo@mercado-novo', true)
    expect('mods' in r && !r.error).toBe(true)
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(saved.model).toBe('opus')
    expect(saved.enabledPlugins['novo@mercado-novo']).toBe(true)
    expect(saved.extraKnownMarketplaces['mercado-novo'].source).toEqual({ source: 'directory', path: join(home, '.claude', 'mods', 'novo') })
  })

  it('desliga e recusa chaves desconhecidas', () => {
    m.setClaudeModEnabled('ligado@ligado', false)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).enabledPlugins['ligado@ligado']).toBe(false)
    expect(m.setClaudeModEnabled('malicioso@x', true)).toEqual({ error: 'Mod desconhecido.' })
  })

  it('não grava se o settings.json estiver inválido', () => {
    writeFileSync(settingsPath, '{ quebrado')
    expect(m.setClaudeModEnabled('ligado@ligado', true)).toEqual({ error: expect.stringContaining('JSON inválido') })
    expect(m.claudeModsSnapshot().error).toContain('JSON inválido')
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ quebrado')
  })
})
