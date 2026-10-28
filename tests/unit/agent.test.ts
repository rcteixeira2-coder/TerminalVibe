import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isSecretPath, runTool, TOOL_DEFS, type ToolContext } from '../../src/main/agent/tools'
import { OpenAICompatProvider } from '../../src/main/agent/providers/openaiCompat'
import { AnthropicProvider } from '../../src/main/agent/providers/anthropic'
import { friendlyError } from '../../src/main/agent/providers/types'
// @ts-expect-error módulo .mjs de teste sem tipos
import { startFakeAnthropic, startFakeOpenAI } from '../fixtures/fakeLLM.mjs'

const root = mkdtempSync(join(tmpdir(), 'cockpit-agent-'))
const outside = mkdtempSync(join(tmpdir(), 'cockpit-out-'))
mkdirSync(join(root, 'src'))
mkdirSync(join(root, '.git'))
writeFileSync(join(root, 'README.md'), '# Projeto X\nlinha dois\nlinha tres\n')
writeFileSync(join(root, 'src', 'app.ts'), 'export function isInside() {}\nconst x = isInside()\n')
writeFileSync(join(root, '.env'), 'SEGREDO=1')
writeFileSync(join(root, '.git', 'config'), '[core]')
writeFileSync(join(root, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 9]))
writeFileSync(join(outside, 'secret.txt'), 'fora')
symlinkSync(outside, join(root, 'atalho'))
const ctx: ToolContext = {
  root,
  sessions: () => [{ id: 's1', title: 'Claude', agent: 'claude' }],
  tail: () => 'Error: deu ruim na linha 3',
}

describe('ferramentas do agente', () => {
  it('lê com números de linha e intervalo', async () => {
    const r = await runTool(ctx, 'read_file', { path: 'README.md', start_line: 2, end_line: 2 })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('2| linha dois\n[linhas 2–2 de 3; peça outro intervalo para continuar]')
    // Arquivo inteiro: sem nota e sem linha vazia extra.
    expect((await runTool(ctx, 'read_file', { path: 'README.md' })).content).toBe('1| # Projeto X\n2| linha dois\n3| linha tres\n')
  })
  it.each([['../../etc/hosts'], ['/etc/hosts'], ['atalho/secret.txt'], ['.env'], ['.git/config'], ['nao-existe.ts']])('recusa %s', async (p) => {
    const r = await runTool(ctx, 'read_file', { path: p })
    expect(r.ok).toBe(false)
  })
  it('recusa binário', async () => expect((await runTool(ctx, 'read_file', { path: 'img.bin' })).content).toContain('binário'))
  it('lista sem mostrar segredos', async () => {
    const r = await runTool(ctx, 'list_dir', { path: '.' })
    expect(r.content).toContain('README.md')
    expect(r.content).not.toContain('.env')
    expect(r.content).not.toContain('.git')
  })
  it('busca sem varrer segredos', async () => {
    const r = await runTool(ctx, 'search', { query: 'isinside' })
    expect(r.content).toContain('src/app.ts:1:')
    expect(r.content).toContain('src/app.ts:2:')
    expect((await runTool(ctx, 'search', { query: 'SEGREDO' })).content).toBe('Nenhum resultado.')
  })
  it('terminal_tail lista e lê', async () => {
    expect((await runTool(ctx, 'terminal_tail', {})).content).toContain('Claude (claude) id=s1')
    expect((await runTool(ctx, 'terminal_tail', { session: 'claude' })).content).toContain('deu ruim')
  })
  it('isSecretPath', () => {
    for (const p of ['.env', 'a/.env.local', 'k/server.pem', '.ssh/id_rsa', 'id_ed25519', '.git/HEAD', '.npmrc']) expect(isSecretPath(p)).toBe(true)
    for (const p of ['src/env.ts', 'README.md', '.github/workflows/ci.yml']) expect(isSecretPath(p)).toBe(false)
  })
})

const base = (overrides = {}) => {
  const log = { text: '', thinking: '', tools: [] as { name: string; ok?: boolean; summary: string }[], notices: [] as string[] }
  return {
    log,
    input: {
      system: 'sys',
      history: [{ role: 'user' as const, content: 'o que tem no README?' }],
      tools: TOOL_DEFS,
      signal: new AbortController().signal,
      maxRounds: 5,
      onText: (d: string) => (log.text += d),
      onThinking: (d: string) => (log.thinking += d),
      onTool: (c: { name: string; ok?: boolean; summary: string }) => log.tools.push(c),
      onNotice: (t: string) => log.notices.push(t),
      runTool: (name: string, input: Record<string, unknown>) => runTool(ctx, name, input),
      ...overrides,
    },
  }
}

describe('provedor compatível com OpenAI (Grok/OpenAI/locais)', async () => {
  const fake = await startFakeOpenAI()
  afterAll(() => fake.server.close())
  it('streaming + ferramenta + segunda rodada', async () => {
    const p = new OpenAICompatProvider('Grok', fake.url, 'xai-chave-secreta', false)
    const { log, input } = base()
    const r = await p.run({ ...input, model: 'grok-fake' })
    expect(log.thinking).toBe('vou ler o arquivo')
    expect(log.tools.map((t) => [t.name, t.ok])).toEqual([['read_file', undefined], ['read_file', true]])
    expect(log.text).toBe('O arquivo `README.md:1` começa com: "1| # Projeto X"')
    expect(r.usage).toMatchObject({ input: 200, output: 40 })
    // A resposta da ferramenta voltou ao modelo com o conteúdo lido.
    const second = fake.calls[1].body.messages
    expect(second.find((m: { role: string }) => m.role === 'tool').content).toContain('# Projeto X')
    expect(fake.calls[0].auth).toBe('Bearer xai-chave-secreta')
    expect(await p.models()).toEqual(['grok-fake', 'grok-fake-mini'])
  })
  it('erro 401 vira mensagem clara, sem vazar a chave', async () => {
    const bad = await startFakeOpenAI({ status: 401 })
    const p = new OpenAICompatProvider('Grok', bad.url, 'xai-abcdefghijklmnop', false)
    const { input } = base()
    await expect(p.run({ ...input, model: 'x' })).rejects.toThrow(/Chave do Grok inválida/)
    bad.server.close()
  })
})

describe('provedor Anthropic (SDK oficial)', async () => {
  const fake = await startFakeAnthropic()
  afterAll(() => fake.server.close())
  it('loop manual com tool_use, cache e fallback ligados', async () => {
    process.env.ANTHROPIC_BASE_URL = fake.url
    const p = new AnthropicProvider('sk-ant-teste')
    const { log, input } = base()
    const r = await p.run({ ...input, model: 'claude-opus-5-5' })
    delete process.env.ANTHROPIC_BASE_URL
    expect(log.tools.map((t) => [t.name, t.ok])).toEqual([['read_file', undefined], ['read_file', true]])
    expect(log.text).toBe('Li o `README.md:1`. Tudo certo.')
    expect(r.usage.cacheRead).toBe(80)
    const first = fake.calls[0]
    // SDK 1.x autentica com Bearer.
    expect(first.key).toBe('Bearer sk-ant-teste')
    expect(first.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(first.body.output_config).toEqual({ effort: 'medium' })
    expect(first.body.cache_control).toEqual({ type: 'ephemeral' })
    expect(first.body.fallbacks).toBe('default')
    expect(first.beta).toContain('server-side-fallback-2026-07-01')
    expect(first.body.tools[0]).toMatchObject({ strict: true, eager_input_streaming: true })
    const toolResult = fake.calls[1].body.messages.at(-1).content[0]
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false })
    expect(toolResult.content).toContain('1| # Projeto X')
  })
  it('modelo antigo não recebe parâmetros que ele rejeitaria', async () => {
    process.env.ANTHROPIC_BASE_URL = fake.url
    const p = new AnthropicProvider('sk-ant-teste')
    const before = fake.calls.length
    await p.run({ ...base().input, model: 'claude-haiku-4-5' })
    delete process.env.ANTHROPIC_BASE_URL
    const body = fake.calls[before].body
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
    expect(body.fallbacks).toBeUndefined()
  })
})

describe('mensagens de erro', () => {
  it('traduz e mascara chaves', () => {
    expect(friendlyError({ status: 429 }, 'Grok')).toContain('Limite de uso')
    expect(friendlyError({ code: 'ECONNREFUSED' }, 'Ollama')).toContain('não está respondendo')
    expect(friendlyError({ message: 'bad key xai-1234567890abcdef' }, 'Grok')).not.toContain('1234567890')
  })
})
