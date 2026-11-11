import type { Candle } from '@shared/candles'
import type { Liquidity, OrderBlock } from '@shared/smc'
import type { Pivot } from './swings'

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
