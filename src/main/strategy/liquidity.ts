import type { Candle } from '@shared/candles'
import type { Liquidity, OrderBlock } from '@shared/smc'
import type { Pivot } from './swings'
import { atrSeries } from './atr'

/**
 * §10 Liquidity.
 *  wick:  the wick of every OB / OB valid beyond its body line (user's definition: leftover
 *         liquidity), swept when price trades past the wick end.
 *  swing: alternating swing highs (buy-side) / lows (sell-side), swept when price trades beyond;
 *         flagged `equal` when within `equalPct` of the previous swing of the same kind.
 */
export function detectLiquidity(
  c: readonly Candle[],
  obs: readonly OrderBlock[],
  alt: readonly Pivot[],
  equalPct: number
): Liquidity[] {
  const out: Liquidity[] = obs.map((ob) => ({
    kind: 'wick' as const,
    side: ob.direction === 'bullish' ? ('sell' as const) : ('buy' as const),
    top: Math.max(ob.line, ob.wickEnd),
    bottom: Math.min(ob.line, ob.wickEnd),
    t: ob.t,
    sweptT: ob.sweptT,
    equal: false
  }))
  let prevHigh: number | null = null
  let prevLow: number | null = null
  for (const p of alt) {
    const isHigh = p.kind === 'high'
    const prev = isHigh ? prevHigh : prevLow
    const equal = prev !== null && (Math.abs(p.price - prev) / prev) * 100 <= equalPct
    let sweptT: number | null = null
    for (let m = p.i + 1; m < c.length; m++) {
      if (isHigh ? c[m]!.h > p.price : c[m]!.l < p.price) {
        sweptT = c[m]!.t
        break
      }
    }
    out.push({ kind: 'swing', side: isHigh ? 'buy' : 'sell', top: p.price, bottom: p.price, t: c[p.i]!.t, sweptT, equal })
    if (isHigh) prevHigh = p.price
    else prevLow = p.price
  }
  return out
}

/** LuxAlgo buy-side (above highs) / sell-side (below lows) liquidity pool. */
export interface LuxPool {
  side: 'buy' | 'sell'
  /** Extreme of the clustered swings (BSL: highest high, SSL: lowest low): trading past it = swept. */
  level: number
  /** Box centre ± margin, as drawn by LuxAlgo. */
  top: number
  bottom: number
  /** Candle index of the oldest swing in the cluster. */
  startIdx: number
  /** Candle index whose close confirms the latest swing (pivot right side = 1). */
  knownIdx: number
  /** Swings in the cluster (≥ 3). */
  count: number
}

/**
 * LuxAlgo ICT Concepts liquidity. Zigzag of pivots (`left` candles on the left, 1 on the right, highs/lows alternate,
 * consecutive same-side pivots keep the more extreme one). On every new swing high, walk back over the previous zigzag highs
 * (stop at one higher than ph + margin) and count those within ±margin of it (margin = ATR(10) / 2.5); 3 or more → BSL pool
 * (SSL mirrored). Each event is one pool record known at `knownIdx`; a later swing that extends the same cluster adds a new record.
 */
export function detectLuxLiquidity(c: readonly Candle[], left = 5, marginDiv = 2.5): LuxPool[] {
  const atr = atrSeries(c, 10)
  const zz: { d: 1 | -1; x: number; y: number }[] = [] // newest first
  const out: LuxPool[] = []
  const scan = (d: 1 | -1, j: number, y: number, m: number): void => {
    let count = 0, start = j, hi = -Infinity, lo = Infinity
    for (let i = 0; i < Math.min(zz.length, 50); i++) {
      const p = zz[i]!
      if (p.d !== d) continue
      if (d === 1 ? p.y > y + m : p.y < y - m) break
      if (p.y > y - m && p.y < y + m) { count++; start = p.x; hi = Math.max(hi, p.y); lo = Math.min(lo, p.y) }
    }
    if (count > 2) {
      const mid = (hi + lo) / 2
      out.push({ side: d === 1 ? 'buy' : 'sell', level: d === 1 ? hi : lo, top: mid + m, bottom: mid - m, startIdx: start, knownIdx: j + 1, count })
    }
  }
  for (let t = left + 1; t < c.length; t++) {
    const j = t - 1 // pivot candidate, right side = candle t
    const k = c[j]!
    let ph = k.h > c[t]!.h, pl = k.l < c[t]!.l
    for (let i = j - left; i < j && (ph || pl); i++) {
      if (c[i]!.h >= k.h) ph = false
      if (c[i]!.l <= k.l) pl = false
    }
    const m = atr[t]! / marginDiv
    if (ph) {
      const last = zz[0]
      if (!last || last.d < 1) zz.unshift({ d: 1, x: j, y: k.h })
      else if (k.h > last.y) { last.x = j; last.y = k.h }
      scan(1, j, k.h, m)
    }
    if (pl) {
      const last = zz[0]
      if (!last || last.d > -1) zz.unshift({ d: -1, x: j, y: k.l })
      else if (k.l < last.y) { last.x = j; last.y = k.l }
      scan(-1, j, k.l, m)
    }
    if (zz.length > 60) zz.length = 60
  }
  return out
}
