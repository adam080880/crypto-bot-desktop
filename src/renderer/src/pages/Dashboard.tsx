import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bull' | 'bear' }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`num text-2xl ${tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : ''}`}>{value}</div>
      </CardContent>
    </Card>
  )
}

export function Dashboard() {
  const status = useAppStore((s) => s.status)
  const halted = status?.killSwitch.active
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
      <div className="grid grid-cols-4 gap-4">
        <Stat label="Mode" value={(status?.mode ?? 'paper').toUpperCase()} />
        <Stat label="Bot" value={halted ? 'HALTED' : 'IDLE'} tone={halted ? 'bear' : undefined} />
        <Stat label="Posisi terbuka" value="0" />
        <Stat label="PnL hari ini" value="0.00" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Sistem</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          <div>
            Database: <span className="num selectable text-foreground">{status?.dbPath ?? '—'}</span>
          </div>
          <div>
            Versi: <span className="num text-foreground">{status?.version ?? '—'}</span>
          </div>
          {halted && (
            <div>
              Kill switch aktif sejak <span className="num text-bear">{formatTime(status?.killSwitch.at ?? null)}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
