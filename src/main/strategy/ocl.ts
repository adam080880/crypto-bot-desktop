import type { Candle } from '@shared/candles'
import type { Ocl } from '@shared/smc'
import { isGreen, isRed } from './candle'

/**
 * §6 OCL (Open Close Candle), per materi + user's example:
 *  - OCL: candle i closes and candle i+1 of the SAME colour continues from there.
 *    Level = close[i]; the OCL "area" = body of candle i.
 *    Green pair → bullish OCL (support / buy POI); red pair → bearish OCL (resistance / sell POI).
 *  - OCL Break: within `breakMaxCandles` after i+1, an opposite-colour candle's BODY closes beyond the
 *    whole OCL area (bearish OCL: green candle closes above open[i]) → OCL BREAK in the new direction
 *    at the same level (e.g. OCL Break Buy at the red candle's close).
 *  - Hit = price returns to the level; invalid = close back through the level against the POI.
 */
export function detectOcls(c: readonly Candle[], breakMaxCandles: number): Ocl[] {
  const out: Ocl[] = []
  for (let i = 0; i + 1 < c.length; i++) {
    const a = c[i]!
    const b = c[i + 1]!
    const up = isGreen(a) && isGreen(b)
    const down = isRed(a) && isRed(b)
    if (!up && !down) continue
    const o: Ocl = { t: a.t, kind: 'OCL', direction: up ? 'bullish' : 'bearish', level: a.c, breakT: null, hitT: null, invalidT: null }
    const areaFar = a.o // far edge of the OCL area (body of candle i)
    for (let m = i + 2; m < c.length; m++) {
      const x = c[m]!
      if (o.kind === 'OCL') {
        const breaks = up ? isRed(x) && x.c < areaFar : isGreen(x) && x.c > areaFar
        if (breaks && m - (i + 1) <= breakMaxCandles) {
          o.kind = 'OCL_BREAK'
          o.direction = up ? 'bearish' : 'bullish'
          o.breakT = x.t
          continue
        }
        if (o.hitT === null && (up ? x.l <= o.level : x.h >= o.level)) o.hitT = x.t
        if (up ? x.c < o.level : x.c > o.level) {
          o.invalidT = x.t // closed through without a qualifying break
          break
        }
      } else {
        const buy = o.direction === 'bullish'
        if (o.hitT === null && (buy ? x.l <= o.level : x.h >= o.level)) o.hitT = x.t
        if (buy ? x.c < o.level : x.c > o.level) {
          o.invalidT = x.t
          break
        }
      }
    }
    out.push(o)
  }
  return out
}
