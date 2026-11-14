/** Screener: scans stored data for entry material (candidates only, never orders). */
import type { Dir, PoiKind, SetupStatus } from './smc'
import type { Timeframe } from './timeframes'

export type ScreenerTrigger = 'manual' | 'auto' | 'startup'

/** One symbol + direction that meets at least one criterion. */
export interface ScreenerRow {
  symbol: string
  direction: Dir
  price: number
  /** Open time of the newest stored 1m candle (data freshness). */
  dataT: number
  /** Active §8 setup (POI hit → OB valid) in this direction, newest one. */
  setup: {
    id: string
    entry: number
    sl: number
    tp: number
    rr: number
    score: number
    status: Extract<SetupStatus, 'pending' | 'triggered'>
    createdT: number
    poi: { kind: PoiKind; timeframe: Timeframe }
  } | null
  /** Nearest active POI on the entry side of price, within `nearPoiPct`. */
  nearPoi: { kind: PoiKind; timeframe: Timeframe; level: number; distPct: number } | null
  /** 4h, 1h and 15m trend all equal `direction`. */
  trendAligned: boolean
  trend: { '4h': Dir | null; '1h': Dir | null; '15m': Dir | null }
  /** Most recent BOS in this direction within `bosRecentHours`. */
  recentBos: { timeframe: Timeframe; level: number; t: number } | null
}

export interface ScreenerRun {
  trigger: ScreenerTrigger
  startedAt: number
  finishedAt: number
  scanned: number
  /** Symbols skipped because their newest candle is older than `maxDataAgeMin`. */
  stale: number
  errors: number
}

export interface ScreenerState {
  running: boolean
  progress: { done: number; total: number } | null
  lastRun: ScreenerRun | null
  rows: ScreenerRow[]
  lastError: string | null
}
