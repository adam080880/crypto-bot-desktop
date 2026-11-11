import type { Candle } from '@shared/candles'
import type { SrFlip } from '@shared/smc'
import { bodyHi, bodyLo } from './candle'
import type { FvgIdx } from './fvg'
import type { Pivot } from './swings'

export interface SrFlipIdx extends SrFlip {
  breakAt: number
}

/**
 * §5 RBS/SBR. Resistance = body top of a swing high (Q10); a later close above it turns it into
 * RBS (support). Hit = price comes back to the level; invalid = close back below. SBR mirrors.
 */
export function detectSrFlips(c: readonly Candle[], pivots: readonly Pivot[], fvgs: readonly FvgIdx[]): SrFlipIdx[] {
  const out: SrFlipIdx[] = []
  for (const p of pivots) {
    const isRes = p.kind === 'high'
    const level = isRes ? bodyHi(c[p.i]!) : bodyLo(c[p.i]!)
    let breakAt = -1
    for (let m = p.confirmedAt + 1; m < c.length; m++) {
      if (isRes ? c[m]!.c > level : c[m]!.c < level) {
        breakAt = m
        break
      }
      // the level stops mattering once price makes a new extreme beyond the swing itself
      if (isRes ? c[m]!.h > c[p.i]!.h : c[m]!.l < c[p.i]!.l) break
    }
    if (breakAt < 0) continue
    const direction = isRes ? 'bullish' : 'bearish'
    const f: SrFlipIdx = {
      kind: isRes ? 'RBS' : 'SBR',
      direction,
      level,
      sourceT: c[p.i]!.t,
      breakT: c[breakAt]!.t,
      breakAt,
      hasFvg: fvgs.some((g) => g.direction === direction && g.i >= breakAt - 2 && g.i <= breakAt),
      hitT: null,
      invalidT: null
    }
    for (let m = breakAt + 1; m < c.length; m++) {
      const x = c[m]!
      if (isRes) {
        if (f.hitT === null && x.l <= level) f.hitT = x.t
        if (x.c < level) {
          f.invalidT = x.t
          break
        }
      } else {
        if (f.hitT === null && x.h >= level) f.hitT = x.t
        if (x.c > level) {
          f.invalidT = x.t
          break
        }
      }
    }
    out.push(f)
  }
  return out
}
