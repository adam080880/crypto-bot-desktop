import { z } from 'zod'

/**
 * Momentum rotation, PAPER ONLY (user, 2026-11-14): forward test of cross-sectional momentum.
 * Lab (docs/entry-v2.md §11): in-sample strong, out-of-sample depends on the rebalance weekday and
 * drawdowns are 35–60 %, so it never sends orders — this page only tracks it going forward.
 */
export const rotationConfigSchema = z
  .object({
    /** Rank by the return over the last N days (daily closes). */
    lookbackDays: z.number().int().min(7).max(180).default(75),
    /** Coins per side (long the N strongest; with longShort also short the N weakest). */
    perSide: z.number().int().min(1).max(20).default(8),
    longShort: z.boolean().default(true),
    /** Universe = the N most traded crypto perpetuals by 30-day quote volume at that time. */
    universe: z.number().int().min(10).max(200).default(60),
    /** Skip coins listed less than N days ago (new-listing pumps). */
    minAgeDays: z.number().int().min(0).max(365).default(60),
    /** 0 = Sunday … 6 = Saturday; rebalanced at 00:30 UTC on that day, from the previous daily close. */
    rebalanceWeekday: z.number().int().min(0).max(6).default(1),
    startEquity: z.number().positive().max(1e9).default(1000),
    /** Per side of every trade (taker 0.05 % + slippage 0.02 %). */
    costPct: z.number().min(0).max(2).default(0.07)
  })
  .strict()
export type RotationConfig = z.infer<typeof rotationConfigSchema>

export interface RotationPosition {
  symbol: string
  side: 'long' | 'short'
  /** Signed units (negative = short). */
  qty: number
  entryPrice: number
  /** Close used at the last mark. */
  lastPrice: number
  /** Funding paid (−) / received (+) since entry, USDT. */
  funding: number
}

export interface RotationRankRow {
  symbol: string
  /** Return over lookbackDays (0.12 = +12 %). */
  ret: number
  /** 30-day quote volume (USDT, ≈ volume × close). */
  volume: number
}

export interface RotationRebalance {
  /** Day (UTC midnight, ms) whose previous close was used. */
  t: number
  equity: number
  longs: string[]
  shorts: string[]
  /** Sum of |notional change| / equity. */
  turnover: number
  cost: number
}

export interface RotationState {
  config: RotationConfig
  /** Paper test running (forward). Never sends orders. */
  running: boolean
  startedAt: number | null
  equity: number
  peak: number
  maxDdPct: number
  positions: RotationPosition[]
  /** One point per daily mark: equity and BTC close (benchmark). */
  curve: { t: number; equity: number; btc: number | null }[]
  rebalances: RotationRebalance[]
  /** Latest ranking of the universe (strongest first). */
  ranking: { t: number; rows: RotationRankRow[] } | null
  /** Day (UTC midnight, ms) of the last processed daily close. */
  lastDay: number | null
  nextRebalanceAt: number | null
  lastError: string | null
}

export type RotationCommand =
  | { cmd: 'start'; config: RotationConfig }
  | { cmd: 'stop' }
  | { cmd: 'reset' }
  | { cmd: 'refresh' }

export const rotationCommandSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('start'), config: rotationConfigSchema }),
  z.object({ cmd: z.literal('stop') }),
  z.object({ cmd: z.literal('reset') }),
  z.object({ cmd: z.literal('refresh') })
])
