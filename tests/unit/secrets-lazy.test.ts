import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Keychain falso: conta quantas vezes o app pergunta/decifra.
const safeStorage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  decryptStringAsync: vi.fn(async (buf: Buffer) => ({ result: buf.toString('utf8'), shouldReEncrypt: false })),
  encryptStringAsync: vi.fn(async (s: string) => Buffer.from(s)),
}))
vi.mock('electron', () => ({ app: { whenReady: () => Promise.resolve() }, safeStorage }))

const { AgentSecrets } = await import('../../src/main/agent/secrets')

describe('chaves do agente: Keychain só no primeiro uso', () => {
  it('criar não toca no Keychain; o primeiro uso abre uma vez só', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'cockpit-secrets-'))
    mkdirSync(join(userData, 'agent'))
    writeFileSync(join(userData, 'agent', 'keys.bin'), JSON.stringify({ xai: 'xai-teste' }))

    const secrets = new AgentSecrets(userData)
    await new Promise((r) => setTimeout(r, 20))
    expect(safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled()

    expect(await secrets.has('xai')).toBe(true)
    expect(await secrets.has('openai')).toBe(false)
    expect(await secrets.available()).toBe(true)
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledTimes(1)
  })
})

describe('chaves do agente: sem arquivo de chaves', () => {
  it('nunca toca no Keychain para responder que não há chave', async () => {
    safeStorage.isAsyncEncryptionAvailable.mockClear()
    safeStorage.decryptStringAsync.mockClear()
    const secrets = new AgentSecrets(mkdtempSync(join(tmpdir(), 'cockpit-secrets-')))
    expect(secrets.stored()).toBe(false)
    expect(await secrets.has('xai')).toBe(false)
    expect(await secrets.get('anthropic')).toBeUndefined()
    expect(safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled()
  })
})
