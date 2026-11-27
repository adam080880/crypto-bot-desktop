import type { Candle } from '@shared/candles'
import type { Dir } from '@shared/smc'

/**
 * Premium / discount (user, 2026-11-16): where `price` sits in the dealing range = high/low of the
 * `lookback` candles ending at index `i` (inclusive, all closed). 0 = range low, 1 = range high;
 * values outside 0–1 mean price is beyond the range. null = not enough candles / flat range.
 */
export function rangePosition(c: readonly Candle[], i: number, lookback: number, price: number): number | null {
  if (i < 0 || i >= c.length || i + 1 < Math.min(lookback, 10)) return null
  let hi = -Infinity
  let lo = Infinity
  for (let m = Math.max(0, i - lookback + 1); m <= i; m++) {
    if (c[m]!.h > hi) hi = c[m]!.h
    if (c[m]!.l < lo) lo = c[m]!.l
  }
  return hi > lo ? (price - lo) / (hi - lo) : null
}

/** Long only in discount (≤ level), short only in premium (≥ 1 − level). */
export const inTradeZone = (pos: number, dir: Dir, level: number): boolean => (dir === 'bullish' ? pos <= level : pos >= 1 - level)

export interface Bollinger {
  mid: number[]
  upper: number[]
  lower: number[]
  /** (upper − lower) / mid. */
  width: number[]
}

/** Bollinger bands of the closes (SMA ± k × population std dev). NaN until `period` candles exist. */
export function bollinger(c: readonly Candle[], period: number, k: number): Bollinger {
  const n = c.length
  const mid = new Array<number>(n).fill(NaN)
  const upper = new Array<number>(n).fill(NaN)
  const lower = new Array<number>(n).fill(NaN)
  const width = new Array<number>(n).fill(NaN)
  let sum = 0
  let sq = 0
  for (let i = 0; i < n; i++) {
    const x = c[i]!.c
    sum += x
    sq += x * x
    if (i >= period) {
      const y = c[i - period]!.c
      sum -= y
      sq -= y * y
    }
    if (i < period - 1) continue
    const m = sum / period
    const sd = Math.sqrt(Math.max(0, sq / period - m * m))
    mid[i] = m
    upper[i] = m + k * sd
    lower[i] = m - k * sd
    width[i] = m > 0 ? (2 * k * sd) / m : NaN
  }
  return { mid, upper, lower, width }
}

/**
 * Bollinger momentum at candle i in direction `dir`: close on the trade side of the middle band,
 * the middle band moved that way over `slope` candles, and the bands are wider than `slope` candles ago.
 */
export function bbMomentumAt(c: readonly Candle[], bb: Bollinger, i: number, dir: Dir, slope: number): boolean {
  const j = i - slope
  if (j < 0 || i >= c.length) return false
  const m = bb.mid[i]!
  const m0 = bb.mid[j]!
  const w = bb.width[i]!
  const w0 = bb.width[j]!
  if (![m, m0, w, w0].every(Number.isFinite)) return false
  const bull = dir === 'bullish'
  const side = bull ? c[i]!.c > m : c[i]!.c < m
  const sloped = bull ? m > m0 : m < m0
  return side && sloped && w > w0
}

/**
 * Golden ratio / OTE (user 2026-11-27): how deep `price` retraces the last leg of the `lookback` closed candles
 * ending at index `i`. Long: leg = lowest low before the window's highest high → that high; 0 = at the high, 1 = back
 * at the leg's low, > 1 = beyond it. Short mirrored. null = not enough candles / flat leg.
 */
export function legRetrace(c: readonly Candle[], i: number, lookback: number, price: number, dir: Dir): number | null {
  if (i < 0 || i >= c.length) return null
  const i0 = Math.max(0, i - lookback + 1)
  if (i - i0 + 1 < Math.ceil(lookback / 2)) return null
  if (dir === 'bullish') {
    let ih = i0
    for (let m = i0; m <= i; m++) if (c[m]!.h > c[ih]!.h) ih = m
    let lo = Infinity
    for (let m = i0; m <= ih; m++) lo = Math.min(lo, c[m]!.l)
    const top = c[ih]!.h
    return top > lo ? (top - price) / (top - lo) : null
  }
  let il = i0
  for (let m = i0; m <= i; m++) if (c[m]!.l < c[il]!.l) il = m
  let hi = -Infinity
  for (let m = i0; m <= il; m++) hi = Math.max(hi, c[m]!.h)
  const bot = c[il]!.l
  return hi > bot ? (price - bot) / (hi - bot) : null
}
