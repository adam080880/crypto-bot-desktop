import type { Dir, PoiKind } from './smc'

/**
 * pending  = limit entry (+ SL) placed, waiting for the fill
 * open     = filled, SL + TP working
 * closed   = position flat again (win / loss / other)
 * cancelled = entry never filled (missed / expired / invalid / kill switch / error)
 */
export type BotTradeStatus = 'pending' | 'open' | 'closed' | 'cancelled'

export interface BotTrade {
  id: string
  mode: 'paper' | 'live'
  setupId: string
  symbol: string
  direction: Dir
  poi: { kind: PoiKind; timeframe: string }
  score: number
  /** Claude analysis that allowed the entry. */
  analysisId: string
  confidence: number
  entry: number
  sl: number
  tp: number
  qty: number
  /** Equity used for sizing and the planned loss at the SL (USDT). */
  equity: number
  riskUsd: number
  leverage: number
  status: BotTradeStatus
  /** Why it ended: tp / sl / missed / expired / invalid / kill / manual / error / external. */
  reason: string | null
  createdAt: number
  /** Expiry of the pending limit (setup expiry). */
  expiresAt: number
  filledAt: number | null
  filledQty: number | null
  closedAt: number | null
  exitPrice: number | null
  /** Realised PnL incl. fees (USDT). */
  pnl: number | null
  /** Exchange ids (live). */
  entryOrderId: string | null
  slOrderId: string | null
  tpOrderId: string | null
}

export type BotEventLevel = 'info' | 'skip' | 'order' | 'warn' | 'error'

export interface BotEvent {
  id: number
  t: number
  level: BotEventLevel
  symbol: string | null
  message: string
}

export interface BotState {
  enabled: boolean
  live: boolean
  /** Human-readable reason new entries are blocked right now (null = may enter). */
  blocked: string | null
  equity: number | null
  equityAt: number | null
  /** Realised PnL of trades closed today (UTC). */
  pnlToday: number
  universe: { count: number; updatedAt: number | null }
  /** Symbols waiting for a Claude analysis requested by the bot. */
  awaitingClaude: string[]
  trades: BotTrade[]
  events: BotEvent[]
  lastError: string | null
}

/** One step of the Binance Futures connection test (Bot page). ok = null → skipped. */
export interface ConnCheck {
  id: string
  label: string
  ok: boolean | null
  ms: number | null
  detail: string
}

export interface ConnTestResult {
  at: number
  checks: ConnCheck[]
}
