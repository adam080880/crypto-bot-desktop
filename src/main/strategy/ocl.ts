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
 *
 * No look-ahead: an OCL that later breaks is emitted TWICE — the plain OCL (its own direction, valid
 * until the break candle, `invalidT = breakT`) and the OCL Break (new direction, from `breakT`). Before
 * 2026-11-22 the plain phase was relabelled in place, so on history the surviving plain OCLs were only
 * the ones that never broke (the future decided which OCLs a backtest could see).
 */
export function detectOcls(c: readonly Candle[], breakMaxCandles: number): Ocl[] {
  const out: Ocl[] = []
  for (let i = 0; i + 1 < c.length; i++) {
    const a = c[i]!
    const b = c[i + 1]!
    const up = isGreen(a) && isGreen(b)
    const down = isRed(a) && isRed(b)
    if (!up && !down) continue
    const plain: Ocl = { t: a.t, kind: 'OCL', direction: up ? 'bullish' : 'bearish', level: a.c, breakT: null, hitT: null, invalidT: null }
    out.push(plain)
    const areaFar = a.o // far edge of the OCL area (body of candle i)
    let brk: Ocl | null = null
    for (let m = i + 2; m < c.length; m++) {
      const x = c[m]!
      if (!brk) {
        const breaks = up ? isRed(x) && x.c < areaFar : isGreen(x) && x.c > areaFar
        if (breaks && m - (i + 1) <= breakMaxCandles) {
          // the break candle closes beyond the far edge, so it also closes through the plain OCL
          plain.invalidT = x.t
          // a touch while it was still a plain OCL is not a hit of the OCL Break POI
          brk = { t: a.t, kind: 'OCL_BREAK', direction: up ? 'bearish' : 'bullish', level: a.c, breakT: x.t, hitT: null, invalidT: null }
          out.push(brk)
          continue
        }
        if (plain.hitT === null && (up ? x.l <= plain.level : x.h >= plain.level)) plain.hitT = x.t
        if (up ? x.c < plain.level : x.c > plain.level) {
          plain.invalidT = x.t // closed through without a qualifying break
          break
        }
      } else {
        const buy = brk.direction === 'bullish'
        if (brk.hitT === null && (buy ? x.l <= brk.level : x.h >= brk.level)) brk.hitT = x.t
        if (buy ? x.c < brk.level : x.c > brk.level) {
          brk.invalidT = x.t
          break
        }
      }
    }
  }
  return out
}
