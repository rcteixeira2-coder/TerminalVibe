import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lastAssistantModel, lastAssistantText } from '../../src/main/status/transcript'

const row = (o: object) => JSON.stringify(o)

describe('transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-tr-'))
  const file = join(root, 's.jsonl')
  writeFileSync(
    file,
    [
      row({ type: 'user', message: { content: 'oi' } }),
      row({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Quer que eu siga?' }] } }),
      row({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'subagente' }] } }),
      row({ type: 'system', subtype: 'turn_duration' }),
      '',
    ].join('\n'),
  )
  it('pega o texto da última resposta principal', () => expect(lastAssistantText(file, root)).toBe('Quer que eu siga?'))
  it('recusa caminho fora da pasta', () => expect(lastAssistantText(join(root, '..', 'x.jsonl'), root)).toBe(''))
  it('pega o modelo da última resposta principal', () => expect(lastAssistantModel(file, root)).toBe('claude-sonnet-5-5'))
  it('ignora valor inválido', () => expect(lastAssistantText(42, root)).toBe(''))
})
