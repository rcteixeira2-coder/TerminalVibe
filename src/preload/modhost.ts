import { contextBridge, ipcRenderer } from 'electron'

// Só para o host oculto de mods (mod://__host). Os mods em si ficam em iframes sem acesso a isto.
contextBridge.exposeInMainWorld('cockpitHost', {
  call: (modId: string, method: string, args: unknown[]) => ipcRenderer.invoke('modhost:call', modId, method, args),
  onMods: (cb: (mods: { id: string; main: string }[]) => void) => ipcRenderer.on('modhost:mods', (_e, mods) => cb(mods)),
  onEvent: (cb: (modId: string, type: string, args: unknown[]) => void) =>
    ipcRenderer.on('modhost:event', (_e, modId, type, args) => cb(modId, type, args)),
  ready: () => ipcRenderer.send('modhost:ready'),
  onPing: (cb: () => void) => ipcRenderer.on('modhost:ping', () => cb()),
  pong: () => ipcRenderer.send('modhost:pong'),
})
