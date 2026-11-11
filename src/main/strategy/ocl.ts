import type { Candle } from '@shared/candles'
import type { Ocl } from '@shared/smc'
import { bodyRatio, isGreen, isRed } from './candle'

/**
 * §6 (Q11 default): OCL = close of candle i inside a strong move, i.e. candles i and i+1 point the
 * same way, both have body ≥ `minBody` of their range, and i+1 closes further. Level = close[i].
 * A bullish OCL acts as support; a close below it turns it into a bearish OCL_BREAK (resistance).
 */
export function detectOcls(c: readonly Candle[], minBody: number): Ocl[] {
  const out: Ocl[] = []
  for (let i = 0; i + 1 < c.length; i++) {
    const a = c[i]!
    const b = c[i + 1]!
    const up = isGreen(a) && isGreen(b) && b.c > a.c
    const down = isRed(a) && isRed(b) && b.c < a.c
    if (!(up || down) || bodyRatio(a) < minBody || bodyRatio(b) < minBody) continue
    const o: Ocl = { t: a.t, kind: 'OCL', direction: up ? 'bullish' : 'bearish', level: a.c, breakT: null, hitT: null, invalidT: null }
    for (let m = i + 2; m < c.length; m++) {
      const x = c[m]!
      const support = o.direction === 'bullish'
      if (o.hitT === null && (support ? x.l <= o.level : x.h >= o.level)) o.hitT = x.t
      const crossed = support ? x.c < o.level : x.c > o.level
      if (!crossed) continue
      if (o.kind === 'OCL') {
        o.kind = 'OCL_BREAK'
        o.direction = support ? 'bearish' : 'bullish'
        o.breakT = x.t
        o.hitT = null
      } else {
        o.invalidT = x.t
        break
      }
    }
    out.push(o)
  }
  return out
}
