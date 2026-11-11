import type { AppConfig, ConfigPatch, TradingMode } from './config'
import type { Candle } from './candles'
import type { LiveCandleEvent, LiveState } from './live'
import type { Setup, SmcAnalysis } from './smc'
import type { ClaudeAnalysis, ClaudeRun, ClaudeState } from './claude'
import type { EconomicEvent, EventReaction, NewsCandidate, NewsState, ReactionStat } from './news'
import type { AutoSyncState, BackfillEstimate, BackfillEvent, BackfillSummary } from './sync'
import type { Timeframe } from './timeframes'

/** Names of secrets that may be stored via safeStorage. */
export const SECRET_NAMES = ['binance.apiKey', 'binance.apiSecret', 'anthropic.apiKey', 'bls.apiKey'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export type ConnectionStatus = 'unknown' | 'connected' | 'disconnected'
export type SyncStatus = 'idle' | 'syncing' | 'error'

export interface AppStatus {
  mode: TradingMode
  connection: ConnectionStatus
  sync: { status: SyncStatus; upToDate: number; total: number }
  live: LiveState
  news: NewsState | null
  claude: ClaudeState | null
  /** True after the kill switch is pressed; bot stays halted until manually resumed. */
  killSwitch: { active: boolean; at: number | null }
  dbPath: string
  version: string
}

export interface SecretStatus {
  name: SecretName
  stored: boolean
  updatedAt: number | null
}

export type SyncStartRequest = { mode: 'test' } | { mode: 'all' } | { mode: 'symbols'; symbols: string[] }

export interface SyncUiState {
  running: boolean
  progress: Extract<BackfillEvent, { type: 'progress' }> | null
  lastSummary: BackfillSummary | null
  lastError: string | null
}

export interface StorageInfo {
  dbPath: string
  dataDir: string
  isDefault: boolean
  defaultDir: string
  envOverride: boolean
  dbBytes: number
  freeBytes: number | null
}

/** Invoke channels (renderer → main, request/response). */
export interface IpcInvokeMap {
  'app:getStatus': { req: void; res: AppStatus }
  'bot:killSwitch': { req: void; res: AppStatus }
  'bot:resume': { req: void; res: AppStatus }
  'config:get': { req: void; res: AppConfig }
  'config:update': { req: ConfigPatch; res: AppConfig }
  'secrets:list': { req: void; res: SecretStatus[] }
  'secrets:set': { req: { name: SecretName; value: string }; res: SecretStatus[] }
  'secrets:delete': { req: { name: SecretName }; res: SecretStatus[] }
  'secrets:encryptionAvailable': { req: void; res: boolean }
  'sync:getState': { req: void; res: SyncUiState }
  'sync:start': { req: SyncStartRequest; res: SyncUiState }
  'sync:cancel': { req: void; res: void }
  'sync:estimate': { req: void; res: BackfillEstimate }
  'sync:autoState': { req: void; res: AutoSyncState | null }
  'sync:now': { req: void; res: void }
  'symbols:list': { req: void; res: SymbolListItem[] }
  'candles:get': { req: CandlesRequest; res: Candle[] }
  'live:setChart': { req: { symbol: string | null }; res: void }
  'smc:analyze': { req: { symbol: string; timeframe: Timeframe; limit: number }; res: SmcAnalysis | null }
  'smc:setups': { req: { symbol: string }; res: Setup[] }
  'news:list': { req: { from: number; to: number }; res: EconomicEvent[] }
  'news:candidates': { req: void; res: NewsCandidate[] }
  'news:reactions': { req: { eventId: string }; res: EventReaction[] }
  'news:stats': { req: void; res: ReactionStat[] }
  'news:refresh': { req: void; res: void }
  'news:setActual': { req: { id: string; value: number | null }; res: void }
  'claude:list': { req: void; res: { runs: ClaudeRun[]; analyses: ClaudeAnalysis[] } }
  'claude:run': { req: void; res: void }
  'storage:get': { req: void; res: StorageInfo }
  'storage:chooseDir': { req: void; res: string | null }
  'storage:plan': { req: { dir: string }; res: { ok: boolean; error?: string; targetHasDb: boolean; needBytes: number; freeBytes: number | null } }
  'storage:move': { req: { dir: string; mode: 'move' | 'useExisting' }; res: { restarting: boolean } }
}

export interface SymbolListItem {
  symbol: string
  /** 1m history exists locally. */
  synced: boolean
}

export interface CandlesRequest {
  symbol: string
  timeframe: Timeframe
  limit: number
  /** Only candles with open time ≤ this (ms). Omit for the latest. */
  before?: number
}

/** Event channels (main → renderer, push). */
export interface IpcEventMap {
  'app:status': AppStatus
  'sync:event': { event: BackfillEvent; ui: SyncUiState }
  'live:candle': LiveCandleEvent
  'live:synced': { symbol: string }
  'news:changed': { at: number }
  'claude:changed': { at: number }
  'storage:progress': { fraction: number; phase: 'stopping' | 'copying' | 'restarting' | 'error'; error?: string }
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

/** Shape exposed on window.api by the preload script. */
export interface PreloadApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: IpcInvokeMap[C]['req'] extends void ? [] : [IpcInvokeMap[C]['req']]
  ): Promise<IpcInvokeMap[C]['res']>
  on<C extends EventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void
}

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:getStatus',
  'bot:killSwitch',
  'bot:resume',
  'config:get',
  'config:update',
  'secrets:list',
  'secrets:set',
  'secrets:delete',
  'secrets:encryptionAvailable',
  'sync:getState',
  'sync:start',
  'sync:cancel',
  'sync:estimate',
  'sync:autoState',
  'sync:now',
  'symbols:list',
  'candles:get',
  'live:setChart',
  'smc:analyze',
  'smc:setups',
  'news:list',
  'news:candidates',
  'news:reactions',
  'news:stats',
  'news:refresh',
  'news:setActual',
  'claude:list',
  'claude:run',
  'storage:get',
  'storage:chooseDir',
  'storage:plan',
  'storage:move'
]
export const EVENT_CHANNELS: readonly EventChannel[] = ['app:status', 'sync:event', 'live:candle', 'live:synced', 'news:changed', 'claude:changed', 'storage:progress']
