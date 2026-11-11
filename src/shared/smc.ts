/** Output types of the SMC detectors (docs/smc-rules.md). Times are candle open times (ms, UTC). */
import type { Timeframe } from './timeframes'

export type Dir = 'bullish' | 'bearish'
export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL'

/** §1 swing point (alternating high/low). `confirmedT` = candle on which it became known. */
export interface Swing {
  t: number
  kind: 'high' | 'low'
  price: number
  label: SwingLabel | null
  confirmedT: number
}

/** §2 Break of Structure = trend reversal (materi). */
export interface StructureBreak {
  t: number
  direction: Dir
  level: number
  swingT: number
}

/** §3 Order Block. `line` = entry level at the body edge; [wickEnd, line] = wick liquidity. */
export interface OrderBlock {
  t: number
  direction: Dir
  line: number
  wickEnd: number
  bodyFar: number
  hasFvg: boolean
  prevOpposite: boolean
  confirmedT: number
  hitT: number | null
  invalidT: number | null
  sweptT: number | null
}

/** §4 Fair Value Gap (first of the three candles at `t`). */
export interface Fvg {
  t: number
  direction: Dir
  top: number
  bottom: number
  touchedT: number | null
  filledT: number | null
}

/** §5 RBS (bullish) / SBR (bearish). */
export interface SrFlip {
  kind: 'RBS' | 'SBR'
  direction: Dir
  level: number
  sourceT: number
  breakT: number
  hasFvg: boolean
  hitT: number | null
  invalidT: number | null
}

/** §6 OCL; after a break it becomes OCL_BREAK with the opposite direction. */
export interface Ocl {
  t: number
  kind: 'OCL' | 'OCL_BREAK'
  direction: Dir
  level: number
  breakT: number | null
  hitT: number | null
  invalidT: number | null
}

/** §7 Quasimodo: entry at the first mountain's level. */
export interface Qm {
  direction: Dir
  level: number
  invalidLevel: number
  points: { h1: number; l1: number; h2: number; l2: number } // times; for bullish read as l1,h1,l2,h2
  activeT: number
  hitT: number | null
  invalidT: number | null
}

/** §10 Liquidity: OB wick zones (from the user's definition) and optional swing levels. */
export interface Liquidity {
  kind: 'wick' | 'swing'
  /** 'buy' = buy-side liquidity above highs, 'sell' = sell-side below lows. */
  side: 'buy' | 'sell'
  top: number
  bottom: number
  t: number
  sweptT: number | null
  equal: boolean
}

export interface SmcAnalysis {
  timeframe: Timeframe
  /** Trend as of the last candle (null until the first structure break). */
  trend: Dir | null
  trendChanges: { t: number; trend: Dir }[]
  swings: Swing[]
  breaks: StructureBreak[]
  orderBlocks: OrderBlock[]
  fvgs: Fvg[]
  srFlips: SrFlip[]
  ocls: Ocl[]
  qms: Qm[]
  liquidity: Liquidity[]
}

export type PoiKind = 'OB' | 'RBS' | 'SBR' | 'QM' | 'OCL' | 'OCL_BREAK'

export type SetupStatus = 'pending' | 'triggered' | 'win' | 'loss' | 'invalid' | 'expired'

/** §8 Confirmed entry: POI hit → OB valid on the entry timeframe. A candidate, never an order. */
export interface Setup {
  id: string
  symbol: string
  direction: Dir
  poi: { kind: PoiKind; timeframe: Timeframe; level: number; t: number; hitT: number }
  obValid: { timeframe: Timeframe; t: number; line: number; wickEnd: number; hasFvg: boolean }
  entry: number
  sl: number
  tp: number
  rr: number
  score: number
  reasons: string[]
  /** Candle on which the OB valid was confirmed (setup known from its close). */
  createdT: number
  status: SetupStatus
  statusT: number | null
}
