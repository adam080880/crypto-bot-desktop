import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
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
import type { Timeframe } from '@shared/timeframes'
import { LiveBadge } from '@/components/layout/LiveBadge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']
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

  // stream this symbol while the chart is open
  useEffect(() => {
    void window.api.invoke('live:setChart', { symbol })
    return () => void window.api.invoke('live:setChart', { symbol: null })
  }, [symbol])

  // load history
  useEffect(() => {
    let cancelled = false
    void window.api.invoke('candles:get', { symbol, timeframe: tf, limit: LIMIT }).then((rows) => {
      if (cancelled || !price.current || !volume.current) return
      price.current.setData(rows.map(toBar))
      volume.current.setData(rows.map(toVol))
      last.current = rows[rows.length - 1] ?? null
      setInfo(rows.length ? null : 'Belum ada data untuk simbol ini — sedang disiapkan (backfill 6 bulan)…')
      chart.current?.timeScale().scrollToRealTime()
    })
    return () => {
      cancelled = true
    }
  }, [symbol, tf, reload])

  // live updates
  useEffect(() => {
    const offCandle = window.api.on('live:candle', (e) => {
      if (e.symbol !== symbol || !price.current || !volume.current) return
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
    })
    const offSynced = window.api.on('live:synced', ({ symbol: s }) => {
      if (s === symbol) setReload((n) => n + 1)
    })
    return () => {
      offCandle()
      offSynced()
    }
  }, [symbol, tf])

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
        <span className="ml-auto text-xs text-muted-foreground">Waktu lokal · bucket candle UTC</span>
      </div>
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
