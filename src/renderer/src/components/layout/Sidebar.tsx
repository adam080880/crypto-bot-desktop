import { BrainCircuit, CalendarClock, CandlestickChart, DatabaseZap, LayoutDashboard, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore, type PageId } from '@/stores/appStore'

const items: { id: PageId; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'chart', label: 'Chart', icon: CandlestickChart },
  { id: 'calendar', label: 'Economic Calendar', icon: CalendarClock },
  { id: 'analyses', label: 'Claude Analyses', icon: BrainCircuit },
  { id: 'sync', label: 'Data Sync', icon: DatabaseZap },
  { id: 'settings', label: 'Settings', icon: Settings }
]

export function Sidebar() {
  const page = useAppStore((s) => s.page)
  const setPage = useAppStore((s) => s.setPage)
  return (
    <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r p-2">
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => setPage(id)}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            page === id && 'bg-accent text-foreground'
          )}
        >
          <Icon className="size-4" />
          {label}
        </button>
      ))}
    </nav>
  )
}
