import type { Dir, PoiKind, PoiOrigin } from './smc'
import type { Timeframe } from './timeframes'

/**
 * POI anatomy + liquidity draw (user 2026-11-23: "bangun insting dengan rumus matematis" — why a POI formed, why it is
 * (not) high probability; price moves from liquidity A to B and back). Layer 1 + 2, deterministic, no ML.
 */

/** A resting liquidity pool: unswept swing (equal = several touches), or the previous day / week high / low. */
export interface LiqPool {
  price: number
  /** 'buy' = above highs (BSL), 'sell' = below lows (SSL). */
  side: 'buy' | 'sell'
  tf: Timeframe
  kind: 'swing' | 'equal' | 'pdh' | 'pdl' | 'pwh' | 'pwl'
  /** Timeframe weight × (2 for equal) × age factor (pools merged within 0.15 % add up). */
  weight: number
  /** Hours since the pool became known. */
  ageH: number
}

export interface StoryFact {
  /** cause = why it formed, push = displacement, fuel = freshness / inducement, context = trend / zone, draw = A → B. */
  kind: 'cause' | 'push' | 'fuel' | 'context' | 'draw'
  text: string
  /** +1 supports the POI, −1 against it, 0 information. */
  sign: 1 | -1 | 0
}

/**
 * Numeric form of the facts (layer 3 inputs). Missing ≈ neutral: see EMPTY_FEATURES. Signed trends: +1 with, −1 against.
 */
export interface StoryFeatures {
  /** Weight of the biggest pool (≥ POI TF) the origin candle swept; 0 = none. */
  sweepW: number
  /** log2(pool TF / POI TF) + 1 of that pool (1 = same TF); 0 = none. */
  sweepTfRatio: number
  sweepEqual: number
  /** Only smaller-TF pools swept. */
  smallSweep: number
  htfTap: number
  noCause: number
  /** Biggest body ÷ ATR in the leg. */
  disp: number
  fvg: number
  fvgOpen: number
  bos: number
  touches: number
  bait: number
  idm: number
  extremePoi: number
  trendOwn: number
  trend1d: number
  btc4h: number
  /** 0 = deep in the favourable half of the range, 1 = at the wrong extreme. */
  pdBad: number
  /** Distance to B in R (cap 20); 0 with noTarget. */
  targetR: number
  targetW: number
  noTarget: number
  blockers: number
  /** Nearest open opposite FVG in R (20 = none). */
  irlR: number
  /** Unswept pool beyond the stop within 1R, distance in R (2 = none). */
  behindSlR: number
}

export const EMPTY_FEATURES: StoryFeatures = {
  sweepW: 0, sweepTfRatio: 0, sweepEqual: 0, smallSweep: 0, htfTap: 0, noCause: 0, disp: 0, fvg: 0, fvgOpen: 0, bos: 0, touches: 0,
  bait: 0, idm: 0, extremePoi: 0, trendOwn: 0, trend1d: 0, btc4h: 0, pdBad: 0.5, targetR: 0, targetW: 0, noTarget: 0, blockers: 0,
  irlR: 20, behindSlR: 2
}

export interface PoiStory {
  id: string
  kind: PoiKind
  timeframe: Timeframe
  direction: Dir
  level: number
  extreme: number | null
  origin: PoiOrigin | null
  /** Distance from the current price, % (positive = price must travel that far to reach it). */
  distPct: number
  /** Touches of the line since it became known (0 = fresh). */
  touches: number
  facts: StoryFact[]
  /** A: liquidity taken by the candle that created the POI. */
  taken: LiqPool[]
  /** B: the strongest draw in the trade direction (weight ÷ distance in R), with its distance from the POI line. */
  target: (LiqPool & { distR: number }) | null
  /** Nearest open opposite FVG in the trade direction (internal range liquidity). */
  irl: { price: number; tf: Timeframe; distR: number } | null
  /** Active opposite POIs (≥ 1h) between the line and B. */
  blockers: number
  /** Nearest unswept pool on the stop side within 1R beyond the stop (price may hunt it first). */
  behindSl: (LiqPool & { distR: number }) | null
  /** Numeric features (layer 3). */
  x: StoryFeatures
  plus: number
  minus: number
}

export interface StoryResult {
  symbol: string
  price: number
  at: number
  stories: PoiStory[]
  /** Strongest unswept pools above / below the price (for the "peta liquidity" list). */
  pools: { buy: LiqPool[]; sell: LiqPool[] }
}
