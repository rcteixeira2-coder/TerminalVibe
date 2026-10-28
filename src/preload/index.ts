import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EventChannel, InvokeApi, InvokeChannel, MainEvents, SendApi, SendChannel } from '@shared/ipc'
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from '@shared/ipc'

const invokeSet = new Set<string>(INVOKE_CHANNELS)
const sendSet = new Set<string>(SEND_CHANNELS)
const eventSet = new Set<string>(EVENT_CHANNELS)

const api = {
  invoke<K extends InvokeChannel>(channel: K, ...args: Parameters<InvokeApi[K]>): Promise<Awaited<ReturnType<InvokeApi[K]>>> {
    if (!invokeSet.has(channel)) return Promise.reject(new Error(`canal desconhecido: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  send<K extends SendChannel>(channel: K, ...args: Parameters<SendApi[K]>): void {
    if (sendSet.has(channel)) ipcRenderer.send(channel, ...args)
  },
  on<K extends EventChannel>(channel: K, listener: MainEvents[K]): () => void {
    if (!eventSet.has(channel)) return () => {}
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => (listener as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  // Caminho real de um arquivo arrastado para o terminal.
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
}

export type CockpitApi = typeof api

contextBridge.exposeInMainWorld('cockpit', api)
