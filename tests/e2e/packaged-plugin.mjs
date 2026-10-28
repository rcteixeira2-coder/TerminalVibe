// M4: o plugin de hooks DENTRO do app instalado é carregado pelo claude real e chega a um socket.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const pluginDir = join(homedir(), 'Applications/Cockpit.app/Contents/Resources/app.asar.unpacked/resources/claude-plugin')
const sock = join(mkdtempSync(join(tmpdir(), 'ck-')), 'h.sock')
const token = randomUUID().replace(/-/g, '')
const pane = randomUUID()
const got = []
const server = createServer((c) => {
  const chunks = []
  c.on('data', (d) => {
    chunks.push(d)
    const buf = Buffer.concat(chunks)
    const nl = buf.indexOf(10)
    if (nl < 0) return
    const [tok, p, n] = buf.subarray(0, nl).toString().split(' ')
    if (buf.length >= nl + 1 + Number(n)) {
      const body = JSON.parse(buf.subarray(nl + 1).toString())
      got.push({ tokenOk: tok === token, paneOk: p === pane, event: body.hook_event_name })
      c.end()
    }
  })
}).listen(sock)
const env = { HOME: homedir(), USER: process.env.USER, LOGNAME: process.env.USER, PATH: `${homedir()}/.local/bin:/usr/bin:/bin`, COCKPIT_PANE_ID: pane, COCKPIT_TOKEN: token, COCKPIT_SOCK: sock, TMPDIR: tmpdir() }
const child = spawn(join(homedir(), '.local/bin/claude'), ['-p', 'Responda apenas: ok', '--model', 'haiku', '--plugin-dir', pluginDir], { env, cwd: process.cwd() })
let out = ''
child.stdout.on('data', (d) => (out += d))
await new Promise((r) => child.on('exit', r))
await new Promise((r) => setTimeout(r, 1500))
server.close()
console.log(JSON.stringify({ M4: { pluginExists: existsSync(join(pluginDir, 'hooks/hooks.json')), answer: out.trim().slice(0, 40), hooks: got } }))
