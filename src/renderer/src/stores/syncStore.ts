import { create } from 'zustand'
import type { SyncUiState } from '@shared/ipc'

interface SyncStore {
  ui: SyncUiState | null
  log: string[]
  init: () => () => void
}

export const useSyncStore = create<SyncStore>((set) => ({
  ui: null,
  log: [],
  init: () => {
    void window.api.invoke('sync:getState').then((ui) => set({ ui }))
    return window.api.on('sync:event', ({ event, ui }) => {
      set((s) => {
        let line: string | null = null
        if (event.type === 'start') line = `Mulai ${event.total} simbol`
        else if (event.type === 'symbol-done') line = `✓ ${event.symbol}`
        else if (event.type === 'symbol-error') line = `! ${event.symbol}: ${event.error}`
        else if (event.type === 'done') line = `Selesai (${event.summary.completed}/${event.summary.symbols})`
        else if (event.type === 'fatal') line = `Gagal: ${event.error}`
        return { ui, log: line ? [...s.log.slice(-199), line] : s.log }
      })
    })
  }
}))
