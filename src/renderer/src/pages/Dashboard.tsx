import { useEffect, useMemo, useRef, useState } from 'react'
import { CandlestickChart, CircleAlert, CircleCheck, CircleX, LayoutDashboard, RefreshCw } from 'lucide-react'
import { EXIT_REASON_LABEL, tradeOutcome, tradeR, type BotState, type BotTrade } from '@shared/bot'
import {
  breakdown,
  buckets,
  closedIn,
  GROUP_LABEL,
  maxDdUsd,
  openSummary,
  pnlCurve,
  utcDay,
  utcMonth,
  type BucketUnit,
  type DashboardData,
  type DashFilter,
  type GroupKey
} from '@shared/dashboard'
import { POI_LABEL } from '@shared/smc'
import { BucketBars, PnlCurveChart } from '@/components/DashCharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { botTradeFocus, openChart, tfForModel } from '@/lib/nav'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const DAY = 86_400_000
type Preset = 'today' | '7d' | '30d' | 'month' | 'all' | 'custom'
const PRESETS: [Preset, string][] = [
  ['today', 'Hari ini'],
  ['7d', '7 hari'],
  ['30d', '30 hari'],
  ['month', 'Bulan ini'],
  ['all', 'Semua'],
  ['custom', 'Rentang…']
]
const UNITS: [BucketUnit, string][] = [
  ['day', 'Harian'],
  ['week', 'Mingguan'],
  ['month', 'Bulanan']
]
const GROUPS: GroupKey[] = ['model', 'poi', 'poiTf', 'poiKind', 'dir', 'symbol', 'reason', 'weekday', 'hour']

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const usd = (n: number | null, d = 2): string => (n === null ? '—' : `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}`)
const tone = (n: number | null | undefined): string => (n == null || Math.abs(n) < 1e-9 ? '' : n > 0 ? 'text-bull' : 'text-bear')
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10)
const dur = (ms: number): string => {
  const h = ms / 3_600_000
  return h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}j` : `${(h / 24).toFixed(1)}h`
}
const poiText = (t: BotTrade): string => `${POI_LABEL[t.poi.kind] ?? t.poi.kind} ${t.poi.timeframe}`

/** [from, to) of a preset (UTC days). */
function range(p: Preset, from: string, to: string, now: number): { from: number | null; to: number | null } {
  if (p === 'today') return { from: utcDay(now), to: null }
  if (p === '7d') return { from: utcDay(now) - 6 * DAY, to: null }
  if (p === '30d') return { from: utcDay(now) - 29 * DAY, to: null }
  if (p === 'month') return { from: utcMonth(now), to: null }
  if (p === 'custom') return { from: from ? Date.parse(from) : null, to: to ? Date.parse(to) + DAY : null }
  return { from: null, to: null }
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [bot, setBot] = useState<BotState | null>(null)
  const [loading, setLoading] = useState(false)
  const [preset, setPreset] = useState<Preset>('30d')
  const [from, setFrom] = useState(isoDay(Date.now() - 29 * DAY))
  const [to, setTo] = useState(isoDay(Date.now()))
  const [models, setModels] = useState<string[]>([])
  const [dir, setDir] = useState<DashFilter['dir']>('all')
  const [unit, setUnit] = useState<BucketUnit>('day')
  const [group, setGroup] = useState<GroupKey>('poi')
  const [showAll, setShowAll] = useState(false)
  const status = useAppStore((s) => s.status)
  const lastLoad = useRef(0)

  const load = (): void => {
    lastLoad.current = Date.now()
    setLoading(true)
    void window.api
      .invoke('dashboard:get')
      .then(setData)
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    void window.api.invoke('bot:get').then(setBot)
    // bot state changes (fills, closes) → reload, at most every 10 s; marks every 30 s
    const off = window.api.on('bot:state', (s) => {
      setBot(s)
      if (Date.now() - lastLoad.current > 10_000) load()
    })
    const iv = setInterval(load, 30_000)
    return () => {
      off()
      clearInterval(iv)
    }
  }, [])

  const now = Date.now()
  const f: DashFilter = { ...range(preset, from, to, now), models, dir }
  const trades = data?.trades ?? []
  const allModels = useMemo(() => [...new Set(trades.map((t) => t.model))].sort(), [trades])
  const closed = useMemo(() => closedIn(trades, f), [trades, f.from, f.to, models, dir])
  const curve = useMemo(() => pnlCurve(closed), [closed])
  const total = closed.length ? curve[curve.length - 1]! : null
  const stat = useMemo(() => breakdown(closed, 'dir').reduce(
    (a, r) => ({ trades: a.trades + r.trades, wins: a.wins + r.wins, bes: a.bes + r.bes, losses: a.losses + r.losses }),
    { trades: 0, wins: 0, bes: 0, losses: 0 }
  ), [closed])
  const ddR = useMemo(() => {
    let peak = 0
    let dd = 0
    for (const p of curve) {
      peak = Math.max(peak, p.r)
      dd = Math.max(dd, peak - p.r)
    }
    return dd
  }, [curve])
  const bars = useMemo(() => buckets(closed, unit), [closed, unit])
  const groups = useMemo(() => breakdown(closed, group), [closed, group])
  const open = useMemo(() => openSummary(trades, data?.marks ?? {}, { models, dir }), [trades, data, models, dir])
  const wr = stat.wins + stat.losses ? stat.wins / (stat.wins + stat.losses) : null
  const list = [...closed].reverse()

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <LayoutDashboard className="size-5" />
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <Badge variant="bear">data LIVE</Badge>
        <span className="text-xs text-muted-foreground">Periode pakai waktu close trade, hari UTC (mulai 07:00 WIB).</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} /> Muat ulang
        </Button>
      </div>

      {/* filters: one row above everything */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-4 text-xs">
          <div className="flex flex-wrap items-center gap-1">
            {PRESETS.map(([k, l]) => (
              <Button key={k} size="sm" variant={preset === k ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs" onClick={() => setPreset(k)}>
                {l}
              </Button>
            ))}
            {preset === 'custom' && (
              <span className="ml-1 flex items-center gap-1">
                <Input type="date" className="h-7 w-36 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
                <span className="text-muted-foreground">s/d</span>
                <Input type="date" className="h-7 w-36 text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted-foreground">Model</span>
            <Button size="sm" variant={models.length === 0 ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs" onClick={() => setModels([])}>
              semua
            </Button>
            {allModels.map((m) => (
              <Button
                key={m}
                size="sm"
                variant={models.includes(m) ? 'secondary' : 'ghost'}
                className="h-7 px-2.5 text-xs"
                onClick={() => setModels(models.includes(m) ? models.filter((x) => x !== m) : [...models, m])}
              >
                {m}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-1 text-muted-foreground">Arah</span>
            {(
              [
                ['all', 'semua'],
                ['bullish', 'long'],
                ['bearish', 'short']
              ] as const
            ).map(([k, l]) => (
              <Button key={k} size="sm" variant={dir === k ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs" onClick={() => setDir(k)}>
                {l}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* headline numbers */}
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label="Equity Binance" value={bot?.equity == null ? '—' : `${bot.equity.toFixed(2)}`} unit="USDT" sub={bot?.equityAt ? `update ${new Date(bot.equityAt).toLocaleTimeString('id-ID', { hour12: false })}` : undefined} />
        <Tile label="PnL periode" value={usd(total?.pnl ?? 0)} unit="USDT" sub={`${(total?.r ?? 0).toFixed(2)}R`} cls={tone(total?.pnl)} />
        <Tile
          label="Trade selesai"
          value={String(stat.trades)}
          sub={`${stat.wins} untung · ${stat.bes} BE · ${stat.losses} rugi${wr === null ? '' : ` · WR ${Math.round(wr * 100)}%`}`}
        />
        <Tile label="Rata-rata per trade" value={stat.trades ? `${((total?.r ?? 0) / stat.trades).toFixed(2)}R` : '—'} sub={stat.trades ? `${usd((total?.pnl ?? 0) / stat.trades, 3)} USDT` : undefined} cls={tone(total?.r)} />
        <Tile label="DD maks periode" value={ddR > 0 ? `−${ddR.toFixed(2)}R` : '0R'} sub={`−${maxDdUsd(curve).toFixed(2)} USDT`} cls={ddR > 0 ? 'text-bear' : ''} />
        <Tile
          label={`Floating (${open.rows.length} posisi)`}
          value={usd(open.upnl)}
          unit="USDT"
          sub={`${open.r.toFixed(2)}R${open.noMark ? ` · ${open.noMark} tanpa harga` : ''}`}
          cls={tone(open.upnl)}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>PnL kumulatif</CardTitle>
            <CardDescription>Realised, bersih fee, urut waktu close. Arahkan mouse untuk detail.</CardDescription>
          </CardHeader>
          <CardContent>
            <PnlCurveChart points={curve} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>PnL per periode</CardTitle>
              <CardDescription>USDT per hari / minggu (Senin) / bulan, UTC.</CardDescription>
            </div>
            <div className="flex gap-1">
              {UNITS.map(([k, l]) => (
                <Button key={k} size="sm" variant={unit === k ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs" onClick={() => setUnit(k)}>
                  {l}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <BucketBars data={bars} unit={unit} />
          </CardContent>
        </Card>
      </div>

      {/* open positions */}
      <Card>
        <CardHeader>
          <CardTitle>Posisi yang lagi kebuka</CardTitle>
          <CardDescription className="num">
            Floating <span className={tone(open.upnl)}>{usd(open.upnl)} USDT ({open.r.toFixed(2)}R)</span> · kalau semua kena SL sekarang{' '}
            <span className={tone(open.atStop)}>{usd(open.atStop)} USDT</span> · margin {open.margin.toFixed(2)} USDT · limit nunggu {open.pending.count} (risk{' '}
            {open.pending.risk.toFixed(2)} USDT, margin {open.pending.margin.toFixed(2)} USDT). Harga = close 1m terakhir di DB, PnL sebelum fee exit.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {open.rows.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Nggak ada posisi kebuka.</p>
          ) : (
            <table className="num w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  {['simbol', 'arah', 'setup', 'entry', 'harga', 'SL sekarang', 'floating', 'R', 'best R', 'kalau kena SL', 'margin', 'umur', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-normal whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.rows.map((o) => (
                  <tr key={o.trade.id} className="border-t border-border/50">
                    <td className="px-3 py-1.5 font-medium">{o.trade.symbol}</td>
                    <td className={cn('px-3 py-1.5', o.trade.direction === 'bullish' ? 'text-bull' : 'text-bear')}>{o.trade.direction === 'bullish' ? 'LONG' : 'SHORT'}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {o.trade.model} · {poiText(o.trade)}
                    </td>
                    <td className="px-3 py-1.5">{px(o.trade.entry)}</td>
                    <td className="px-3 py-1.5">{o.mark === null ? '—' : px(o.mark)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {px(o.trade.sl)}
                      {o.trade.sl !== o.trade.slInitial && <span className="text-muted-foreground"> (awal {px(o.trade.slInitial)})</span>}
                    </td>
                    <td className={cn('px-3 py-1.5 font-semibold', tone(o.upnl))}>{usd(o.upnl, 3)}</td>
                    <td className={cn('px-3 py-1.5', tone(o.r))}>{o.r === null ? '—' : `${o.r.toFixed(2)}R`}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{o.trade.exitState ? `${o.trade.exitState.bestR}R` : '—'}</td>
                    <td className={cn('px-3 py-1.5', tone(o.atStop))}>{usd(o.atStop, 3)}</td>
                    <td className="px-3 py-1.5">{o.margin.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{dur(now - (o.trade.filledAt ?? o.trade.createdAt))}</td>
                    <td className="px-3 py-1.5">
                      <ChartBtn t={o.trade} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* what works */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Paling efektif</CardTitle>
            <CardDescription>Trade selesai di periode + filter di atas, dikelompokkan, urut total R. n kecil = belum bisa dipercaya.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-1">
            {GROUPS.map((g) => (
              <Button key={g} size="sm" variant={group === g ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs" onClick={() => setGroup(g)}>
                {GROUP_LABEL[g]}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {groups.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Belum ada trade selesai.</p>
          ) : (
            <table className="num w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  {[GROUP_LABEL[group], 'trade', 'untung', 'BE', 'rugi', 'WR (tanpa BE)', 'total R', 'rata-rata R', 'DD maks', 'PnL USDT', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-normal whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const maxAbs = Math.max(...groups.map((x) => Math.abs(x.totalR)), 1e-9)
                  return (
                    <tr key={g.key} className="border-t border-border/50">
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap">{group === 'reason' ? (EXIT_REASON_LABEL[g.key] ?? g.key) : g.key}</td>
                      <td className="px-3 py-1.5">{g.trades}</td>
                      <td className="px-3 py-1.5">{g.wins}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{g.bes}</td>
                      <td className="px-3 py-1.5">{g.losses}</td>
                      <td className="px-3 py-1.5">{g.wr === null ? '—' : `${Math.round(g.wr * 100)}%`}</td>
                      <td className={cn('px-3 py-1.5 font-semibold', tone(g.totalR))}>{g.totalR.toFixed(2)}R</td>
                      <td className={cn('px-3 py-1.5', tone(g.avgR))}>{g.avgR === null ? '—' : `${g.avgR.toFixed(2)}R`}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{g.maxDdR > 0 ? `−${g.maxDdR.toFixed(2)}R` : '0R'}</td>
                      <td className={cn('px-3 py-1.5', tone(g.pnl))}>{usd(g.pnl)}</td>
                      <td className="w-40 px-3 py-1.5">
                        <div className="h-1.5 rounded-full bg-muted">
                          <div className={cn('h-1.5 rounded-full', g.totalR >= 0 ? 'bg-bull' : 'bg-bear')} style={{ width: `${(Math.abs(g.totalR) / maxAbs) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* closed trades */}
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Trade selesai ({closed.length})</CardTitle>
            <CardDescription>Terbaru di atas. PnL bersih fee.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {list.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">Belum ada.</p>
            ) : (
              <table className="num w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    {['close', 'simbol', 'arah', 'setup', 'entry → exit', 'tahan', 'exit', 'PnL', 'R', ''].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-normal whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? list : list.slice(0, 50)).map((t) => {
                    const o = tradeOutcome(t)
                    return (
                      <tr key={t.id} className="border-t border-border/50">
                        <td className="px-3 py-1.5 whitespace-nowrap">{formatTime(t.closedAt)}</td>
                        <td className="px-3 py-1.5 font-medium">{t.symbol}</td>
                        <td className={cn('px-3 py-1.5', t.direction === 'bullish' ? 'text-bull' : 'text-bear')}>{t.direction === 'bullish' ? 'LONG' : 'SHORT'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {t.model} · {poiText(t)}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {px(t.entry)} → {t.exitPrice === null ? '—' : px(t.exitPrice)}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{t.filledAt && t.closedAt ? dur(t.closedAt - t.filledAt) : '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                          {o === 'be' && <Badge variant="secondary" className="mr-1">BE</Badge>}
                          {EXIT_REASON_LABEL[t.reason ?? ''] ?? t.reason}
                        </td>
                        <td className={cn('px-3 py-1.5 font-semibold', o === 'win' ? 'text-bull' : o === 'loss' ? 'text-bear' : 'text-muted-foreground')}>{usd(t.pnl, 3)}</td>
                        <td className="px-3 py-1.5">{tradeR(t)?.toFixed(2) ?? '—'}R</td>
                        <td className="px-3 py-1.5">
                          <ChartBtn t={t} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {list.length > 50 && (
              <div className="px-4 py-2">
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Tampilkan 50 terbaru' : `Tampilkan semua (${list.length})`}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Health bot={bot} />
      </div>
    </div>
  )

  function Health({ bot: b }: { bot: BotState | null }) {
    const items: { ok: boolean | null; label: string; detail: string }[] = [
      { ok: b ? b.enabled && b.live : null, label: 'Bot', detail: !b ? '—' : `${b.enabled ? 'jalan' : 'MATI'} · ${b.live ? 'live' : 'paper'}` },
      { ok: !status?.killSwitch.active, label: 'Kill Switch', detail: status?.killSwitch.active ? `aktif sejak ${formatTime(status.killSwitch.at)}` : 'nggak aktif' },
      { ok: b ? !b.blocked : null, label: 'Entry baru', detail: b?.blocked ? `diblok: ${b.blocked}` : 'boleh' },
      {
        ok: status ? status.live.status === 'connected' : null,
        label: 'WebSocket harga',
        detail: status ? `${status.live.status} · ${status.live.streams} stream${status.live.latencyMs !== null ? ` · ${status.live.latencyMs} ms` : ''}` : '—'
      },
      {
        ok: status ? status.sync.status !== 'error' : null,
        label: 'Sync data',
        detail: status ? `${status.sync.status} · ${status.sync.upToDate}/${status.sync.total} simbol up to date` : '—'
      },
      {
        ok: b?.equityAt ? now - b.equityAt < 15 * 60_000 : null,
        label: 'Saldo Binance',
        detail: b?.equityAt ? `terakhir dibaca ${dur(now - b.equityAt)} lalu` : 'belum kebaca'
      },
      { ok: b ? !b.lastError : null, label: 'Error terakhir', detail: b?.lastError ?? 'nggak ada' },
      { ok: b ? b.blacklist.length === 0 : null, label: 'Blacklist SL', detail: b?.blacklist.length ? b.blacklist.map((x) => x.symbol).join(', ') : 'kosong' },
      { ok: null, label: 'Universe', detail: b ? `${b.universe.count} koin${b.universe.updatedAt ? ` · update ${formatTime(b.universe.updatedAt)}` : ''}` : '—' }
    ]
    const warns = (b?.events ?? []).filter((e) => e.level === 'warn' || e.level === 'error').slice(0, 6)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Kesehatan bot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-xs">
          {items.map((i) => (
            <div key={i.label} className="flex items-start gap-2">
              {i.ok === true ? (
                <CircleCheck className="mt-px size-3.5 shrink-0 text-bull" />
              ) : i.ok === false ? (
                <CircleX className="mt-px size-3.5 shrink-0 text-bear" />
              ) : (
                <CircleAlert className="mt-px size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="w-28 shrink-0 font-medium">{i.label}</span>
              <span className={cn('min-w-0 break-words', i.ok === false ? 'text-bear' : 'text-muted-foreground')}>{i.detail}</span>
            </div>
          ))}
          <div className="border-t pt-2">
            <div className="mb-1 font-medium">Warning / error terbaru</div>
            {warns.length === 0 ? (
              <div className="text-muted-foreground">Nggak ada.</div>
            ) : (
              warns.map((e) => (
                <div key={e.id} className={cn('flex gap-2', e.level === 'error' ? 'text-bear' : 'text-warn')}>
                  <span className="num shrink-0 text-muted-foreground">{formatTime(e.t)}</span>
                  <span className="min-w-0 break-words">
                    {e.symbol ? `${e.symbol} · ` : ''}
                    {e.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    )
  }
}

function Tile({ label, value, unit, sub, cls }: { label: string; value: string; unit?: string; sub?: string; cls?: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn('num text-2xl font-semibold', cls)}>
          {value}
          {unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}
        </div>
        {sub && <div className="num text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
}

function ChartBtn({ t }: { t: BotTrade }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-xs"
      onClick={() => openChart(t.symbol, { tf: tfForModel(t.model), ...(t.status === 'closed' ? { focus: botTradeFocus(t) } : {}) })}
    >
      <CandlestickChart className="size-3" /> Chart
    </Button>
  )
}
