import type { DataConfig } from '@shared/config'
import type { LiveCandleEvent, LiveState } from '@shared/live'
import type { AutoSyncState, BackfillEstimate, BackfillEvent } from '@shared/sync'

export interface WorkerInit {
  dbPath: string
  migrationsFolder: string
  logsDir: string
}

export interface ServiceConfig {
  data: DataConfig
  watchlist: string[]
}

export type ToWorker =
  | { type: 'start-services'; config: ServiceConfig }
  | { type: 'config'; config: ServiceConfig }
  | { type: 'run'; symbols?: string[]; limit?: number; data: DataConfig }
  | { type: 'estimate'; data: DataConfig }
  | { type: 'cancel' }
  | { type: 'sync-now' }
  | { type: 'set-chart'; symbol: string | null }
  | { type: 'set-positions'; symbols: string[] }

export type FromWorker =
  | { type: 'event'; event: BackfillEvent }
  | { type: 'estimate'; estimate: BackfillEstimate }
  | { type: 'estimate-error'; error: string }
  | { type: 'idle' }
  | { type: 'live-state'; state: LiveState }
  | { type: 'live-candle'; event: LiveCandleEvent }
  | { type: 'live-synced'; symbol: string }
  | { type: 'autosync'; state: AutoSyncState }
