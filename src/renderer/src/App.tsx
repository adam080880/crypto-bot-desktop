import { useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Sidebar } from '@/components/layout/Sidebar'
import { Chart } from '@/pages/Chart'
import { Dashboard } from '@/pages/Dashboard'
import { DataSync } from '@/pages/DataSync'
import { useSyncStore } from '@/stores/syncStore'
import { Placeholder } from '@/pages/Placeholder'
import { Settings } from '@/pages/Settings'
import { useAppStore } from '@/stores/appStore'

export function App() {
  const page = useAppStore((s) => s.page)
  const init = useAppStore((s) => s.init)
  const initSync = useSyncStore((s) => s.init)
  useEffect(() => init(), [init])
  useEffect(() => initSync(), [initSync])

  return (
    <div className="flex h-screen flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-auto p-6">
          {page === 'dashboard' && <Dashboard />}
          {page === 'chart' && <Chart />}
          {page === 'calendar' && <Placeholder title="Economic Calendar" phase="Fase 5" />}
          {page === 'analyses' && <Placeholder title="Claude Analyses" phase="Fase 6" />}
          {page === 'sync' && <DataSync />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  )
}
