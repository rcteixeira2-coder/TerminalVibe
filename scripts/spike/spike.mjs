// Spike M0: roda o Claude num pty, responde às consultas do terminal e registra OSC 7501 + hooks.
import pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const log = join(here, 'hooks.log')
if (existsSync(log)) rmSync(log)
const paneId = randomUUID()
const sessionId = randomUUID()
const env = {
  HOME: process.env.HOME, USER: process.env.USER, LANG: 'pt_BR.UTF-8', TMPDIR: process.env.TMPDIR,
  PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.local/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Cockpit', TERM_PROGRAM_VERSION: '0.1.0',
  COCKPIT_PANE_ID: paneId, COCKPIT_SPIKE_LOG: log, SHELL: '/bin/zsh',
}
const args = ['--session-id', sessionId, '--plugin-dir', join(here, 'plugin'), '--model', 'haiku']
const p = pty.spawn(`${process.env.HOME}/.local/bin/claude`, args, { cwd: join(here, '..', '..'), env, cols: 120, rows: 40 })
const queries = new Map()
const osc = []
let raw = ''
const replies = [
  [/\x1b\]7501;\?(\x07|\x1b\\)/g, '7501?', '\x1b]7501;?\x1b\\'],
  [/\x1b\[>0?q/g, 'XTVERSION', '\x1bP>|xterm.js(6.0.0)\x1b\\'],
  [/\x1b\[\?2026\$p/g, 'DECRQM2026', '\x1b[?2026;2$y'],
  [/\x1b\[\?1016\$p/g, 'DECRQM1016', '\x1b[?1016;0$y'],
  [/\x1b\[c/g, 'DA1', '\x1b[?1;2c'],
  [/\x1b\[6n/g, 'CPR', '\x1b[1;1R'],
  [/\x1b\[\?u/g, 'kittyKbd', null],
  [/\x1b\[16t/g, 'cellSize', null],
]
p.onData((d) => {
  raw += d
  for (const [re, name, reply] of replies) {
    const n = (d.match(re) || []).length
    if (n) { queries.set(name, (queries.get(name) || 0) + n); if (reply) for (let i = 0; i < n; i++) p.write(reply) }
  }
  for (const m of d.matchAll(/\x1b\]7501;([^\x07\x1b]*)(\x07|\x1b\\)/g)) {
    if (m[1] === '?') continue
    const fields = Object.fromEntries(m[1].split(':').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
    for (const k of ['title', 'msg']) if (fields[k]) fields[k] = Buffer.from(fields[k], 'base64').toString()
    osc.push({ t: Date.now(), ...fields })
  }
  for (const m of d.matchAll(/\x1b\](9|777|0|2);([^\x07\x1b]*)/g)) osc.push({ t: Date.now(), other: m[1], v: m[2].slice(0, 80) })
  if (d.includes('\x07') && !/\x1b\][^\x07]*\x07/.test(d)) osc.push({ t: Date.now(), bel: true })
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(6000)
p.write('responda apenas a palavra ok')
await sleep(500)
p.write('\r')
await sleep(25000)
p.write('/exit\r')
await sleep(3000)
try { p.kill() } catch {}
const modes = [...new Set([...raw.matchAll(/\x1b\[\?([\d;]+)[hl]/g)].map((m) => m[1]))]
const result = { sessionId, paneId, queries: Object.fromEntries(queries), modesSet: modes, osc, hooks: existsSync(log) ? readFileSync(log, 'utf8') : '(nenhum hook)' }
writeFileSync(join(here, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2).slice(0, 6000))
process.exit(0)
