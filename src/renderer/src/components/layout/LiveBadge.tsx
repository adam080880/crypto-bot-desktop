import { Radio } from 'lucide-react'
import type { LiveState } from '@shared/live'
import { Badge } from '@/components/ui/badge'

const LABEL: Record<LiveState['status'], string> = {
  off: 'Live off',
  connecting: 'Menghubungkan…',
  connected: 'Live',
  reconnecting: 'Reconnecting…',
  delayed: 'Delayed'
}

export function LiveBadge({ live, className }: { live: LiveState | undefined; className?: string }) {
  const s = live?.status ?? 'off'
  const variant = s === 'connected' ? 'bull' : s === 'off' ? 'outline' : s === 'delayed' ? 'warn' : 'bear'
  return (
    <Badge variant={variant} className={className} title={live?.latencyMs != null ? `latency ~${live.latencyMs} ms` : undefined}>
      <Radio className={s === 'connected' ? 'animate-pulse' : ''} />
      {LABEL[s]}
      {live && live.streams > 0 && <span className="num opacity-70">{live.streams}</span>}
    </Badge>
  )
}
