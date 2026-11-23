import { useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import type { Setup, SmcAnalysis } from '@shared/smc'
import { COLORS, DEFAULT_LAYERS, LAYERS, LAYER_LABEL, SmcOverlay, type Layers } from '@/chart/smcOverlay'
import { SetupList } from '@/components/SetupList'
import type { Candle } from '@shared/candles'
import type { SymbolListItem } from '@shared/ipc'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { BotState, BotTrade } from '@shared/bot'
import { LiveBadge } from '@/components/layout/LiveBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { openBacktest, type ChartFocus } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const TFS: Timeframe[] = ['1m', '3m', '5m', '10m', '15m', '45m', '1h', '2h', '3h', '4h', '1d', '1w']
const BULL = '#26b07e'
const BEAR = '#ef5350'
const LIMIT = 3000
const DAY = 86_400_000

const remember = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage unavailable */
  }
}
const recall = (k: string, d: string): string => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}

const toBar = (c: Candle) => ({ time: (c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })
const toVol = (c: Candle) => ({
  time: (c.t / 1000) as UTCTimestamp,
  value: c.v,
  color: c.c >= c.o ? `${BULL}66` : `${BEAR}66`
})

/** A past trade to show (set by the Backtest / Bot page, read once). */
type Focus = ChartFocus

function takeFocus(): Focus | null {
  try {
    const raw = localStorage.getItem('chart.focus')
    localStorage.removeItem('chart.focus')
    return raw ? (JSON.parse(raw) as Focus) : null
  } catch {
    return null
  }
}

/** Period start for 1d/1w (UTC; week = Monday) — used to merge live 1m into those bars. */
function periodStart(t: number, tf: '1d' | '1w'): number {
  const day = Math.floor(t / DAY) * DAY
  if (tf === '1d') return day
  return day - ((new Date(t).getUTCDay() + 6) % 7) * DAY
}

const fmtLocal = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

export function Chart() {
  const live = useAppStore((s) => s.status?.live)
  const [symbols, setSymbols] = useState<SymbolListItem[]>([])
  const [symbol, setSymbol] = useState(() => recall('chart.symbol', 'BTCUSDT'))
  const [query, setQuery] = useState(symbol)
  const [tf, setTf] = useState<Timeframe>(() => recall('chart.tf', '15m') as Timeframe)
  const [reload, setReload] = useState(0)
  const [info, setInfo] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const price = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null)
  const last = useRef<Candle | null>(null)
  const overlay = useRef<SmcOverlay | null>(null)
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const [layers, setLayers] = useState<Layers>(() => {
    try {
      return { ...DEFAULT_LAYERS, ...JSON.parse(recall('chart.layers', '{}')) }
    } catch {
      return DEFAULT_LAYERS
    }
  })
  const [analysis, setAnalysis] = useState<SmcAnalysis | null>(null)
  const [setups, setSetups] = useState<Setup[]>([])
  const [smcTick, setSmcTick] = useState(0)
  const [focus, setFocus] = useState<Focus | null>(() => {
    const f = takeFocus()
    return f && f.symbol === recall('chart.symbol', 'BTCUSDT') ? f : null
  })
  const focusLines = useRef<IPriceLine[]>([])
  const posLines = useRef<IPriceLine[]>([])
  const [bot, setBot] = useState<BotState | null>(null)
  const [lastPx, setLastPx] = useState<number | null>(null)

  useEffect(() => {
    void window.api.invoke('bot:get').then(setBot)
    return window.api.on('bot:state', setBot)
  }, [])

  // the bot's pending / open trades on this coin (current mode)
  const positions = useMemo(
    () => (bot?.trades ?? []).filter((t) => t.symbol === symbol && t.mode === (bot?.live ? 'live' : 'paper') && (t.status === 'open' || t.status === 'pending')),
    [bot, symbol]
  )

  const synced = useMemo(() => symbols.find((s) => s.symbol === symbol)?.synced ?? false, [symbols, symbol])

  useEffect(() => {
    void window.api.invoke('symbols:list').then(setSymbols)
  }, [reload])

  // create the chart once
  useEffect(() => {
    if (!box.current) return
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#9aa0aa', fontFamily: 'JetBrains Mono Variable, monospace' },
      grid: { vertLines: { color: '#ffffff0d' }, horzLines: { color: '#ffffff0d' } },
      rightPriceScale: { borderColor: '#ffffff1a' },
      timeScale: {
        borderColor: '#ffffff1a',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) => fmtLocal.format(new Date(time * 1000))
      },
      localization: { timeFormatter: (time: number) => fmtLocal.format(new Date(time * 1000)) },
      crosshair: { mode: 0 }
    })
    price.current = c.addSeries(CandlestickSeries, {
      upColor: BULL,
      downColor: BEAR,
      borderVisible: false,
      wickUpColor: BULL,
      wickDownColor: BEAR
    })
    volume.current = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1)
    c.panes()[1]?.setHeight(90)
    const ov = new SmcOverlay()
    price.current.attachPrimitive(ov)
    overlay.current = ov
    markers.current = createSeriesMarkers(price.current, [])
    chart.current = c
    return () => {
      overlay.current = null
      markers.current = null
      c.remove()
      chart.current = null
      price.current = null
      volume.current = null
    }
  }, [])

  // switching coin: wipe the previous coin's candles/overlay and reset zoom + price scale
  useEffect(() => {
    price.current?.setData([])
    volume.current?.setData([])
    last.current = null
    setAnalysis(null)
    setSetups([])
    chart.current?.timeScale().resetTimeScale()
    price.current?.priceScale().applyOptions({ autoScale: true })
  }, [symbol])

  // stream this symbol while the chart is open
  useEffect(() => {
    void window.api.invoke('live:setChart', { symbol })
    return () => void window.api.invoke('live:setChart', { symbol: null })
  }, [symbol])

  // load history
  useEffect(() => {
    let cancelled = false
    const tfMs = TF_MS[tf]
    const f = focus && focus.symbol === symbol ? focus : null
    const before = f ? f.until + 300 * tfMs : undefined
    void window.api.invoke('candles:get', { symbol, timeframe: tf, limit: LIMIT, ...(before ? { before } : {}) }).then((rows) => {
      if (cancelled || !price.current || !volume.current) return
      price.current.setData(rows.map(toBar))
      volume.current.setData(rows.map(toVol))
      last.current = rows[rows.length - 1] ?? null
      setLastPx(last.current?.c ?? null)
      setInfo(rows.length ? null : 'Belum ada data untuk simbol ini — sedang disiapkan (backfill 6 bulan)…')
      price.current.priceScale().applyOptions({ autoScale: true })
      for (const l of focusLines.current) price.current.removePriceLine(l)
      focusLines.current = []
      if (f) {
        const from = (Math.floor(f.t / tfMs) * tfMs - 80 * tfMs) / 1000
        const to = (Math.floor(f.until / tfMs) * tfMs + 40 * tfMs) / 1000
        chart.current?.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp })
        const p = price.current
        focusLines.current = [
          p.createPriceLine({ price: f.entry, color: f.dir === 'bullish' ? BULL : BEAR, lineWidth: 2, title: 'ENTRY' }),
          p.createPriceLine({ price: f.sl, color: BEAR, lineWidth: 1, lineStyle: 2, title: f.slFinal != null ? 'SL awal' : 'SL' }),
          ...(f.slFinal != null ? [p.createPriceLine({ price: f.slFinal, color: '#f5a524', lineWidth: 1, lineStyle: 2, title: 'SL akhir' })] : []),
          ...(f.tp != null ? [p.createPriceLine({ price: f.tp, color: BULL, lineWidth: 1, lineStyle: 2, title: 'TP' })] : []),
          ...(f.exit != null ? [p.createPriceLine({ price: f.exit, color: '#8b9cf7', lineWidth: 1, lineStyle: 0, title: 'EXIT' })] : [])
        ]
      } else chart.current?.timeScale().scrollToRealTime()
    })
    return () => {
      cancelled = true
    }
  }, [symbol, tf, reload, focus])

  // live updates
  useEffect(() => {
    const offCandle = window.api.on('live:candle', (e) => {
      if (e.symbol !== symbol || !price.current || !volume.current || focus) return
      let bar: Candle | undefined
      if (tf === '1d' || tf === '1w') {
        const m = e.candles['1m']
        if (!m) return
        const start = periodStart(m.t, tf)
        const prev = last.current
        bar =
          prev && prev.t === start
            ? { ...prev, h: Math.max(prev.h, m.h), l: Math.min(prev.l, m.l), c: m.c }
            : { t: start, o: m.o, h: m.h, l: m.l, c: m.c, v: m.v }
      } else {
        bar = e.candles[tf]
      }
      if (e.closed) setSmcTick((n) => n + 1)
      if (!bar || (last.current && bar.t < last.current.t)) return
      price.current.update(toBar(bar))
      volume.current.update(toVol(bar))
      last.current = bar
      setLastPx(bar.c)
    })
    const offSynced = window.api.on('live:synced', ({ symbol: s }) => {
      if (s === symbol) setReload((n) => n + 1)
    })
    return () => {
      offCandle()
      offSynced()
    }
  }, [symbol, tf, focus])

  // SMC analysis + setups (recomputed on symbol/TF change and after each closed 1m candle)
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      const [a, st] = await Promise.all([
        window.api.invoke('smc:analyze', { symbol, timeframe: tf, limit: LIMIT }),
        window.api.invoke('smc:setups', { symbol })
      ])
      if (cancelled) return
      setAnalysis(a)
      setSetups(st)
    }, smcTick ? 1500 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [symbol, tf, reload, smcTick])

  // push analysis into the overlay, markers and price lines
  useEffect(() => {
    overlay.current?.set({ analysis, setups, layers, lastClose: last.current?.c ?? null })
    const m: SeriesMarker<Time>[] = []
    if (analysis && layers.structure) {
      for (const sw of analysis.swings.slice(layers.history ? -200 : -40)) {
        if (!sw.label) continue
        m.push({
          time: (sw.t / 1000) as UTCTimestamp,
          position: sw.kind === 'high' ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          size: 0.4,
          color: sw.label === 'HH' || sw.label === 'HL' ? COLORS.bull : COLORS.bear,
          text: sw.label
        })
      }
      for (const b of analysis.breaks.slice(layers.history ? -100 : -10))
        m.push({
          time: (b.t / 1000) as UTCTimestamp,
          position: b.direction === 'bullish' ? 'belowBar' : 'aboveBar',
          shape: b.direction === 'bullish' ? 'arrowUp' : 'arrowDown',
          color: b.direction === 'bullish' ? COLORS.bull : COLORS.bear,
          text: 'BOS'
        })
    }
    m.sort((p, q) => (p.time as number) - (q.time as number))
    markers.current?.setMarkers(m)

  }, [analysis, setups, layers])

  // live position lines (hidden while looking at a past trade)
  useEffect(() => {
    const p = price.current
    if (!p) return
    for (const l of posLines.current) p.removePriceLine(l)
    posLines.current = []
    if (focus) return
    for (const t of positions) {
      const long = t.direction === 'bullish'
      const moved = t.sl !== t.slInitial
      posLines.current.push(
        p.createPriceLine({ price: t.entry, color: long ? BULL : BEAR, lineWidth: 2, title: `${t.status === 'pending' ? 'LIMIT' : 'POSISI'} ${long ? 'LONG' : 'SHORT'} ${t.model}` }),
        p.createPriceLine({ price: t.sl, color: moved ? '#f5a524' : BEAR, lineWidth: 1, lineStyle: 2, title: moved ? 'SL (geser)' : 'SL' }),
        ...(t.tp !== null ? [p.createPriceLine({ price: t.tp, color: BULL, lineWidth: 1, lineStyle: 2, title: 'TP' })] : [])
      )
    }
  }, [positions, focus, symbol, tf])

  const toggle = (k: keyof Layers): void => {
    const next = { ...layers, [k]: !layers[k] }
    setLayers(next)
    remember('chart.layers', JSON.stringify(next))
  }

  const choose = (raw: string): void => {
    const s = raw.trim().toUpperCase()
    if (!symbols.some((x) => x.symbol === s)) return
    setSymbol(s)
    setQuery(s)
    setFocus(null)
    remember('chart.symbol', s)
  }

  return (
    <div className="flex h-full min-h-[480px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="num h-8 w-44"
          list="chart-symbols"
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && choose(query)}
          onBlur={() => choose(query)}
          placeholder="BTCUSDT"
        />
        <datalist id="chart-symbols">
          {symbols.map((s) => (
            <option key={s.symbol} value={s.symbol}>
              {s.synced ? '' : 'belum sync'}
            </option>
          ))}
        </datalist>
        <div className="flex rounded-md border p-0.5">
          {TFS.map((t) => (
            <button
              key={t}
              onClick={() => {
                setTf(t)
                remember('chart.tf', t)
              }}
              className={cn(
                'num rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground',
                tf === t && 'bg-accent text-foreground'
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <LiveBadge live={live} />
        {!synced && <span className="text-xs text-warn">belum ada histori lokal</span>}
        {analysis?.trend && (
          <span className={cn('text-xs', analysis.trend === 'bullish' ? 'text-bull' : 'text-bear')}>
            Trend {tf}: {analysis.trend}
          </span>
        )}
        {focus && (
          <span className="flex items-center gap-2 rounded-md border border-warn/50 px-2 py-0.5 text-xs text-warn">
            Lihat {focus.label ?? 'trade'} {new Date(focus.t).toLocaleString('id-ID')} (overlay SMC tetap data terbaru)
            <button type="button" className="underline" onClick={() => setFocus(null)}>
              kembali ke live
            </button>
          </span>
        )}
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" onClick={() => openBacktest(symbol)} title="Buka halaman Backtest dan langsung jalankan untuk koin ini">
          <FlaskConical className="size-3.5" /> Backtest {symbol}
        </Button>
        <span className="text-xs text-muted-foreground">Waktu lokal · bucket candle UTC</span>
      </div>
      {positions.length > 0 && !focus && (
        <div className="flex flex-wrap gap-2">
          {positions.map((t) => (
            <PositionChip key={t.id} t={t} px={lastPx} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {LAYERS.map((k) => (
          <button
            key={k}
            onClick={() => toggle(k)}
            className={cn(
              'rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground',
              layers[k] && 'border-foreground/30 bg-accent text-foreground'
            )}
          >
            {LAYER_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1 rounded-xl border">
        <div ref={box} className="absolute inset-0" />
        {info && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">{info}</div>
        )}
      </div>
      <SetupList setups={setups} />
    </div>
  )
}

/** A pending / open bot trade on the chart: direction, model, running R, and the same cancel / close as the Bot page. */
function PositionChip({ t, px }: { t: BotTrade; px: number | null }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const h = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(h)
  }, [armed])
  const long = t.direction === 'bullish'
  const risk = Math.abs(t.entry - t.slInitial)
  const r = t.status === 'open' && px !== null && risk > 0 ? ((long ? px - t.entry : t.entry - px) / risk) : null
  return (
    <div className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
      <span className={cn('font-semibold', long ? 'text-bull' : 'text-bear')}>{long ? 'LONG' : 'SHORT'}</span>
      <span className="text-muted-foreground">
        {t.model} · {t.mode} · {t.status === 'pending' ? 'limit nunggu' : 'posisi buka'}
        {t.tp === null && t.status === 'open' ? ' · TP manual' : ''}
      </span>
      {r !== null && <span className={cn('num font-semibold', r > 0 ? 'text-bull' : r < 0 ? 'text-bear' : '')}>{r >= 0 ? '+' : ''}{r.toFixed(2)}R</span>}
      {t.status === 'pending' ? (
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => void window.api.invoke('bot:cancel', { id: t.id })}>
          Batalkan limit
        </Button>
      ) : (
        <Button
          size="sm"
          variant={armed ? 'destructive' : 'outline'}
          className="h-6 px-2 text-xs"
          title="Tutup posisi pakai market order (reduce-only), lalu SL/TP dibatalkan"
          onClick={() => {
            if (!armed) return setArmed(true)
            setArmed(false)
            void window.api.invoke('bot:close', { id: t.id })
          }}
        >
          {armed ? 'Yakin? klik lagi' : 'Close market'}
        </Button>
      )}
    </div>
  )
}
