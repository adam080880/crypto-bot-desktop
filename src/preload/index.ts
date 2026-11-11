import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, type PreloadApi } from '@shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

const api: PreloadApi = {
  invoke(channel, ...args) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel, listener) {
    if (!eventAllowed.has(channel)) throw new Error(`channel not allowed: ${channel}`)
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload as never)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('api', api)
