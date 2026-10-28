import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchError, fetchRemote, gitEnv, localStatus, parsePorcelain, parseRemote, safeBranch } from '../../src/main/git'

const env = gitEnv(process.env.PATH ?? '/usr/bin:/bin', homedir())
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-git-')))
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...env, LC_ALL: 'C' } }).toString()

function commit(dir: string, file: string, text: string, msg: string): void {
  writeFileSync(join(dir, file), text)
  g(dir, 'add', '.')
  g(dir, 'commit', '-q', '-m', msg)
}

// remote bare + clone "aqui" + clone "outro" (que empurra mudanças para o remote).
const bare = join(base, 'remote.git')
g(base, 'init', '-q', '--bare', bare)
const here = join(base, 'Projeto Aqui')
g(base, 'clone', '-q', bare, here)
commit(here, 'a.txt', '1', 'primeiro')
g(here, 'push', '-q', '-u', 'origin', 'main')
const other = join(base, 'outro')
g(base, 'clone', '-q', bare, other)

describe('git: estado local', () => {
  it('em dia', async () => {
    const st = await localStatus(here, env)
    expect(st).toMatchObject({ kind: 'remote', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changed: 0, untracked: 0 })
  })

  it('↓ commits novos no remote (depois do fetch), ↑ commit local e ● arquivos', async () => {
    commit(other, 'b.txt', '2', 'mudança no GitHub')
    g(other, 'push', '-q')
    commit(here, 'c.txt', '3', 'mudança local')
    writeFileSync(join(here, 'a.txt'), 'alterado')
    writeFileSync(join(here, 'novo arquivo.txt'), 'x')
    expect((await localStatus(here, env)).behind).toBe(0)
    expect(await fetchRemote(here, env)).toBeNull()
    const st = await localStatus(here, env)
    expect(st).toMatchObject({ ahead: 1, behind: 1, changed: 1, untracked: 1 })
    expect(st.incoming.map((c) => c.subject)).toEqual(['mudança no GitHub'])
    expect(st.outgoing.map((c) => c.subject)).toEqual(['mudança local'])
    expect(st.files).toEqual(expect.arrayContaining(['a.txt', 'novo arquivo.txt']))
  })

  it('branch sem upstream', async () => {
    const dir = join(base, 'branch')
    g(base, 'clone', '-q', bare, dir)
    g(dir, 'checkout', '-q', '-b', 'feature/x')
    const st = await localStatus(dir, env)
    expect(st.branch).toBe('feature/x')
    expect(st.upstream).toBeUndefined()
  })

  it('pasta sem git, subpasta de outro repo e git sem remote', async () => {
    const plain = join(base, 'sem-git')
    mkdirSync(plain)
    expect((await localStatus(plain, env)).kind).toBe('none')
    const sub = join(here, 'sub')
    mkdirSync(sub)
    expect((await localStatus(sub, env)).kind).toBe('none')
    const local = join(base, 'local')
    mkdirSync(local)
    g(local, 'init', '-q')
    writeFileSync(join(local, 'x'), '1')
    expect(await localStatus(local, env)).toMatchObject({ kind: 'local', untracked: 1 })
  })

  it('remote inexistente vira mensagem curta', async () => {
    const dir = join(base, 'quebrado')
    g(base, 'clone', '-q', bare, dir)
    g(dir, 'remote', 'set-url', 'origin', join(base, 'nao-existe.git'))
    expect(await fetchRemote(dir, env)).toBeTruthy()
  })
})

describe('git: parsers', () => {
  it('porcelain v2 com renomeação e conflito', () => {
    const raw = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 a b src/x y.ts', '2 R. N... 100644 100644 100644 a b R100 novo.ts', 'velho.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflito.ts', '? solto.md', ''].join('\0')
    expect(parsePorcelain(raw)).toEqual({
      branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, changed: 3, untracked: 1,
      files: ['src/x y.ts', 'novo.ts', 'conflito.ts', 'solto.md'],
    })
  })

  it('URL do remote sem credenciais', () => {
    expect(parseRemote('https://ghp_SEGREDO@github.com/rcteixeira2-coder/monitort.git')).toEqual({ repo: 'rcteixeira2-coder/monitort', webUrl: 'https://github.com/rcteixeira2-coder/monitort' })
    expect(parseRemote('git@github.com:rt-developerteam/finart-v2.git')).toEqual({ repo: 'rt-developerteam/finart-v2', webUrl: 'https://github.com/rt-developerteam/finart-v2' })
    expect(parseRemote('/caminho/local/remote.git')).toBeNull()
    expect(JSON.stringify(parseRemote('https://user:senha@github.com/a/b'))).not.toContain('senha')
  })

  it('erros e nomes de branch', () => {
    expect(fetchError('fatal: unable to access: Could not resolve host: github.com')).toMatch(/internet/)
    expect(fetchError('remote: Repository not found.')).toMatch(/não encontrado/)
    expect(safeBranch('feature/importacao-historico-notas-20261020')).toBe(true)
    expect(safeBranch('x; rm -rf ~')).toBe(false)
    expect(safeBranch('-x')).toBe(false)
  })
})
