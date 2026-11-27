import type { Candle } from '@shared/candles'
import type { SmcConfig } from '@shared/config'
import type { SmcAnalysis } from '@shared/smc'
import type { Timeframe } from '@shared/timeframes'
import { detectFvgs, type FvgIdx } from './fvg'
import { detectLiquidity, detectLuxLiquidity, type LuxPool } from './liquidity'
import { detectOcls } from './ocl'
import { detectOrderBlocks, type OrderBlockIdx } from './orderBlocks'
import { detectQms } from './qm'
import { detectSrFlips } from './srFlip'
import { analyzeStructure, findPivots, type Pivot } from './swings'
import { atrSeries } from './atr'
import { detectWyckoff } from './wyckoff'

/** Analysis plus index-level data the setup detector needs. */
export interface SmcAnalysisFull extends SmcAnalysis {
  candles: readonly Candle[]
  alternating: Pivot[]
  trendAt: SmcAnalysis['trend'][]
  orderBlocksIdx: OrderBlockIdx[]
  fvgsIdx: FvgIdx[]
  /** Raw pivots (cfg.pivot), before the alternating filter (needed to see which swing got swept). */
  pivots: Pivot[]
  /** LuxAlgo BSL/SSL pools (only when cfg.m2Liquidity = 'lux', else empty). */
  luxLiq: LuxPool[]
  /** Small-structure pivots (cfg.ltfPivot) for CHoCH on the entry TF. */
  ltfPivots: Pivot[]
  atr: number[]
}

/** Run every detector on one timeframe. Pure: same candles + config → same output (live & backtest). */
export function analyzeSmc(candles: readonly Candle[], timeframe: Timeframe, cfg: SmcConfig): SmcAnalysisFull {
  const pivots = findPivots(candles, cfg.pivot)
  const structure = analyzeStructure(candles, pivots)
  const fvgs = detectFvgs(candles, cfg.fvgMinPct)
  const orderBlocks = detectOrderBlocks(candles, pivots, fvgs, cfg)
  const atr = atrSeries(candles, cfg.atrPeriod)
  const wyckoff = (cfg.wyckoffTimeframes as string[]).includes(timeframe)
    ? detectWyckoff(candles, timeframe, atr, { rangeCandles: cfg.wyRangeCandles, rangeAtr: cfg.wyRangeAtr, reclaimCandles: cfg.sweepReclaimCandles })
    : []
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
    qms: detectQms(candles, structure.alternating, cfg.qmRequireBodyBreak, cfg.qmRequireCloseBreak),
    liquidity: detectLiquidity(candles, orderBlocks, structure.alternating, cfg.equalPct),
    wyckoff,
    candles,
    alternating: structure.alternating,
    trendAt: structure.trendAt,
    orderBlocksIdx: orderBlocks,
    fvgsIdx: fvgs,
    pivots,
    ltfPivots: cfg.ltfPivot === cfg.pivot ? pivots : findPivots(candles, cfg.ltfPivot),
    luxLiq: cfg.m2Liquidity === 'lux' ? detectLuxLiquidity(candles) : [],
    atr
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
    orderBlocks: a.orderBlocks.map((o) => strip(o, ['i', 'confirmedAt', 'fvgKnownAt'])),
    fvgs: a.fvgs.map((f) => strip(f, ['i'])),
    srFlips: a.srFlips.map((f) => strip(f, ['breakAt'])),
    ocls: a.ocls,
    qms: a.qms,
    liquidity: a.liquidity,
    wyckoff: a.wyckoff
  }
}
