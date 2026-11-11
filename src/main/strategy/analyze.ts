import type { Candle } from '@shared/candles'
import type { SmcConfig } from '@shared/config'
import type { SmcAnalysis } from '@shared/smc'
import type { Timeframe } from '@shared/timeframes'
import { detectFvgs, type FvgIdx } from './fvg'
import { detectLiquidity } from './liquidity'
import { detectOcls } from './ocl'
import { detectOrderBlocks, type OrderBlockIdx } from './orderBlocks'
import { detectQms } from './qm'
import { detectSrFlips } from './srFlip'
import { analyzeStructure, findPivots, type Pivot } from './swings'

/** Analysis plus index-level data the setup detector needs. */
export interface SmcAnalysisFull extends SmcAnalysis {
  candles: readonly Candle[]
  alternating: Pivot[]
  trendAt: SmcAnalysis['trend'][]
  orderBlocksIdx: OrderBlockIdx[]
  fvgsIdx: FvgIdx[]
}

/** Run every detector on one timeframe. Pure: same candles + config → same output (live & backtest). */
export function analyzeSmc(candles: readonly Candle[], timeframe: Timeframe, cfg: SmcConfig): SmcAnalysisFull {
  const pivots = findPivots(candles, cfg.pivot)
  const structure = analyzeStructure(candles, pivots)
  const fvgs = detectFvgs(candles, cfg.fvgMinPct)
  const orderBlocks = detectOrderBlocks(candles, pivots, fvgs, cfg)
  // §6: plain OCL only on HTF (1d/1w by default); lower timeframes keep OCL Break only
  const plainOcl = (cfg.oclPlainTimeframes as string[]).includes(timeframe)
  const ocls = detectOcls(candles, cfg.oclBreakMaxCandles).filter((o) => o.kind === 'OCL_BREAK' || plainOcl)
  return {
    timeframe,
    trend: structure.trend,
    trendChanges: structure.trendChanges,
    swings: structure.swings,
    breaks: structure.breaks,
    orderBlocks,
    fvgs,
    srFlips: detectSrFlips(candles, pivots, fvgs),
    ocls,
    qms: detectQms(candles, structure.alternating, cfg.qmRequireBodyBreak),
    liquidity: detectLiquidity(candles, orderBlocks, structure.alternating, cfg.equalPct),
    candles,
    alternating: structure.alternating,
    trendAt: structure.trendAt,
    orderBlocksIdx: orderBlocks,
    fvgsIdx: fvgs
  }
}

/** Strip index-only fields before sending over IPC. */
export function toPublic(a: SmcAnalysisFull): SmcAnalysis {
  const strip = <T extends object>(x: T, keys: string[]): T =>
    Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k))) as T
  return {
    timeframe: a.timeframe,
    trend: a.trend,
    trendChanges: a.trendChanges,
    swings: a.swings,
    breaks: a.breaks,
    orderBlocks: a.orderBlocks.map((o) => strip(o, ['i', 'confirmedAt'])),
    fvgs: a.fvgs.map((f) => strip(f, ['i'])),
    srFlips: a.srFlips.map((f) => strip(f, ['breakAt'])),
    ocls: a.ocls,
    qms: a.qms,
    liquidity: a.liquidity
  }
}
