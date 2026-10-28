// Regressão: fechar a janela (botão vermelho) em tela cheia deixava o espaço preto e a janela não sumia.
import { launch, sleep } from './lib.mjs'

const { app, close } = await launch()
const fs = (on) => app.evaluate(({ BrowserWindow }, on) => BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('mod://')).setFullScreen(on), on)
const state = () => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('mod://'))
  return { visible: w.isVisible(), fullscreen: w.isFullScreen() }
})
await sleep(1500)
await fs(true)
for (let i = 0; i < 40 && !(await state()).fullscreen; i++) await sleep(250)
await sleep(1000)
const before = await state()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('mod://')).close())
await sleep(3000)
const after = await state()
// Reabrir (clique no Dock) volta em tela cheia.
await app.evaluate(({ app: a }) => a.emit('activate'))
await sleep(3000)
const reopened = await state()
await fs(false)
await sleep(2000)
await close()
console.log(JSON.stringify({ before, after, reopened }))
