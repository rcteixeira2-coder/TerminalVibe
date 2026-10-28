import { createHash } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentConversation, AgentConversationSummary } from '@shared/types'
import { readEncryptedJson, writeEncryptedJson } from './crypto'

const MAX_CONVERSATIONS = 60

// Conversas por projeto, criptografadas com o Keychain. Um arquivo por projeto; gravações em série.
export class AgentHistory {
  private dir: string
  private cache = new Map<string, Promise<AgentConversation[]>>()
  private writes = new Map<string, Promise<void>>()

  constructor(userData: string) {
    this.dir = join(userData, 'agent', 'history')
  }

  private file(projectId: string): string {
    return join(this.dir, `${createHash('sha1').update(projectId).digest('hex')}.bin`)
  }

  private all(projectId: string): Promise<AgentConversation[]> {
    let hit = this.cache.get(projectId)
    if (!hit) {
      hit = readEncryptedJson<AgentConversation[]>(this.file(projectId), [])
      this.cache.set(projectId, hit)
    }
    return hit
  }

  async list(projectId: string): Promise<AgentConversationSummary[]> {
    return (await this.all(projectId))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: c.messages.length }))
  }

  // Todas as conversas de todos os projetos (painel de uso: só os números de `usage` são lidos).
  async everything(): Promise<AgentConversation[]> {
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.bin'))
    } catch {
      return []
    }
    const lists = await Promise.all(files.map((f) => readEncryptedJson<AgentConversation[]>(join(this.dir, f), [])))
    return lists.flat()
  }

  async get(projectId: string, id: string): Promise<AgentConversation | undefined> {
    return (await this.all(projectId)).find((c) => c.id === id)
  }

  async put(conv: AgentConversation): Promise<void> {
    const list = (await this.all(conv.projectId)).filter((c) => c.id !== conv.id)
    list.push(conv)
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    this.cache.set(conv.projectId, Promise.resolve(list.slice(0, MAX_CONVERSATIONS)))
    await this.save(conv.projectId)
  }

  async delete(projectId: string, id: string | null): Promise<void> {
    if (id === null) {
      this.cache.set(projectId, Promise.resolve([]))
      rmSync(this.file(projectId), { force: true })
      return
    }
    this.cache.set(projectId, Promise.resolve((await this.all(projectId)).filter((c) => c.id !== id)))
    await this.save(projectId)
  }

  private save(projectId: string): Promise<void> {
    // Encadeia gravações do mesmo projeto para nunca intercalar dois rename.
    const prev = this.writes.get(projectId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(async () => writeEncryptedJson(this.file(projectId), await this.all(projectId)))
    this.writes.set(projectId, next)
    return next
  }
}
