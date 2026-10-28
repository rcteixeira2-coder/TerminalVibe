// Gera build/icon.png (1024×1024) renderizando o desenho abaixo no próprio Electron.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const html = `<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent">
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2e45"/><stop offset="1" stop-color="#141521"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff9e64"/><stop offset="1" stop-color="#e07a5f"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="6"/>
  <!-- painéis do cockpit -->
  <rect x="190" y="230" width="300" height="250" rx="34" fill="#1f2133" stroke="#7aa2f7" stroke-width="10"/>
  <rect x="534" y="230" width="300" height="250" rx="34" fill="#1f2133" stroke="#9ece6a" stroke-width="10"/>
  <rect x="190" y="524" width="644" height="300" rx="40" fill="#1f2133" stroke="url(#glow)" stroke-width="12"/>
  <!-- prompt -->
  <path d="M262 610 L340 674 L262 738" fill="none" stroke="url(#glow)" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="380" y="712" width="190" height="34" rx="17" fill="url(#glow)"/>
  <!-- luzes de status -->
  <circle cx="255" cy="296" r="22" fill="#7aa2f7"/>
  <rect x="300" y="284" width="140" height="24" rx="12" fill="#7aa2f7" fill-opacity=".45"/>
  <rect x="235" y="350" width="205" height="20" rx="10" fill="#ffffff" fill-opacity=".14"/>
  <rect x="235" y="398" width="150" height="20" rx="10" fill="#ffffff" fill-opacity=".14"/>
  <circle cx="599" cy="296" r="22" fill="#9ece6a"/>
  <rect x="644" y="284" width="140" height="24" rx="12" fill="#9ece6a" fill-opacity=".45"/>
  <rect x="579" y="350" width="205" height="20" rx="10" fill="#ffffff" fill-opacity=".14"/>
  <rect x="579" y="398" width="110" height="20" rx="10" fill="#ffffff" fill-opacity=".14"/>
  <circle cx="770" cy="590" r="26" fill="#ff9e64"/>
</svg></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG())
  app.exit(0)
})
