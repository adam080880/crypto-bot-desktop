import type { ExitConfig } from './config'
import type { Confluence, Dir, EntryModel, PoiKind } from './smc'

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
  /** Entry model (docs/entry-v2.md); old rows default to M0. */
  model: EntryModel
  confluence: Confluence[]
  poi: { kind: PoiKind; timeframe: string }
  score: number
  /** Claude analysis that allowed the entry (null when bot.requireClaude is off). */
  analysisId: string | null
  confidence: number | null
  entry: number
  /** Current stop (moves with the tiered exit / order flow). */
  sl: number
  /** Stop at entry; 1R = |entry − slInitial|. */
  slInitial: number
  /** null = no TP order (tpMode 'trail': ladder / trailing / manual close only). */
  tp: number | null
  qty: number
  /** Quantity already closed by ladder partials. */
  closedQty: number
  /** PnL booked by those partials (USDT, after fees; paper). */
  realized: number
  /** Ladder partial fills applied so far. */
  partials: number
  /** Stop order generation (live: new algo id per move). */
  slSeq: number
  /** Exit plan frozen at entry (null for trades from before the tiered exit). */
  exitPlan: (Pick<ExitConfig, 'ladder' | 'trailStepR' | 'trailGapR' | 'orderFlowHold' | 'orderFlowTf' | 'orderFlowSignals' | 'orderFlowWickRatio'> & Partial<Pick<ExitConfig, 'tightSlPct' | 'tightBeAtR' | 'tightBeLockR'>>) | null
  /** Live view of the exit: best R so far and whether the order flow is holding the position. */
  exitState: { bestR: number; holding: boolean; holds: number } | null
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

export type BotOutcome = 'win' | 'be' | 'loss'

/** |R| below this counts as break-even (fees / slippage around a BE stop). */
export const BE_BAND_R = 0.15

/** Net R of a closed trade (PnL ÷ planned loss at the initial SL). */
export const tradeR = (t: Pick<BotTrade, 'pnl' | 'riskUsd'>): number | null => (t.pnl === null || !(t.riskUsd > 0) ? null : t.pnl / t.riskUsd)

/**
 * Result of a closed trade. A stop that had been moved to entry or beyond (break-even incl. fees)
 * and closes within ±BE_BAND_R is BE, not a loss; any other trade within that band is BE too.
 */
export function tradeOutcome(t: Pick<BotTrade, 'status' | 'pnl' | 'riskUsd' | 'direction' | 'entry' | 'sl'>): BotOutcome | null {
  if (t.status !== 'closed') return null
  const r = tradeR(t)
  if (r === null) return null
  const stopAtBe = t.direction === 'bullish' ? t.sl >= t.entry : t.sl <= t.entry
  if (Math.abs(r) < BE_BAND_R || (stopAtBe && r <= 0 && r > -0.3)) return 'be'
  return r > 0 ? 'win' : 'loss'
}
