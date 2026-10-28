import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@shared/types'
import { FORBIDDEN_ARGS } from '../security'

// Procura o executável no PATH montado, sem passar por shell (DevProtocol.swift:139-146).
export function resolveBinary(name: string, path: string): string | null {
  for (const dir of path.split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // próximo
    }
  }
  return null
}

export interface LaunchSpec {
  file: string
  args: string[]
}

export interface LaunchOptions {
  resume?: boolean
  claudeSessionId?: string
  // Sessão nova: o Cockpit escolhe o id do Claude, para retomar exatamente esta conversa depois.
  newClaudeSessionId?: string
  pluginDir?: string
  // Primeira mensagem do Claude (montada pelo main).
  initialPrompt?: string
  // MCP do navegador do Cockpit desta sessão (JSON com URL e token próprios).
  mcpConfig?: string
  // Pedido do Hermes: Claude com Remote Control (respondível pelo app do Claude) começando em modo plano.
  remoteControl?: string
}

// Ferramentas do navegador do Cockpit já liberadas: o Claude não pede permissão a cada clique.
export const BROWSER_MCP_TOOLS = 'mcp__cockpit_browser'

export function launchArgs(agent: Agent, opts: LaunchOptions): string[] {
  let args: string[]
  switch (agent) {
    case 'shell':
      args = ['-il']
      break
    case 'claude':
      args = []
      if (opts.resume) {
        args.push('--resume')
        if (opts.claudeSessionId) args.push(opts.claudeSessionId)
      } else if (opts.newClaudeSessionId) {
        args.push('--session-id', opts.newClaudeSessionId)
      }
      if (opts.pluginDir) args.push('--plugin-dir', opts.pluginDir)
      // Forma `--flag=valor`: as duas aceitam vários valores e engoliriam a primeira mensagem.
      if (opts.mcpConfig) args.push(`--mcp-config=${opts.mcpConfig}`, `--allowedTools=${BROWSER_MCP_TOOLS}`)
      if (opts.remoteControl) {
        args.push(`--remote-control=${opts.remoteControl}`, '--permission-mode=plan')
        // `--` impede que um pedido começando com "-" vire opção.
        if (opts.initialPrompt) args.push('--', opts.initialPrompt)
      } else if (opts.initialPrompt && !opts.initialPrompt.startsWith('-')) args.push(opts.initialPrompt)
      break
    case 'codex':
      // Sem overrides `-c`: eles forçam o Codex a rodar sem o servidor compartilhado (aviso na inicialização).
      // O Codex 0.164 já informa o status exato por OSC 7501, como o Claude.
      args = opts.resume ? ['resume'] : []
      break
  }
  for (const a of args) if (FORBIDDEN_ARGS.includes(a)) throw new Error(`argumento proibido: ${a}`)
  return args
}

export function launchSpec(agent: Agent, path: string, opts: LaunchOptions, override?: string): LaunchSpec | { error: string } {
  if (agent === 'shell') return { file: '/bin/zsh', args: launchArgs('shell', opts) }
  const file = override ?? resolveBinary(agent, path)
  if (!file) return { error: `Não encontrei ${agent === 'claude' ? 'o Claude Code' : 'o Codex'} neste Mac. Instale e tente de novo.` }
  return { file, args: launchArgs(agent, opts) }
}
