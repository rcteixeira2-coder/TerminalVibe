// M3: página local (preview://) não fala com a internet nem lê .env; arquivos normais do projeto funcionam.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openProject, waitFor, sleep } from './lib.mjs'

const fixture = join(mkdtempSync(join(tmpdir(), 'cockpit-fx-')), 'Site Local')
mkdirSync(join(fixture, 'src'), { recursive: true })
writeFileSync(join(fixture, '.env'), 'SEGREDO=nao-pode-vazar')
writeFileSync(join(fixture, 'src', 'dados.json'), '{"ok":true}')
writeFileSync(join(fixture, 'index.html'), `<!doctype html><meta charset="utf-8"><body><script>
(async () => {
  const r = {}
  const t = async (k, u) => { try { const x = await fetch(u); r[k] = x.ok ? 'PASSOU' : 'http ' + x.status } catch (e) { r[k] = 'bloqueado' } }
  await t('externo', 'https://example.com/')
  await t('dotenv', '.env')
  await t('json', 'src/dados.json')
  r.img = await new Promise((res) => { const i = new Image(); i.onload = () => res('PASSOU'); i.onerror = () => res('bloqueado'); i.src = 'https://www.google.com/favicon.ico?' + Date.now() })
  document.title = 'RES:' + JSON.stringify(r)
})()
</script>`)
const { app, page, close } = await launch({ store: { added: [fixture], meta: { [fixture]: { favorite: true } } } })
await openProject(page, 'Site Local')
await page.evaluate((p) => window.cockpit.invoke('browser:open', p, `${p}/index.html`), fixture)
const title = await waitFor(async () => {
  const t = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('mod://'))
    const v = w.contentView.children[w.contentView.children.length - 1]
    return v?.webContents?.getTitle() ?? ''
  })
  return t.startsWith('RES:') ? t : null
}, { timeout: 20000, label: 'resultado da página' })
console.log(JSON.stringify({ M3: JSON.parse(title.slice(4)) }))
await close()
