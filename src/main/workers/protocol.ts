import type { ClaudeConfig, DataConfig, NewsConfig, SmcConfig } from '@shared/config'
import type { ClaudeState } from '@shared/claude'
import type { NewsState } from '@shared/news'
import type { LiveCandleEvent, LiveState } from '@shared/live'
import type { AutoSyncState, BackfillEstimate, BackfillEvent } from '@shared/sync'

export interface WorkerInit {
  dbPath: string
  migrationsFolder: string
  logsDir: string
  /** docs/ folder (smc-rules.md) — app root in dev, resources in packaged builds. */
  docsDir: string
  /** Empty working directory for the Claude Code CLI. */
  claudeWorkDir: string
}

export interface ServiceConfig {
  data: DataConfig
  watchlist: string[]
  news: NewsConfig
  smc: SmcConfig
  claude: ClaudeConfig
  /** Decrypted in main (safeStorage is main-only); held in memory by the worker. */
  blsApiKey: string | null
  anthropicApiKey: string | null
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
  | { type: 'news-refresh' }
  | { type: 'news-set-actual'; id: string; value: number | null }
  | { type: 'claude-run' }

export type FromWorker =
  | { type: 'event'; event: BackfillEvent }
  | { type: 'estimate'; estimate: BackfillEstimate }
  | { type: 'estimate-error'; error: string }
  | { type: 'idle' }
  | { type: 'live-state'; state: LiveState }
  | { type: 'live-candle'; event: LiveCandleEvent }
  | { type: 'live-synced'; symbol: string }
  | { type: 'autosync'; state: AutoSyncState }
  | { type: 'news-state'; state: NewsState }
  | { type: 'news-changed' }
  | { type: 'claude-state'; state: ClaudeState }
  | { type: 'claude-changed' }
