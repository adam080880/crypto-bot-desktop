import { BrainCircuit, Database, ShieldAlert, Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/stores/appStore'
import { KillSwitch } from './KillSwitch'
import { LiveBadge } from './LiveBadge'

export function Header() {
  const status = useAppStore((s) => s.status)
  const conn = status?.connection ?? 'unknown'
  const sync = status?.sync

  return (
    <header className="drag flex h-12 shrink-0 items-center gap-3 border-b px-4 pl-20">
      <span className="text-sm font-semibold tracking-tight">SMC Assistant</span>
      <div className="ml-4 flex items-center gap-2">
        <Badge variant={conn === 'connected' ? 'bull' : conn === 'disconnected' ? 'bear' : 'outline'}>
          {conn === 'disconnected' ? <WifiOff /> : <Wifi />}
          {conn === 'connected' ? 'Terhubung' : conn === 'disconnected' ? 'Terputus' : 'Belum terhubung'}
        </Badge>
        <LiveBadge live={status?.live} />
        <Badge variant={sync?.status === 'error' ? 'bear' : sync?.status === 'syncing' ? 'warn' : 'outline'}>
          <Database />
          Sync: {sync?.status ?? '—'}
          <span className="num">
            {sync?.upToDate ?? 0}/{sync?.total ?? 0}
          </span>
        </Badge>
        {status?.claude?.running && (
          <Badge variant="secondary">
            <BrainCircuit className="animate-pulse" /> Claude menganalisa…
          </Badge>
        )}
        {status?.news?.window && (
          <Badge variant="warn" title="Bot tidak membuka posisi baru selama news window">
            <ShieldAlert /> News: {status.news.window.title}
          </Badge>
        )}
        <Badge variant="warn" className="uppercase">
          {status?.mode ?? 'paper'}
        </Badge>
      </div>
      <div className="ml-auto">
        <KillSwitch />
      </div>
    </header>
  )
}
