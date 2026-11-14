/** Screener: scans stored data for entry material (candidates only, never orders). */
import type { ChildKind, Confluence, Dir, EntryModel, PoiKind, PoiOrigin, SetupStatus } from './smc'
import type { Timeframe } from './timeframes'

export type ScreenerTrigger = 'manual' | 'auto' | 'startup'

/** Compact setup for the screener / bot (docs/entry-v2.md). */
export interface ScreenerSetup {
  id: string
  model: EntryModel
  entry: number
  sl: number
  tp: number
  tpLiquidity: number | null
  rr: number
  score: number
  confluence: Confluence[]
  status: Extract<SetupStatus, 'pending' | 'triggered'>
  createdT: number
  /** Parent POI (the reason). */
  poi: { kind: PoiKind; timeframe: Timeframe; origin: PoiOrigin | null }
  /** Where the limit sits. */
  child: { kind: ChildKind; timeframe: Timeframe }
  /** Pending expiry in entry candles when the model has its own (M5). */
  expiryCandles?: number
}

/** One symbol + direction that meets at least one criterion. */
export interface ScreenerRow {
  symbol: string
  direction: Dir
  price: number
  /** Open time of the newest stored 1m candle (data freshness). */
  dataT: number
  /** Best active setup in this direction (highest score, then newest). */
  setup: ScreenerSetup | null
  /** Every active (pending / triggered) setup in this direction, newest first. The bot reads these. */
  setups: ScreenerSetup[]
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
