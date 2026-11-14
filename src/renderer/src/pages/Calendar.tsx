import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldAlert, Timer } from 'lucide-react'
import type { Bias, EconomicEvent, EventReaction, NewsCandidate, ReactionStat } from '@shared/news'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const DAY = 86_400_000
const dayFmt = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false })

function startOfLocalDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function startOfLocalWeek(t: number): number {
  const d = new Date(startOfLocalDay(t))
  return d.getTime() - ((d.getDay() + 6) % 7) * DAY // Monday
}

function countdown(ms: number): string {
  if (ms <= 0) return 'sekarang'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return d ? `${d}hr ${h}j ${m}m` : h ? `${h}j ${m}m ${sec}dtk` : `${m}m ${String(sec).padStart(2, '0')}dtk`
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

const impactVariant = (i: string) => (i === 'High' ? 'bear' : i === 'Medium' ? 'warn' : 'outline')

function BiasBadge({ bias, label }: { bias: Bias | null; label: string }) {
  if (!bias) return <span className="text-muted-foreground">—</span>
  return (
    <Badge variant={bias === 'bullish' ? 'bull' : bias === 'bearish' ? 'bear' : 'outline'}>
      {label} {bias}
    </Badge>
  )
}

/** Accepts "0.4", "0.4%", "203K", "-1.2B" → number (unit suffix dropped like the feed). */
const parseInput = (s: string): number | null => {
  const m = s.trim().replace(/,/g, '.').match(/^([-+]?\d*\.?\d+)\s*[%KMBT]?$/i)
  return m ? Number(m[1]) : null
}

function ActualCell({ e }: { e: EconomicEvent }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const released = e.time <= Date.now()
  // speeches etc. have nothing to measure: no forecast, no previous, no interpretation rule
  const measurable = e.forecastRaw !== null || e.previousRaw !== null || e.ruleKey !== null || e.actual !== null
  if (!measurable) return null
  if (editing)
    return (
      <form
        className="flex gap-1"
        onSubmit={(ev) => {
          ev.preventDefault()
          const v = val.trim() === '' ? null : parseInput(val)
          if (val.trim() !== '' && v === null) return
          void window.api.invoke('news:setActual', { id: e.id, value: v })
          setEditing(false)
        }}
      >
        <Input autoFocus className="num h-7 w-24 text-xs" placeholder={e.forecastRaw ?? 'actual'} value={val} onChange={(x) => setVal(x.target.value)} />
        <Button size="sm" className="h-7 px-2 text-xs" type="submit">
          OK
        </Button>
      </form>
    )
  return (
    <button
      disabled={!released}
      onClick={() => {
        setVal(e.actualRaw ?? '')
        setEditing(true)
      }}
      className="num text-left disabled:cursor-default"
      title={released ? 'Klik untuk isi/ubah actual manual' : 'Belum rilis'}
    >
      {e.actualRaw ?? (released ? <span className="text-muted-foreground underline decoration-dotted">isi</span> : '')}
      {e.actualSource && <span className="ml-1 text-[10px] uppercase text-muted-foreground">{e.actualSource}</span>}
    </button>
  )
}

function Reactions({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<EventReaction[] | null>(null)
  useEffect(() => {
    void window.api.invoke('news:reactions', { eventId }).then(setRows)
  }, [eventId])
  if (!rows) return null
  if (!rows.length) return <span className="text-muted-foreground">Reaksi harga belum tercatat (perlu candle 1m simbolnya).</span>
  const symbols = [...new Set(rows.map((r) => r.symbol))]
  return (
    <div className="flex flex-wrap gap-4">
      {symbols.map((s) => (
        <span key={s} className="num">
          {s}:{' '}
          {rows
            .filter((r) => r.symbol === s)
            .sort((a, b) => a.horizonMin - b.horizonMin)
            .map((r) => (
              <span key={r.horizonMin} className={cn('mr-2', r.changePct >= 0 ? 'text-bull' : 'text-bear')}>
                {r.horizonMin}m {r.changePct >= 0 ? '+' : ''}
                {r.changePct.toFixed(2)}%
              </span>
            ))}
        </span>
      ))}
    </div>
  )
}

export function Calendar() {
  const news = useAppStore((s) => s.status?.news)
  const now = useNow()
  const [range, setRange] = useState<'today' | 'week'>('week')
  const [all, setAll] = useState(false)
  const [events, setEvents] = useState<EconomicEvent[]>([])
  const [cands, setCands] = useState<NewsCandidate[]>([])
  const [stats, setStats] = useState<ReactionStat[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [cfg, setCfg] = useState<{ currencies: string[]; impacts: string[]; mode: string } | null>(null)

  const load = useCallback(async () => {
    const from = range === 'today' ? startOfLocalDay(Date.now()) : startOfLocalWeek(Date.now())
    const to = from + (range === 'today' ? DAY : 7 * DAY)
    const [ev, c, st, conf] = await Promise.all([
      window.api.invoke('news:list', { from, to }),
      window.api.invoke('news:candidates'),
      window.api.invoke('news:stats'),
      window.api.invoke('config:get')
    ])
    setEvents(ev)
    setCands(c)
    setStats(st)
    setCfg({ currencies: conf.news.currencies, impacts: conf.news.impacts, mode: conf.news.cryptoBiasMode })
  }, [range])

  useEffect(() => {
    void load()
    return window.api.on('news:changed', () => void load())
  }, [load])

  const shown = useMemo(
    () => events.filter((e) => all || !cfg || (cfg.currencies.includes(e.currency) && cfg.impacts.includes(e.impact))),
    [events, all, cfg]
  )
  const byDay = useMemo(() => {
    const m = new Map<number, EconomicEvent[]>()
    for (const e of shown) {
      const d = startOfLocalDay(e.time)
      m.set(d, [...(m.get(d) ?? []), e])
    }
    return [...m.entries()]
  }, [shown])

  const next = news?.nextEvent
  const win = news?.window

  return (
    <div className="w-full space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Economic Calendar</h1>
        <span className="text-xs text-muted-foreground">Sumber: ForexFactory feed · actual: BLS / FRED / manual</span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Timer className="size-3.5" /> Event berikutnya
            </CardTitle>
          </CardHeader>
          <CardContent>
            {next ? (
              <>
                <div className="num text-2xl">{countdown(next.time - now)}</div>
                <div className="mt-1 text-sm">
                  {next.title} <Badge variant={impactVariant(next.impact)}>{next.impact}</Badge>
                </div>
                <div className="num text-xs text-muted-foreground">{formatTime(next.time)}</div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Tidak ada event terjadwal.</div>
            )}
          </CardContent>
        </Card>
        <Card className={cn(win && 'border-warn/50')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <ShieldAlert className="size-3.5" /> News window
            </CardTitle>
          </CardHeader>
          <CardContent>
            {win ? (
              <>
                <div className="text-lg text-warn">AKTIF</div>
                <div className="text-sm">{win.title}</div>
                <div className="num text-xs text-muted-foreground">selesai dalam {countdown(win.endsAt - now)} — bot tidak buka posisi baru</div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Tidak aktif</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-xs font-medium text-muted-foreground">Status sumber data</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            <div>
              Feed terakhir: <span className="num">{formatTime(news?.lastFetchAt ?? null)}</span>
            </div>
            <div>
              BLS hari ini: <span className="num">{news?.blsCallsToday ?? 0}</span> panggilan
            </div>
            {news?.lastError && <div className="text-bear">{news.lastError}</div>}
            <Button size="sm" variant="secondary" className="mt-1" onClick={() => window.api.invoke('news:refresh')}>
              <RefreshCw /> Refresh
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <CardTitle>Event</CardTitle>
          <div className="ml-4 flex rounded-md border p-0.5 text-xs">
            {(['today', 'week'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn('rounded px-2.5 py-1 text-muted-foreground', range === r && 'bg-accent text-foreground')}
              >
                {r === 'today' ? 'Hari ini' : 'Minggu ini'}
              </button>
            ))}
          </div>
          <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Semua mata uang & impact
          </label>
          <span className="ml-auto text-xs text-muted-foreground">Bias crypto: mode {cfg?.mode ?? '—'}</span>
        </CardHeader>
        <CardContent>
          {byDay.length === 0 ? (
            <div className="text-sm text-muted-foreground">Belum ada event (feed belum diambil?).</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  {['jam', 'cur', 'impact', 'event', 'actual', 'forecast', 'previous', 'USD', 'crypto'].map((h) => (
                    <th key={h} className="px-2 py-1 text-left font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byDay.map(([d, evs]) => (
                  <Fragment key={d}>
                    <tr>
                      <td colSpan={9} className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase text-muted-foreground">
                        {dayFmt.format(d)}
                      </td>
                    </tr>
                    {evs.map((e) => (
                      <Fragment key={e.id}>
                        <tr
                          className={cn(
                            'cursor-pointer border-t border-border/50 hover:bg-accent/40',
                            e.time <= now && 'opacity-90',
                            next?.id === e.id && 'bg-warn/5'
                          )}
                          onClick={() => setOpen(open === e.id ? null : e.id)}
                        >
                          <td className="num px-2 py-1.5">{timeFmt.format(e.time)}</td>
                          <td className="px-2">{e.currency}</td>
                          <td className="px-2">
                            <Badge variant={impactVariant(e.impact)}>{e.impact}</Badge>
                          </td>
                          <td className="selectable px-2">{e.title}</td>
                          <td className="px-2" onClick={(x) => x.stopPropagation()}>
                            <ActualCell e={e} />
                          </td>
                          <td className="num px-2">{e.forecastRaw ?? ''}</td>
                          <td className="num px-2">{e.previousRaw ?? ''}</td>
                          <td className="px-2">
                            <BiasBadge bias={e.usdBias} label="USD" />
                          </td>
                          <td className="px-2">
                            <BiasBadge bias={e.cryptoBias} label="" />
                          </td>
                        </tr>
                        {open === e.id && (
                          <tr className="bg-accent/20">
                            <td colSpan={9} className="space-y-1 px-2 py-2 text-xs">
                              <div className="text-muted-foreground">
                                Aturan: <span className="num text-foreground">{e.ruleKey ?? 'tidak ada (informasi saja)'}</span>
                                {e.biasReason && <> · {e.biasReason}</>}
                              </div>
                              {e.time <= now && <Reactions eventId={e.id} />}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Kandidat trade on news</CardTitle>
          <CardDescription>
            Bias USD dari actual vs forecast + konteks SMC (trend, POI, liquidity, OB valid). Bukan order otomatis. Masuk tetap
            tunggu konfirmasi OB valid (Materi 3).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cands.length === 0 ? (
            <div className="text-sm text-muted-foreground">Belum ada kandidat. Muncul otomatis setelah actual event USD keluar.</div>
          ) : (
            <div className="space-y-2">
              {cands.slice(0, 12).map((c) => (
                <div key={c.id} className="rounded-md border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="num font-semibold">{c.symbol}</span>
                    <Badge variant={c.direction === 'bullish' ? 'bull' : 'bear'}>{c.direction === 'bullish' ? 'LONG bias' : 'SHORT bias'}</Badge>
                    {c.aligned ? <Badge variant="bull">searah trend</Badge> : <Badge variant="warn">lawan trend</Badge>}
                    {c.setupId && <Badge variant="secondary">ada OB valid</Badge>}
                    <span className="text-muted-foreground">{c.eventTitle}</span>
                    <span className="num ml-auto text-muted-foreground">{formatTime(c.createdAt)}</span>
                  </div>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {c.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Apakah "bad for USD = good for crypto" berlaku?</CardTitle>
          <CardDescription>Dari reaksi harga yang tercatat setelah tiap event yang punya bias USD.</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.length === 0 ? (
            <div className="text-sm text-muted-foreground">Belum ada data. Terisi otomatis seiring event berjalan.</div>
          ) : (
            <table className="num w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  {['simbol', 'horizon', 'bias USD', 'n', 'rata-rata', 'sesuai aturan'].map((h) => (
                    <th key={h} className="px-2 py-1 text-left font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={`${s.symbol}${s.horizonMin}${s.usdBias}`} className="border-t border-border/50">
                    <td className="px-2 py-1">{s.symbol}</td>
                    <td className="px-2">{s.horizonMin}m</td>
                    <td className="px-2">{s.usdBias}</td>
                    <td className="px-2">{s.n}</td>
                    <td className={cn('px-2', s.avgChangePct >= 0 ? 'text-bull' : 'text-bear')}>
                      {s.avgChangePct >= 0 ? '+' : ''}
                      {s.avgChangePct.toFixed(3)}%
                    </td>
                    <td className="px-2">{s.ruleHitPct === null ? '—' : `${Math.round(s.ruleHitPct * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
