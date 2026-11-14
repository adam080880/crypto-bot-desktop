import { z } from 'zod'
import { exitConfigSchema, type ExitConfig } from './config'
import { ENTRY_MODELS, REQUIRABLE_CONFLUENCES, type ChildKind, type Confluence, type Dir, type EntryModel, type PoiKind, type PoiOrigin } from './smc'
import type { Timeframe } from './timeframes'

/** Backtest of one symbol over all stored data (Backtest v2, docs/entry-v2.md §5). */
export const backtestParamsSchema = z
  .object({
    symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
    /** Last N days are out-of-sample; everything before is in-sample. */
    oosDays: z.number().int().min(1).max(365).default(60),
    /** Fees in % of notional: limit entry/TP = maker, stops = taker (+ slippage). */
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

/** Outcome of one setup under one exit plan (compact; index = plan order). */
export interface BtResult {
  /** w = win, b = break-even (|R| ≤ 0.05), l = loss, o = still open at the end, m = missed (TP first),
   *  i = invalid, e = expired, p = never filled / still pending. */
  s: 'w' | 'b' | 'l' | 'o' | 'm' | 'i' | 'e' | 'p'
  /** Fill time (entry-TF candle / 1m bar). */
  f: number | null
  /** Exit time. */
  x: number | null
  /** Net R after fees. */
  r: number
}

/** One detected setup with its result under every plan (filters run in the UI). */
export interface BtSetup {
  id: string
  /** Close of the candle on which the setup became known (entry TF open time). */
  t: number
  dir: Dir
  model: EntryModel
  poiKind: PoiKind
  poiTf: Timeframe
  origin: PoiOrigin | null
  childKind: ChildKind
  childTf: Timeframe
  score: number
  conf: Confluence[]
  entry: number
  sl: number
  /** |entry − SL| / entry × 100. */
  slPct: number
  tpLiquidity: number | null
  res: BtResult[]
}

export interface BtPlan {
  key: string
  label: string
  /** The plan as an exit config (saved into a coin profile when chosen). */
  exit: Pick<ExitConfig, 'tpMode' | 'tpR' | 'ladder' | 'trailStepR' | 'trailGapR' | 'orderFlowHold' | 'orderFlowTf' | 'orderFlowSignals' | 'orderFlowWickRatio'>
}

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

export interface BacktestResult {
  version: 2
  symbol: string
  ranAt: number
  ms: number
  dataFrom: number
  dataTo: number
  splitT: number
  /** History shorter than 3× oosDays → split at 2/3 of the data instead. */
  splitAdjusted: boolean
  /** True when stored 1m candles were used for fills/exits (else entry-TF candles). */
  minuteResolution: boolean
  params: Required<BacktestParams>
  /** Rules used by the equity simulation (snapshot of the risk config). */
  risk: { maxLeverage: number; maxDailyLossPct: number }
  plans: BtPlan[]
  /** Open interest / funding history used for the flow confluences (null = not downloaded / failed). */
  flow: { oiFrom: number | null; oiTo: number | null; funding: number } | null
  setups: BtSetup[]
  reactions: ReactionRow[]
}

export interface BacktestProgress {
  symbol: string
  stage: 'load' | 'flow' | 'detect' | 'simulate' | 'done'
  done: number
  total: number
}

/**
 * Coin profile chosen from the backtest "Meta" table (user clicks "Pakai"): the bot then only takes
 * these models / parent POIs on this coin, with this exit plan.
 */
export interface CoinProfile {
  symbol: string
  savedAt: number
  models: EntryModel[]
  /** Parent POIs allowed ("OB|4h"); empty = any. */
  pois: string[]
  requireConfluence: Confluence[]
  minScore: number
  plan: BtPlan
  /** Stats at the time it was saved (for display). */
  stats: { trades: number; winrate: number | null; avgR: number | null; oosTrades: number; oosAvgR: number | null }
}


/** Validation of a profile coming from the renderer. */
export const coinProfileSchema = z
  .object({
    symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
    savedAt: z.number().int(),
    models: z.array(z.enum(ENTRY_MODELS)).min(1),
    pois: z.array(z.string().regex(/^[A-Z_]{2,10}\|(1m|5m|15m|1h|4h|1d|1w)$/)).max(50),
    requireConfluence: z.array(z.enum(REQUIRABLE_CONFLUENCES)).max(16),
    minScore: z.number().int().min(0).max(30),
    plan: z.object({
      key: z.string().max(30),
      label: z.string().max(100),
      exit: exitConfigSchema.pick({ tpMode: true, tpR: true, ladder: true, trailStepR: true, trailGapR: true, orderFlowHold: true, orderFlowTf: true, orderFlowSignals: true, orderFlowWickRatio: true })
    }),
    stats: z.object({ trades: z.number(), winrate: z.number().nullable(), avgR: z.number().nullable(), oosTrades: z.number(), oosAvgR: z.number().nullable() })
  })
  .strict()
