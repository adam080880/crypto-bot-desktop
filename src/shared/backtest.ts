import { z } from 'zod'
import type { Dir, PoiKind } from './smc'
import type { Timeframe } from './timeframes'

/** Backtest of one symbol over all stored data (the symbol open on the chart). */
export const backtestParamsSchema = z
  .object({
    symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
    /** Last N days are out-of-sample; everything before is in-sample. */
    oosDays: z.number().int().min(1).max(365).default(60),
    /** Fees in % of notional: limit entry/TP = maker, SL = taker (+ slippage). */
    makerFeePct: z.number().min(0).max(1).default(0.02),
    takerFeePct: z.number().min(0).max(1).default(0.05),
    slippagePct: z.number().min(0).max(2).default(0.02),
    /** Equity simulation (risk per trade comes from bot.riskPerTradePct unless overridden). */
    startEquity: z.number().positive().max(1e9).default(1000),
    riskPerTradePct: z.number().positive().max(100).optional(),
    /** POI reaction test: how long after the touch the race may run. */
    reactionHours: z.number().int().min(1).max(240).default(24)
  })
  .strict()
export type BacktestParams = z.infer<typeof backtestParamsSchema>

export type PeriodKey = 'all' | 'is' | 'oos'

/** Outcome stats of closed setups (win/loss), in R after fees. */
export interface TradeStats {
  trades: number
  wins: number
  winrate: number | null
  /** Average net R per trade (expectancy). */
  avgR: number | null
  totalR: number
  profitFactor: number | null
  /** Max drawdown of the cumulative R curve (positive number). */
  maxDdR: number
  avgRr: number | null
}

export interface SetupFunnel {
  setups: number
  win: number
  loss: number
  /** Filled but still open at the end of the data. */
  open: number
  pending: number
  missed: number
  invalid: number
  expired: number
}

export interface GroupRow {
  key: string
  stats: Record<PeriodKey, TradeStats>
}

export type BreakdownKey = 'poiKind' | 'poiTf' | 'score' | 'fvg' | 'direction'

export interface ReactionRow {
  kind: PoiKind
  timeframe: Timeframe
  /** POIs that became active inside the data (touched or not). */
  pois: number
  touches: number
  /** Race from the POI level: +X% in the POI direction before −X% through it, per threshold. */
  race: { pct: number; win: number; loss: number; timeout: number }[]
  /** Touched POIs invalidated (close through) within the reaction window. */
  invalidated: number
  medianMfePct: number | null
  medianMaePct: number | null
}

export interface EquitySim {
  startEquity: number
  endEquity: number
  returnPct: number
  maxDdPct: number
  riskPerTradePct: number
  taken: number
  /** Skipped because a position on this symbol was still open. */
  skippedOpen: number
  /** Skipped because the daily loss limit had halted trading that UTC day. */
  skippedHalt: number
  /** Trades whose size was reduced by the max leverage cap. */
  leverageCapped: number
  maxLosingStreak: number
  curve: { t: number; equity: number }[]
}

export interface BacktestResult {
  symbol: string
  ranAt: number
  ms: number
  dataFrom: number
  dataTo: number
  splitT: number
  /** History shorter than 3× oosDays → split at 2/3 of the data instead. */
  splitAdjusted: boolean
  params: Required<BacktestParams>
  /** Rules used by the equity simulation (snapshot of the risk config). */
  risk: { maxLeverage: number; maxDailyLossPct: number }
  funnel: Record<PeriodKey, SetupFunnel>
  stats: Record<PeriodKey, TradeStats>
  /** Same trades without fees/slippage, to show how much the costs take. */
  grossStats: Record<PeriodKey, TradeStats>
  breakdown: Record<BreakdownKey, GroupRow[]>
  equity: EquitySim
  reactions: ReactionRow[]
  /** Last closed trades, newest first (for a quick sanity check against the chart). */
  recent: {
    direction: Dir
    poi: string
    score: number
    entry: number
    sl: number
    tp: number
    rr: number
    filledT: number
    exitT: number
    r: number
  }[]
}
