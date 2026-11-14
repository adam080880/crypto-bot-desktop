import { useEffect, useMemo, useState } from 'react'
import { CandlestickChart, FlaskConical, Play } from 'lucide-react'
import type { BacktestResult, BreakdownKey, PeriodKey, TradeStats } from '@shared/backtest'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const pct = (x: number | null, d = 0): string => (x === null ? '—' : `${(x * 100).toFixed(d)}%`)
const num = (x: number | null, d = 2): string => (x === null ? '—' : x.toFixed(d))
const signCls = (x: number | null): string => (x === null ? '' : x > 0 ? 'text-bull' : x < 0 ? 'text-bear' : '')
const day = (t: number): string => new Date(t).toISOString().slice(0, 10)

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'is', label: 'In-sample' },
  { key: 'oos', label: 'Out-of-sample' }
]
const BREAKDOWNS: { key: BreakdownKey; label: string }[] = [
  { key: 'poiKind', label: 'Jenis POI' },
  { key: 'poiTf', label: 'TF POI' },
  { key: 'score', label: 'Skor' },
  { key: 'fvg', label: 'FVG' },
  { key: 'direction', label: 'Arah' }
]

interface Form {
  oosDays: number
  makerFeePct: number
  takerFeePct: number
  slippagePct: number
  startEquity: number
  riskPerTradePct: number
  reactionHours: number
}

const recall = (k: string, d: string): string => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const remember = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage unavailable */
  }
}

// keep the last result per symbol while the app runs (page switches unmount the component)
const cache = new Map<string, BacktestResult>()

export function Backtest() {
  const symbol = useMemo(() => recall('chart.symbol', 'BTCUSDT'), [])
  const [form, setForm] = useState<Form | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(cache.get(symbol) ?? null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [group, setGroup] = useState<BreakdownKey>('poiKind')

  useEffect(() => {
    void window.api.invoke('config:get').then((cfg) => {
      const saved = (() => {
        try {
          return JSON.parse(recall('backtest.form', '{}')) as Partial<Form>
        } catch {
          return {}
        }
      })()
      setForm({
        oosDays: 60,
        makerFeePct: 0.02,
        takerFeePct: 0.05,
        slippagePct: 0.02,
        startEquity: 10,
        reactionHours: 24,
        ...saved,
        riskPerTradePct: cfg.bot.riskPerTradePct
      })
    })
  }, [])

  const run = async (): Promise<void> => {
    if (!form) return
    setRunning(true)
    setError(null)
    remember('backtest.form', JSON.stringify({ ...form, riskPerTradePct: undefined }))
    try {
      const r = await window.api.invoke('backtest:run', { symbol, ...form })
      if (!r) setError(`Data ${symbol} belum cukup (butuh histori 15m/1h/4h).`)
      else {
        cache.set(symbol, r)
        setResult(r)
      }
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': /, ''))
    } finally {
      setRunning(false)
    }
  }

  const field = (k: keyof Form, label: string, step: number, suffix = '') =>
    form && (
      <label className="flex items-center gap-2">
        {label}
        <Input
          type="number"
          step={step}
          className="num h-7 w-20 text-right"
          value={form[k]}
          onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
        />
        {suffix}
      </label>
    )

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <FlaskConical className="size-5" />
        <h1 className="text-lg font-semibold">Backtest {symbol}</h1>
        <span className="text-xs text-muted-foreground">koin yang lagi dibuka di Chart · semua data tersimpan · detektor & config SMC yang sama dengan live</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => useAppStore.getState().setPage('chart')}>
          <CandlestickChart className="size-4" /> Ganti koin di Chart
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
            {field('oosDays', 'Out-of-sample', 1, 'hari terakhir')}
            {field('makerFeePct', 'Fee maker', 0.01, '%')}
            {field('takerFeePct', 'Fee taker', 0.01, '%')}
            {field('slippagePct', 'Slippage SL', 0.01, '%')}
            {field('startEquity', 'Modal awal', 1, 'USDT')}
            {field('riskPerTradePct', 'Risk / order', 0.1, '% equity')}
            {field('reactionHours', 'Jendela reaksi POI', 1, 'jam')}
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!form || running} onClick={() => void run()}>
              <Play className="size-4" /> {running ? 'Menghitung…' : 'Jalankan backtest'}
            </Button>
            <span className="text-xs text-muted-foreground">
              Risk / order default-nya dari Settings → Bot. Yang diubah di sini cuma berlaku buat simulasi ini.
            </span>
          </div>
          {error && <p className="text-xs text-bear">{error}</p>}
        </CardContent>
      </Card>

      {result && result.symbol === symbol && <Results r={result} group={group} setGroup={setGroup} />}
    </div>
  )
}

function Results({ r, group, setGroup }: { r: BacktestResult; group: BreakdownKey; setGroup: (g: BreakdownKey) => void }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Data {day(r.dataFrom)} → {day(r.dataTo)} · in-sample s/d {day(r.splitT)}, out-of-sample sesudahnya
        {r.splitAdjusted && ' (histori pendek → dibagi 2:1)'} · dihitung {formatTime(r.ranAt)} dalam {(r.ms / 1000).toFixed(1)} dtk · fee maker{' '}
        {r.params.makerFeePct}% / taker {r.params.takerFeePct}% + slippage {r.params.slippagePct}%
      </p>

      <Card>
        <CardHeader>
          <CardTitle>A. Setup entry (POI hit → OB valid → limit)</CardTitle>
          <CardDescription>
            R = kelipatan risk (jarak entry–SL). Avg R &gt; 0 setelah fee = ada edge. Dengan RR rata-rata X, winrate impas ≈ 1 ÷ (1 + X) sebelum fee.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b text-right">
                <th className="py-1 text-left">Periode</th>
                <th>Setup</th>
                <th title="TP kena duluan sebelum limit entry → batal">Lewat TP</th>
                <th>Expired</th>
                <th>Trade</th>
                <th>Winrate</th>
                <th>Avg RR</th>
                <th title="Rata-rata R per trade sebelum fee">Avg R kotor</th>
                <th title="Rata-rata R per trade setelah fee + slippage">Avg R bersih</th>
                <th>Total R</th>
                <th>PF</th>
                <th>Max DD</th>
              </tr>
            </thead>
            <tbody>
              {PERIODS.map(({ key, label }) => {
                const s = r.stats[key]
                const f = r.funnel[key]
                return (
                  <tr key={key} className="border-b text-right last:border-0">
                    <td className="py-1.5 text-left font-medium">{label}</td>
                    <td>{f.setups}</td>
                    <td>{f.missed}</td>
                    <td>{f.expired}</td>
                    <td>
                      {s.trades}
                      {f.open + f.pending > 0 && <span className="text-muted-foreground"> (+{f.open + f.pending} jalan)</span>}
                    </td>
                    <td>{pct(s.winrate)}</td>
                    <td>{num(s.avgRr)}</td>
                    <td className={signCls(r.grossStats[key].avgR)}>{num(r.grossStats[key].avgR)}</td>
                    <td className={cn('font-semibold', signCls(s.avgR))}>{num(s.avgR)}</td>
                    <td className={signCls(s.totalR)}>{num(s.totalR, 1)}</td>
                    <td>{num(s.profitFactor)}</td>
                    <td className="text-bear">{num(s.maxDdR, 1)}R</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <EquityCard r={r} />

      <Card>
        <CardHeader>
          <CardTitle>Pecahan setup</CardTitle>
          <CardDescription>Kalau satu grup cuma bagus di in-sample tapi jelek di out-of-sample, jangan dipercaya dulu. Grup di bawah ~30 trade masih sangat noise.</CardDescription>
          <div className="flex flex-wrap gap-1 pt-1">
            {BREAKDOWNS.map((b) => (
              <Button key={b.key} size="sm" variant={group === b.key ? 'default' : 'outline'} className="h-7" onClick={() => setGroup(b.key)}>
                {b.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-right">
                <th />
                {PERIODS.map((p) => (
                  <th key={p.key} colSpan={3} className="border-l px-2 text-center">
                    {p.label}
                  </th>
                ))}
              </tr>
              <tr className="border-b text-right">
                <th className="py-1 text-left">{BREAKDOWNS.find((b) => b.key === group)!.label}</th>
                {PERIODS.map((p) => (
                  <Cols key={p.key} />
                ))}
              </tr>
            </thead>
            <tbody>
              {r.breakdown[group].map((row) => (
                <tr key={row.key} className="border-b text-right last:border-0">
                  <td className="py-1.5 text-left font-medium">{row.key}</td>
                  {PERIODS.map((p) => (
                    <StatCells key={p.key} s={row.stats[p.key]} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <ReactionCard r={r} />

      <Card>
        <CardHeader>
          <CardTitle>30 trade terakhir</CardTitle>
          <CardDescription>Buat dicocokin manual sama chart. R sudah dipotong fee.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b text-right">
                <th className="py-1 text-left">Entry kena</th>
                <th className="text-left">Keluar</th>
                <th className="text-left">Arah</th>
                <th className="text-left">POI</th>
                <th>Skor</th>
                <th>Entry</th>
                <th>SL</th>
                <th>TP</th>
                <th>RR</th>
                <th>Hasil</th>
              </tr>
            </thead>
            <tbody>
              {r.recent.map((t) => (
                <tr key={`${t.filledT}-${t.entry}`} className="border-b text-right last:border-0">
                  <td className="py-1 text-left">{formatTime(t.filledT)}</td>
                  <td className="text-left">{formatTime(t.exitT)}</td>
                  <td className="text-left">
                    <Badge variant={t.direction === 'bullish' ? 'bull' : 'bear'}>{t.direction === 'bullish' ? 'LONG' : 'SHORT'}</Badge>
                  </td>
                  <td className="text-left">{t.poi}</td>
                  <td>{t.score}</td>
                  <td>{px(t.entry)}</td>
                  <td className="text-bear">{px(t.sl)}</td>
                  <td className="text-bull">{px(t.tp)}</td>
                  <td>{t.rr.toFixed(1)}</td>
                  <td className={cn('font-semibold', signCls(t.r))}>{t.r > 0 ? '+' : ''}{t.r.toFixed(2)}R</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  )
}

function Cols() {
  return (
    <>
      <th className="border-l px-2">Trade</th>
      <th className="px-2">WR</th>
      <th className="px-2">Avg R</th>
    </>
  )
}

function StatCells({ s }: { s: TradeStats }) {
  return (
    <>
      <td className="border-l px-2">{s.trades}</td>
      <td className="px-2">{pct(s.winrate)}</td>
      <td className={cn('px-2', signCls(s.avgR))}>{num(s.avgR)}</td>
    </>
  )
}

function EquityCard({ r }: { r: BacktestResult }) {
  const e = r.equity
  const W = 800
  const H = 160
  const pts = e.curve
  const path = useMemo(() => {
    if (pts.length < 2) return ''
    const t0 = pts[0]!.t
    const t1 = pts.at(-1)!.t || t0 + 1
    const ys = pts.map((p) => p.equity)
    const lo = Math.min(...ys, e.startEquity)
    const hi = Math.max(...ys, e.startEquity)
    const x = (t: number): number => ((t - t0) / Math.max(1, t1 - t0)) * W
    const y = (v: number): number => H - 4 - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 8)
    return { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.equity).toFixed(1)}`).join(''), base: y(e.startEquity), split: x(r.splitT) }
  }, [pts, e.startEquity, r.splitT])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Simulasi bot: risk {e.riskPerTradePct}% equity per order</CardTitle>
        <CardDescription>
          Ukuran posisi = equity × risk% ÷ jarak SL, dibatasi leverage maks {r.risk.maxLeverage}×. Satu posisi per koin, berhenti entry sisa hari itu (UTC)
          kalau rugi harian ≥ {r.risk.maxDailyLossPct}%. Belum ngecek minimal notional order Binance, jadi modal sangat kecil bisa lebih jelek di real.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="num flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            {e.startEquity.toFixed(2)} → <b className={signCls(e.endEquity - e.startEquity)}>{e.endEquity.toFixed(2)} USDT</b>
          </span>
          <span className={signCls(e.returnPct)}>
            {e.returnPct > 0 ? '+' : ''}
            {e.returnPct.toFixed(1)}%
          </span>
          <span>max drawdown <b className="text-bear">{e.maxDdPct.toFixed(1)}%</b></span>
          <span>{e.taken} trade diambil</span>
          <span className="text-muted-foreground">
            dilewati: {e.skippedOpen} (posisi masih buka) · {e.skippedHalt} (limit rugi harian) · {e.leverageCapped} dikecilin karena leverage · loss beruntun maks{' '}
            {e.maxLosingStreak}
          </span>
        </div>
        {path && (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Kurva equity">
            <line x1={0} x2={W} y1={path.base} y2={path.base} className="stroke-muted-foreground/40" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            {path.split > 0 && path.split < W && (
              <line x1={path.split} x2={path.split} y1={0} y2={H} className="stroke-muted-foreground/40" vectorEffect="non-scaling-stroke" />
            )}
            <path d={path.d} fill="none" className={e.endEquity >= e.startEquity ? 'stroke-bull' : 'stroke-bear'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <p className="text-[11px] text-muted-foreground">Garis putus-putus = modal awal · garis tegak = mulai out-of-sample.</p>
      </CardContent>
    </Card>
  )
}

function ReactionCard({ r }: { r: BacktestResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>B. Reaksi POI (tanpa aturan entry)</CardTitle>
        <CardDescription>
          Tiap POI yang disentuh harga: dari garis POI, mana yang kena duluan, +X% searah POI atau −X% nembus. Koin dilempar = 50%, jadi di atas ~55% baru
          kelihatan ada reaksi. Dalam satu candle, sisi rugi dihitung duluan (konservatif). Jendela {r.params.reactionHours} jam.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="num w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b text-right">
              <th className="py-1 text-left">POI</th>
              <th>TF</th>
              <th>Aktif</th>
              <th>Disentuh</th>
              {r.reactions[0]?.race.map((x) => (
                <th key={x.pct} title={`+${x.pct}% duluan dibanding −${x.pct}% (yang belum selesai di jendela tidak dihitung)`}>
                  ±{x.pct}%
                </th>
              ))}
              <th title="Close menembus POI dalam jendela reaksi">Invalid</th>
              <th title="Median gerak searah POI maksimal">Median MFE</th>
              <th title="Median gerak melawan POI maksimal">Median MAE</th>
            </tr>
          </thead>
          <tbody>
            {r.reactions.map((x) => (
              <tr key={`${x.kind}-${x.timeframe}`} className="border-b text-right last:border-0">
                <td className="py-1.5 text-left font-medium">{x.kind}</td>
                <td>{x.timeframe}</td>
                <td>{x.pois}</td>
                <td>{x.touches}</td>
                {x.race.map((q) => {
                  const done = q.win + q.loss
                  const rate = done ? q.win / done : null
                  return (
                    <td key={q.pct} className={rate === null ? '' : rate >= 0.55 ? 'text-bull' : rate < 0.45 ? 'text-bear' : ''} title={`${q.win} menang / ${q.loss} kalah / ${q.timeout} belum selesai`}>
                      {pct(rate)} <span className="text-muted-foreground">({done})</span>
                    </td>
                  )
                })}
                <td>{x.touches ? pct(x.invalidated / x.touches) : '—'}</td>
                <td>{x.medianMfePct === null ? '—' : `${x.medianMfePct.toFixed(2)}%`}</td>
                <td>{x.medianMaePct === null ? '—' : `${x.medianMaePct.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
