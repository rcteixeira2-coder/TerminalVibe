import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { app, safeStorage } from 'electron'

// Arquivos JSON criptografados com o Keychain (safeStorage assíncrono do Electron 45+).
// Só pode ser consultado depois do app pronto; antes disso a resposta é `false`.
let available: Promise<boolean> | null = null

export function encryptionAvailable(): Promise<boolean> {
  available ??= app
    .whenReady()
    .then(() => safeStorage.isAsyncEncryptionAvailable())
    .catch(() => false)
    .then((ok) => {
      // Não memoriza uma resposta negativa: pode ter sido transitória.
      if (!ok) available = null
      return ok
    })
  return available
}

export async function readEncryptedJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file) || !(await encryptionAvailable())) return fallback
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(file))
    const value = JSON.parse(result) as T
    // Chave do Keychain rotacionada: regrava com a nova.
    if (shouldReEncrypt) await writeEncryptedJson(file, value)
    return value
  } catch {
    return fallback
  }
}

export async function writeEncryptedJson(file: string, value: unknown): Promise<void> {
  if (!(await encryptionAvailable())) throw new Error('Criptografia do Keychain indisponível neste Mac.')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, await safeStorage.encryptStringAsync(JSON.stringify(value)), { mode: 0o600 })
  renameSync(tmp, file)
}
