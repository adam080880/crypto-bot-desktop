import { create } from 'zustand'
import type { AppStatus } from '@shared/ipc'

export type PageId = 'dashboard' | 'chart' | 'screener' | 'backtest' | 'bot' | 'calendar' | 'analyses' | 'sync' | 'settings'

interface AppStore {
  page: PageId
  status: AppStatus | null
  setPage: (page: PageId) => void
  setStatus: (status: AppStatus) => void
  init: () => () => void
}

export const useAppStore = create<AppStore>((set) => ({
  page: 'dashboard',
  status: null,
  setPage: (page) => set({ page }),
  setStatus: (status) => set({ status }),
  init: () => {
    void window.api.invoke('app:getStatus').then((status) => set({ status }))
    return window.api.on('app:status', (status) => set({ status }))
  }
}))
