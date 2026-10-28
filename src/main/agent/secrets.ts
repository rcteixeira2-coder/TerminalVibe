import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AdminKeyId, AgentProviderId } from '@shared/types'
import { encryptionAvailable, readEncryptedJson, writeEncryptedJson } from './crypto'

// Chaves de API (e as chaves Admin, só leitura de uso) criptografadas com o Keychain do macOS. Nunca saem do processo principal.
// O Keychain só é aberto no primeiro uso (Agente ou chaves em Preferências): abrir o app
// para usar só o terminal não dispara o aviso "Cockpit Safe Storage" do macOS.
type SecretId = AgentProviderId | AdminKeyId

export class AgentSecrets {
  private file: string
  private cache: Partial<Record<SecretId, string>> = {}
  private ready: Promise<void> | null = null

  constructor(userData: string) {
    this.file = join(userData, 'agent', 'keys.bin')
  }

  // Sem arquivo de chaves não há o que decifrar: nem pergunta ao Keychain. Um app reinstalado
  // (assinatura ad-hoc nova) faz o macOS pedir permissão de novo, e a resposta pendente travava o agente.
  private load(): Promise<void> {
    this.ready ??= (async () => {
      if (existsSync(this.file)) this.cache = await readEncryptedJson(this.file, {})
    })()
    return this.ready
  }

  stored(): boolean {
    return existsSync(this.file)
  }

  available(): Promise<boolean> {
    return encryptionAvailable()
  }

  async get(id: SecretId): Promise<string | undefined> {
    await this.load()
    return this.cache[id]
  }

  async has(id: SecretId): Promise<boolean> {
    return !!(await this.get(id))
  }

  // Gravações em fila: duas chaves salvas ao mesmo tempo partiam da mesma cópia e a última apagava a outra.
  private writing: Promise<void> = Promise.resolve()

  set(id: SecretId, key: string | null): Promise<void> {
    const run = this.writing.catch(() => {}).then(async () => {
      await this.load()
      const next = { ...this.cache }
      if (key && key.trim()) next[id] = key.trim()
      else delete next[id]
      await writeEncryptedJson(this.file, next)
      this.cache = next
    })
    this.writing = run
    return run
  }
}
