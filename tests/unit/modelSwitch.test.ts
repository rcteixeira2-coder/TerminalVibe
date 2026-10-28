import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_KEYS, claudeCommands, codexEffortKeys, codexModelKey, codexScreen, effortName, familyLabel, parseCodexCache,
  parseCodexFooter, prettyModel, promptState,
} from '../../src/shared/modelSwitch'

// Telas do Codex 0.164 capturadas num pty de verdade: "@@ nome" separa cada tela.
const screens: Record<string, string[]> = {}
let cur = ''
for (const line of readFileSync(join(__dirname, '../fixtures/codex-model-menu.txt'), 'utf8').split('\n')) {
  if (line.startsWith('@@ ')) screens[(cur = line.slice(3))] = []
  else if (cur) screens[cur].push(line)
}

const models = [
  { slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { slug: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { slug: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { slug: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
]
const { down, up, enter, session } = CODEX_KEYS

describe('nomes', () => {
  it('formata ids do Claude', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-fable-5-1-20261001')).toBe('Fable 5.1')
    expect(prettyModel('sonnet')).toBe('Sonnet')
  })
  it('mostra a versão só na família atual', () => {
    expect(familyLabel('opus', 'claude-opus-5-5')).toBe('Opus 5.5')
    expect(familyLabel('haiku', 'claude-opus-5-5')).toBe('Haiku')
  })
  it('esforço por extenso', () => expect(effortName('xhigh')).toBe('Extra high'))
})

describe('Claude', () => {
  it('monta os comandos na ordem', () =>
    expect(claudeCommands({ auto: false, model: 'sonnet', effort: 'low' })).toEqual(['/auto-modelo off', '/model sonnet', '/effort low']))
  it('ignora valores fora da lista', () => expect(claudeCommands({ model: 'gpt-6', effort: 'turbo' })).toEqual([]))
})

describe('Codex', () => {
  it('reconhece cada tela', () => {
    expect(codexScreen(screens.models)).toBe('models')
    expect(codexScreen(screens.efforts)).toBe('efforts')
    expect(codexScreen(screens.submenu)).toBe('advanced')
    expect(codexScreen(screens.afterEsc2)).toBe('other')
  })
  it('escolhe o modelo pelo número, pelo nome que o Codex mostra', () => {
    expect(codexModelKey(screens.models, models[2])).toBe('3')
    expect(codexModelKey(screens.models, models[3])).toBe('8')
    expect(codexModelKey(screens.models, { slug: 'x', name: 'Nope', efforts: [] })).toBeNull()
  })
  it('anda até o esforço e aplica só na sessão', () => {
    // Em "efforts" o cursor está em Low (default).
    expect(codexEffortKeys(screens.efforts, 'high')).toEqual({ keys: down + down + session, submenu: false })
    expect(codexEffortKeys(screens.efforts, 'low')).toEqual({ keys: session, submenu: false })
    expect(codexEffortKeys(screens.efforts, 'ultra')).toEqual({ keys: down.repeat(4) + enter, submenu: true })
  })
  it('no submenu escolhe Max ou Ultra', () => {
    expect(codexEffortKeys(screens.submenu, 'ultra')).toEqual({ keys: down + session, submenu: false })
    expect(codexEffortKeys(screens.submenuDown, 'max')).toEqual({ keys: up + session, submenu: false })
  })
  it('lê modelo e esforço do rodapé', () =>
    expect(parseCodexFooter(screens.afterEsc2, models)).toEqual({ model: 'gpt-6.1-sol', effort: 'high' }))
  it('lê o cache de modelos', () => {
    const out = parseCodexCache({
      models: [
        { slug: 'a', display_name: 'A', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low' },
        { slug: 'b', visibility: 'hide' },
      ],
    })
    expect(out).toEqual([{ slug: 'a', name: 'A', efforts: ['low'], defaultEffort: 'low' }])
    expect(parseCodexCache(null)).toEqual([])
  })
})

describe('prompt', () => {
  // Linhas e colunas capturadas do Claude 2.1 e do Codex 0.164.
  it('vazio com o texto de exemplo depois do cursor', () => {
    expect(promptState('❯\u00a0Try "how do I log an error?"', 2)).toBe('empty')
    expect(promptState('› Ask Codex to do anything', 2)).toBe('empty')
  })
  it('rascunho quando o cursor andou', () => expect(promptState('❯\u00a0abc', 5)).toBe('draft'))
  it('sem marcador não arrisca', () => expect(promptState('  continuação do rascunho', 3)).toBe('unknown'))
})
