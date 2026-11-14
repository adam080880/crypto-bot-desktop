import { useEffect, useMemo, useState } from 'react'
import { Play, RefreshCw, RotateCcw, Square } from 'lucide-react'
import { rotationConfigSchema, type RotationConfig, type RotationState } from '@shared/rotation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn, formatTime } from '@/lib/utils'

const WEEKDAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
const pct = (x: number, d = 1): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`
const sign = (x: number): string => (x > 0 ? 'text-bull' : x < 0 ? 'text-bear' : '')
const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const day = (t: number): string => new Date(t).toISOString().slice(0, 10)

/** Paper equity vs BTC, both rebased to 1 at the start. */
function Curve({ curve }: { curve: RotationState['curve'] }) {
  if (curve.length < 2) return <p className="text-xs text-muted-foreground">Kurva muncul setelah ada 2 close harian.</p>
  const e0 = curve[0]!.equity
  const b0 = curve.find((c) => c.btc)?.btc ?? null
  const ys = curve.flatMap((c) => [c.equity / e0, ...(b0 && c.btc ? [c.btc / b0] : [])])
  const lo = Math.min(...ys)
  const hi = Math.max(...ys)
  const W = 600
  const H = 160
  const x = (i: number): number => (i / (curve.length - 1)) * W
  const y = (v: number): number => H - ((v - lo) / (hi - lo || 1)) * H
  const line = (f: (c: RotationState['curve'][number]) => number | null): string =>
    curve
      .map((c, i) => [i, f(c)] as const)
      .filter(([, v]) => v !== null)
      .map(([i, v]) => `${x(i).toFixed(1)},${y(v!).toFixed(1)}`)
      .join(' ')
  return (
    <div className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none">
        <line x1="0" x2={W} y1={y(1)} y2={y(1)} className="stroke-border" strokeDasharray="4 4" />
        {b0 && <polyline points={line((c) => (c.btc ? c.btc / b0 : null))} fill="none" className="stroke-muted-foreground" strokeWidth="1.5" />}
        <polyline points={line((c) => c.equity / e0)} fill="none" className="stroke-primary" strokeWidth="2" />
      </svg>
      <p className="text-xs text-muted-foreground">
        <span className="text-primary">━</span> equity paper · <span>━</span> BTC (buy & hold), sama-sama mulai dari 1 · {day(curve[0]!.t)} → {day(curve.at(-1)!.t)}
      </p>
    </div>
  )
}

export function Rotation() {
  const [st, setSt] = useState<RotationState | null>(null)
  const [form, setForm] = useState<RotationConfig>(() => rotationConfigSchema.parse({}))
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void window.api.invoke('rotation:get').then((s) => {
      setSt(s)
      if (s) setForm(s.config)
    })
    return window.api.on('rotation:state', setSt)
  }, [])

  const cmd = async (c: Parameters<typeof window.api.invoke<'rotation:command'>>[1]): Promise<void> => {
    setErr(null)
    try {
      await window.api.invoke('rotation:command', c)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const held = useMemo(() => new Map((st?.positions ?? []).map((p) => [p.symbol, p])), [st])
  const ret = st && st.startedAt ? st.equity / st.config.startEquity - 1 : null
  const btcRet = st && st.curve.length > 1 && st.curve[0]!.btc && st.curve.at(-1)!.btc ? st.curve.at(-1)!.btc! / st.curve[0]!.btc! - 1 : null
  const rows = st?.ranking?.rows ?? []
  const n = Math.min(form.perSide, Math.floor(rows.length / (form.longShort ? 2 : 1)))

  const num = (k: keyof RotationConfig, label: string, step = 1) => (
    <>
      <Label htmlFor={`rot-${k}`}>{label}</Label>
      <Input
        id={`rot-${k}`}
        type="number"
        step={step}
        disabled={st?.running}
        className="num text-right"
        value={form[k] as number}
        onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
      />
    </>
  )

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Rotasi momentum</h1>
        <Badge variant="outline">PAPER, tanpa order</Badge>
        {st?.running ? <Badge variant="bull">forward test jalan sejak {formatTime(st.startedAt)}</Badge> : <Badge variant="outline">berhenti</Badge>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void cmd({ cmd: 'refresh' })}>
            <RefreshCw className="size-4" /> Hitung ranking
          </Button>
          {st?.running ? (
            <Button size="sm" variant="outline" onClick={() => void cmd({ cmd: 'stop' })}>
              <Square className="size-4" /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                const p = rotationConfigSchema.safeParse(form)
                if (!p.success) return setErr(p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
                void cmd({ cmd: 'start', config: p.data })
              }}
            >
              <Play className="size-4" /> Mulai forward test
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={st?.running} onClick={() => void cmd({ cmd: 'reset' })} title="Hapus hasil paper (setting tetap)">
            <RotateCcw className="size-4" /> Reset
          </Button>
        </div>
      </div>
      {(err || st?.lastError) && <p className="text-xs text-bear">{err ?? st?.lastError}</p>}

      <Card className="border-warn/50">
        <CardContent className="space-y-1 pt-4 text-xs text-muted-foreground">
          <p>
            <b className="text-foreground">Kenapa cuma paper:</b> di lab (778 koin termasuk yang delisting, Sep 2024 – Okt 2026, universe top 60 per minggu,
            fee + funding), long/short lookback 60–75 hari bagus di in-sample tapi out-of-sample tergantung hari rebalance (contoh L60 N5: Selasa +79%,
            Jumat −31%). Drawdown 35–60% tanpa leverage. Stop per posisi malah memperburuk. Halaman ini mencatat hasilnya ke depan supaya kelihatan apakah
            efeknya hidup, tanpa uang.
          </p>
          <p>
            Cara kerja: tiap {WEEKDAYS[form.rebalanceWeekday]} 00:30 UTC, dari close harian kemarin, ambil {form.universe} koin crypto paling ramai (volume 30
            hari, umur ≥ {form.minAgeDays} hari), urutkan return {form.lookbackDays} hari, long {form.perSide} terkuat
            {form.longShort ? ` + short ${form.perSide} terlemah (½ modal per sisi)` : ' (modal penuh)'}, bobot sama. Posisi dinilai tiap close harian, fee{' '}
            {form.costPct}% per sisi, funding dari data yang tersimpan.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader>
            <CardTitle>Equity paper</CardTitle>
            <CardDescription>
              {st?.startedAt ? (
                <>
                  {st.equity.toFixed(2)} USDT (modal {st.config.startEquity}) ·{' '}
                  <span className={sign(ret ?? 0)}>{ret !== null ? pct(ret) : '—'}</span> · BTC{' '}
                  <span className={sign(btcRet ?? 0)}>{btcRet !== null ? pct(btcRet) : '—'}</span> · max drawdown {st.maxDdPct.toFixed(1)}% · rebalance
                  berikutnya {st.nextRebalanceAt ? formatTime(st.nextRebalanceAt) : '—'}
                </>
              ) : (
                'Belum jalan. Atur parameter di kanan, lalu "Mulai forward test".'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Curve curve={st?.curve ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Parameter</CardTitle>
            <CardDescription>Dikunci selama forward test jalan (Stop dulu untuk ganti; mulai lagi = hasil baru).</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-[1fr_96px] items-center gap-2 text-sm">
            {num('lookbackDays', 'Lookback (hari)')}
            {num('perSide', 'Koin per sisi')}
            {num('universe', 'Universe (top volume)')}
            {num('minAgeDays', 'Umur listing min (hari)')}
            {num('startEquity', 'Modal paper (USDT)')}
            {num('costPct', 'Fee + slippage per sisi (%)', 0.01)}
            <Label htmlFor="rot-day">Hari rebalance</Label>
            <select
              id="rot-day"
              disabled={st?.running}
              className="h-9 rounded-md border bg-background px-2"
              value={form.rebalanceWeekday}
              onChange={(e) => setForm({ ...form, rebalanceWeekday: Number(e.target.value) })}
            >
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </select>
            <Label htmlFor="rot-ls">Long + short</Label>
            <input id="rot-ls" type="checkbox" className="justify-self-end" disabled={st?.running} checked={form.longShort} onChange={(e) => setForm({ ...form, longShort: e.target.checked })} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Posisi paper</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {st?.positions.length ? (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1">Koin</th>
                    <th>Sisi</th>
                    <th className="text-right">Entry</th>
                    <th className="text-right">Close</th>
                    <th className="text-right">PnL %</th>
                    <th className="text-right">Funding</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {[...st.positions]
                    .sort((a, b) => b.qty * b.lastPrice - a.qty * a.lastPrice)
                    .map((p) => {
                      const r = ((p.lastPrice - p.entryPrice) / p.entryPrice) * (p.qty > 0 ? 1 : -1)
                      return (
                        <tr key={p.symbol} className="border-t">
                          <td className="py-1">{p.symbol}</td>
                          <td className={p.qty > 0 ? 'text-bull' : 'text-bear'}>{p.side}</td>
                          <td className="text-right">{px(p.entryPrice)}</td>
                          <td className="text-right">{px(p.lastPrice)}</td>
                          <td className={cn('text-right', sign(r))}>{pct(r)}</td>
                          <td className={cn('text-right', sign(p.funding))}>{p.funding.toFixed(2)}</td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-muted-foreground">Belum ada posisi.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ranking terakhir</CardTitle>
            <CardDescription>
              {st?.ranking ? `Close ${day(st.ranking.t)} · ${rows.length} koin di universe` : 'Klik "Hitung ranking" (butuh candle 1d semua koin di DB).'}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1">#</th>
                  <th>Koin</th>
                  <th className="text-right">Return {st?.config.lookbackDays ?? form.lookbackDays}h</th>
                  <th className="text-right">Volume 30h</th>
                  <th />
                </tr>
              </thead>
              <tbody className="num">
                {rows.map((r, i) => {
                  const pick = i < n ? 'long' : form.longShort && i >= rows.length - n ? 'short' : null
                  return (
                    <tr key={r.symbol} className={cn('border-t', pick && 'bg-accent/40')}>
                      <td className="py-1 text-muted-foreground">{i + 1}</td>
                      <td>{r.symbol}</td>
                      <td className={cn('text-right', sign(r.ret))}>{pct(r.ret)}</td>
                      <td className="text-right">{(r.volume / 1e6).toFixed(0)}M</td>
                      <td className="text-right">
                        {pick && <span className={pick === 'long' ? 'text-bull' : 'text-bear'}>{pick}</span>}
                        {held.has(r.symbol) && <span className="ml-1 text-muted-foreground">(dipegang)</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Riwayat rebalance</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {st?.rebalances.length ? (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1">Close</th>
                  <th className="text-right">Equity</th>
                  <th className="text-right">Turnover</th>
                  <th className="text-right">Biaya</th>
                  <th className="pl-3">Long</th>
                  <th>Short</th>
                </tr>
              </thead>
              <tbody>
                {[...st.rebalances].reverse().map((r) => (
                  <tr key={r.t} className="border-t align-top">
                    <td className="num py-1">{day(r.t)}</td>
                    <td className="num text-right">{r.equity.toFixed(2)}</td>
                    <td className="num text-right">{(r.turnover * 100).toFixed(0)}%</td>
                    <td className="num text-right">{r.cost.toFixed(2)}</td>
                    <td className="pl-3 text-bull">{r.longs.join(', ')}</td>
                    <td className="text-bear">{r.shorts.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted-foreground">Belum ada rebalance.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
