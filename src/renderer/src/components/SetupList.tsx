import type { Setup, SetupStatus } from '@shared/smc'
import { Badge } from '@/components/ui/badge'
import { formatTime } from '@/lib/utils'

const STATUS: Record<SetupStatus, { label: string; variant: 'bull' | 'bear' | 'warn' | 'outline' | 'secondary' }> = {
  pending: { label: 'pending', variant: 'warn' },
  triggered: { label: 'kena entry', variant: 'warn' },
  win: { label: 'TP', variant: 'bull' },
  loss: { label: 'SL', variant: 'bear' },
  invalid: { label: 'invalid', variant: 'outline' },
  expired: { label: 'expired', variant: 'secondary' },
  missed: { label: 'lewat TP', variant: 'secondary' }
}

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))

/** Candidate setups (never orders) for the chart symbol, newest first. */
export function SetupList({ setups }: { setups: Setup[] }) {
  const done = setups.filter((s) => s.status === 'win' || s.status === 'loss')
  const wins = done.filter((s) => s.status === 'win').length
  const rows = [...setups].reverse().slice(0, 8)
  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-xs">
        <span className="font-semibold">Kandidat setup (OB valid)</span>
        <span className="text-muted-foreground">bukan order otomatis</span>
        <span className="num ml-auto text-muted-foreground">
          {setups.length} setup · selesai {done.length} · TP {wins} / SL {done.length - wins}
          {done.length ? ` · winrate ${Math.round((wins / done.length) * 100)}%` : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">Belum ada setup di data yang dimuat.</div>
      ) : (
        <table className="num w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              {['waktu', 'arah', 'POI', 'entry', 'SL', 'TP', 'RR', 'skor', 'status'].map((h) => (
                <th key={h} className="px-3 py-1 text-left font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-border/50" title={s.reasons.join(' · ')}>
                <td className="px-3 py-1">{formatTime(s.createdT)}</td>
                <td className={`px-3 py-1 ${s.direction === 'bullish' ? 'text-bull' : 'text-bear'}`}>
                  {s.direction === 'bullish' ? 'LONG' : 'SHORT'}
                </td>
                <td className="px-3 py-1">
                  {s.poi.kind} {s.poi.timeframe}
                </td>
                <td className="px-3 py-1">{px(s.entry)}</td>
                <td className="px-3 py-1">{px(s.sl)}</td>
                <td className="px-3 py-1">{px(s.tp)}</td>
                <td className="px-3 py-1">{s.rr}</td>
                <td className="px-3 py-1">{s.score}</td>
                <td className="px-3 py-1">
                  <Badge variant={STATUS[s.status].variant}>{STATUS[s.status].label}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
