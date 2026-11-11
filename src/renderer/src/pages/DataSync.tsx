import { useEffect, useState } from 'react'
import { Calculator, FlaskConical, RefreshCw, Square, Rocket } from 'lucide-react'
import type { AutoSyncState, BackfillEstimate } from '@shared/sync'
import { useAppStore } from '@/stores/appStore'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { fmtBytes, fmtDuration, fmtInt } from '@/lib/format'
import { formatTime } from '@/lib/utils'
import { useSyncStore } from '@/stores/syncStore'

export function DataSync() {
  const ui = useSyncStore((s) => s.ui)
  const log = useSyncStore((s) => s.log)
  const [estimate, setEstimate] = useState<BackfillEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const running = ui?.running ?? false
  const header = useAppStore((st) => st.status)
  const [auto, setAuto] = useState<AutoSyncState | null>(null)
  useEffect(() => {
    void window.api.invoke('sync:autoState').then(setAuto)
  }, [header?.sync.status, header?.sync.upToDate, header?.sync.total])
  const p = ui?.progress
  const s = ui?.lastSummary

  useEffect(() => {
    if (s && !running) void runEstimate()
  }, [s?.finishedAt])

  async function runEstimate(): Promise<void> {
    setEstimating(true)
    setErr(null)
    try {
      setEstimate(await window.api.invoke('sync:estimate'))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setEstimating(false)
    }
  }

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Data Sync</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Auto-sync
            {auto?.enabled ? <Badge variant="bull">aktif</Badge> : <Badge variant="outline">mati</Badge>}
            {auto?.running && <Badge variant="warn">sedang sync</Badge>}
          </CardTitle>
          <CardDescription>
            Saat app dibuka, semua simbol yang sudah punya histori dikejar sampai sekarang. Setelah itu REST tiap
            interval (simbol live lewat WebSocket). Listing baru otomatis di-backfill setelah full backfill pertama selesai.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Progress value={auto && auto.total ? (auto.upToDate / auto.total) * 100 : 0} />
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>
              Up-to-date <span className="num text-foreground">{auto ? `${auto.upToDate}/${auto.total}` : '—'}</span>
            </span>
            <span>
              Terakhir <span className="num text-foreground">{formatTime(auto?.lastRunAt ?? null)}</span>
            </span>
            <span>
              Berikutnya <span className="num text-foreground">{formatTime(auto?.nextRunAt ?? null)}</span>
            </span>
            <span>
              Live{' '}
              <span className="num text-foreground">
                {header?.live.status ?? 'off'} · {header?.live.streams ?? 0} stream · {header?.live.connections ?? 0} koneksi
              </span>
            </span>
            <span>
              Full backfill <span className="num text-foreground">{auto?.fullBackfillDone ? 'sudah' : 'belum'}</span>
            </span>
          </div>
          {auto?.lastError && <div className="text-xs text-bear">{auto.lastError}</div>}
          <Button size="sm" variant="secondary" disabled={auto?.running || running} onClick={() => window.api.invoke('sync:now')}>
            <RefreshCw /> Sync sekarang
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backfill historis</CardTitle>
          <CardDescription>
            1m 6 bulan (data.binance.vision → REST untuk gap), 5m/15m/1h/4h di-resample dari 1m, 1d/1w 2 tahun.
            Resumable: kalau dihentikan, run berikutnya lanjut dari candle terakhir.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={running} onClick={() => window.api.invoke('sync:start', { mode: 'test' })}>
              <FlaskConical /> Tes 5 simbol
            </Button>
            <Button size="sm" variant="secondary" disabled={running || estimating} onClick={runEstimate}>
              <Calculator /> {estimating ? 'Menghitung…' : 'Estimasi full'}
            </Button>
            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <DialogTrigger asChild>
                <Button size="sm" disabled={running}>
                  <Rocket /> Full backfill
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Mulai full backfill?</DialogTitle>
                  <DialogDescription>
                    {estimate
                      ? `${estimate.activeSymbols} simbol, perkiraan DB ${fmtBytes(estimate.projectedDbBytes)}, download ${fmtBytes(estimate.projectedDownloadBytes)}, waktu ${fmtDuration(estimate.projectedSeconds != null ? estimate.projectedSeconds * 1000 : null)}.`
                      : 'Jalankan estimasi dulu supaya tahu ukuran dan waktunya.'}{' '}
                    Bisa dihentikan kapan saja dan dilanjutkan nanti.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Batal</Button>
                  </DialogClose>
                  <Button
                    onClick={() => {
                      void window.api.invoke('sync:start', { mode: 'all' })
                      setConfirmOpen(false)
                    }}
                  >
                    Mulai
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {running && (
              <Button size="sm" variant="outline" onClick={() => window.api.invoke('sync:cancel')}>
                <Square /> Hentikan
              </Button>
            )}
          </div>

          {running && (
            <div className="space-y-2">
              <Progress value={(p?.fraction ?? 0) * 100} />
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Simbol <span className="num text-foreground">{p ? `${p.completed}/${p.total}` : '…'}</span>
                </span>
                <span>
                  Sedang <span className="num text-foreground">{p ? `${p.symbol} ${p.timeframe} · ${p.step}` : 'menyiapkan'}</span>
                </span>
                <span>
                  Progres <span className="num text-foreground">{p ? `${(p.fraction * 100).toFixed(1)}%` : '—'}</span>
                </span>
                <span>
                  Download <span className="num text-foreground">{fmtBytes(p?.bytesDownloaded)}</span>
                </span>
                <span>
                  ETA <span className="num text-foreground">{fmtDuration(p?.etaMs)}</span>
                </span>
              </div>
            </div>
          )}
          {(ui?.lastError || err) && <div className="text-sm text-bear">{ui?.lastError ?? err}</div>}
        </CardContent>
      </Card>

      {s && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Run terakhir
              {s.aborted ? <Badge variant="warn">dihentikan</Badge> : s.errors.length ? <Badge variant="bear">{s.errors.length} error</Badge> : <Badge variant="bull">OK</Badge>}
            </CardTitle>
            <CardDescription>
              {formatTime(s.finishedAt)} · {fmtDuration(s.finishedAt - s.startedAt)} · {s.completed}/{s.symbols} simbol ·
              download {fmtBytes(s.bytesDownloaded)} · {s.restRequests} REST request
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 gap-2 text-xs">
              {Object.entries(s.rows).map(([tf, n]) => (
                <div key={tf} className="rounded-md border p-2">
                  <div className="text-muted-foreground">{tf}</div>
                  <div className="num">{fmtInt(n)}</div>
                </div>
              ))}
            </div>
            {s.errors.length > 0 && (
              <ul className="num selectable mt-3 space-y-1 text-xs text-bear">
                {s.errors.slice(0, 10).map((e) => (
                  <li key={e.symbol}>
                    {e.symbol}: {e.error}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {estimate && (
        <Card>
          <CardHeader>
            <CardTitle>Estimasi full backfill — {estimate.activeSymbols} simbol</CardTitle>
            <CardDescription>
              {estimate.measuredOn
                ? `Berdasarkan run ${estimate.measuredOn.symbols} simbol (${fmtInt(estimate.measuredOn.rows1m)} baris 1m dalam ${fmtDuration(estimate.measuredOn.seconds * 1000)}).`
                : 'Belum ada data pengukuran.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <table className="num w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1 text-left font-normal">TF</th>
                  <th className="py-1 text-right font-normal">bytes/baris</th>
                  <th className="py-1 text-right font-normal">baris sekarang</th>
                  <th className="py-1 text-right font-normal">baris (proyeksi)</th>
                  <th className="py-1 text-right font-normal">ukuran (proyeksi)</th>
                </tr>
              </thead>
              <tbody>
                {estimate.tables.map((t) => (
                  <tr key={t.timeframe} className="border-b border-border/50">
                    <td className="py-1">{t.timeframe}</td>
                    <td className="py-1 text-right">{t.bytesPerRow?.toFixed(1) ?? '~55'}</td>
                    <td className="py-1 text-right">{fmtInt(t.rows)}</td>
                    <td className="py-1 text-right">{fmtInt(t.projectedRows)}</td>
                    <td className="py-1 text-right">{fmtBytes(t.projectedBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">Total DB</div>
                <div className="num text-base">{fmtBytes(estimate.projectedDbBytes)}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">Download</div>
                <div className="num text-base">{fmtBytes(estimate.projectedDownloadBytes)}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">Waktu</div>
                <div className="num text-base">
                  {fmtDuration(estimate.projectedSeconds != null ? estimate.projectedSeconds * 1000 : null)}
                </div>
              </div>
            </div>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {estimate.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {log.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Log</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="num selectable max-h-48 overflow-auto text-xs text-muted-foreground">{log.join('\n')}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
