import type { BotConfig, ClaudeConfig, DataConfig, ExitConfig, NewsConfig, RadarConfig, RiskConfig, ScreenerConfig, SmcConfig } from '@shared/config'
import type { RadarHit, RadarState } from '@shared/radar'
import type { BotState } from '@shared/bot'
import type { CoinProfile } from '@shared/backtest'
import type { ClaudeState } from '@shared/claude'
import type { NewsState } from '@shared/news'
import type { ScreenerState } from '@shared/screener'
import type { RotationCommand, RotationState } from '@shared/rotation'
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
  screener: ScreenerConfig
  bot: BotConfig
  exit: ExitConfig
  radar: RadarConfig
  /** Coin profiles from the backtest Meta table (symbol → allowed models / POIs / exit plan). */
  profiles: Record<string, CoinProfile>
  risk: RiskConfig
  killSwitch: boolean
  /** Binance trade keys (decrypted in main), only when both are stored. */
  binance: { key: string; secret: string } | null
  /** Decrypted in main (safeStorage is main-only); held in memory by the worker. */
  blsApiKey: string | null
  anthropicApiKey: string | null
  /** Resolved Claude Code executable (installed `claude`), or null when not found. */
  claudeExecutable: string | null
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
  | { type: 'screener-run' }
  | { type: 'rotation-cmd'; command: RotationCommand }
  | { type: 'bot-kill' }
  | { type: 'bot-cancel'; id: string }
  | { type: 'bot-retry'; id: string }
  | { type: 'bot-close'; id: string }
  | { type: 'bot-reset-paper' }

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
  | { type: 'screener-state'; state: ScreenerState }
  | { type: 'rotation-state'; state: RotationState }
  | { type: 'bot-state'; state: BotState }
  | { type: 'radar-state'; state: RadarState }
  | { type: 'radar-hits'; hits: RadarHit[] }
