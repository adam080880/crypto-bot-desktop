import type { Timeframe } from './timeframes'

export interface BackfillSummary {
  kind: 'backfill' | 'catchup'
  startedAt: number
  finishedAt: number
  symbols: number
  completed: number
  rows: Record<Timeframe, number>
  bytesDownloaded: number
  restRequests: number
  errors: { symbol: string; error: string }[]
  aborted: boolean
  /** Total span of 1m history fetched in this run, summed over symbols (ms). */
  oneMinuteSpanMs: number
}

export type BackfillKind = 'backfill' | 'catchup'

export type BackfillEventBody =
  | { type: 'start'; total: number; symbols: string[] }
  | {
      type: 'progress'
      index: number
      total: number
      symbol: string
      timeframe: string
      step: string
      completed: number
      fraction: number
      etaMs: number | null
      bytesDownloaded: number
    }
  | { type: 'symbol-done'; index: number; total: number; symbol: string; ms: number }
  | { type: 'symbol-error'; index: number; total: number; symbol: string; error: string }
  | { type: 'done'; summary: BackfillSummary }
  | { type: 'fatal'; error: string }

export type BackfillEvent = BackfillEventBody & { kind: BackfillKind }

export interface TableSize {
  timeframe: Timeframe
  rows: number
  bytes: number
  bytesPerRow: number | null
}

export interface BackfillEstimate {
  activeSymbols: number
  measuredOn: { symbols: number; rows1m: number; seconds: number; concurrency: number } | null
  tables: (TableSize & { projectedRows: number; projectedBytes: number })[]
  projectedDbBytes: number
  projectedDownloadBytes: number | null
  projectedSeconds: number | null
  restWeightMinutes: number
  notes: string[]
}

export interface AutoSyncState {
  enabled: boolean
  running: boolean
  /** Tracked symbols whose 1m data is current. */
  upToDate: number
  total: number
  lastRunAt: number | null
  nextRunAt: number | null
  lastError: string | null
  /** Binance reachable on the last catch-up (null = unknown yet). */
  reachable: boolean | null
  fullBackfillDone: boolean
}
