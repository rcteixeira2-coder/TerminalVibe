#!/usr/bin/env node
// TUI falsa do Claude para os testes do rodapé de modelo: desenha o prompt como o Claude 2.1 ("❯ " com o
// cursor na coluna 2 e o texto de exemplo depois dele) e grava cada linha enviada em $HOME/fake-tui.log.
// (O Cockpit só repassa algumas variáveis às sessões; o HOME do teste é uma pasta temporária.)
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const log = process.env.HOME ? join(process.env.HOME, 'fake-tui.log') : null
// Argumentos de cada início (o teste do Auto confere o --resume) num arquivo à parte.
if (process.env.HOME) appendFileSync(join(process.env.HOME, 'fake-tui-args.log'), `${process.argv.slice(2).join(' ')}\n`)
const PROMPT = '❯ '
let line = ''

const prompt = () => {
  // Texto de exemplo apagado depois do cursor, como no Claude real.
  process.stdout.write(`\r\x1b[K${PROMPT}\x1b7\x1b[2mTry "how do I log an error?"\x1b[22m\x1b8`)
}

process.stdout.write('Claude falso (testes do Cockpit)\r\n\r\n')
prompt()
// O painel nasce estreito e é ajustado depois: redesenha a linha do prompt, como o Claude real.
process.stdout.on('resize', () => (line ? process.stdout.write(`\r\x1b[K${PROMPT}${line}`) : prompt()))
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
// Sequências de escape que o terminal envia (respostas de consulta, foco) não são texto digitado.
const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g
process.stdin.on('data', (d) => {
  for (const ch of d.replace(ESCAPES, '')) {
    if (ch === '\r') {
      if (log) appendFileSync(log, `${line}\n`)
      process.stdout.write(`\r\x1b[K${PROMPT}${line}\r\n  ⎿ ok\r\n`)
      line = ''
      prompt()
    } else if (ch === '\x7f') {
      if (line) {
        line = line.slice(0, -1)
        process.stdout.write(line ? `\r\x1b[K${PROMPT}${line}` : '')
        if (!line) prompt()
      }
    } else if (ch === '\x03') {
      process.exit(0)
    } else if (ch >= ' ') {
      if (!line) process.stdout.write('\x1b[K')
      line += ch
      process.stdout.write(ch)
    }
  }
})
