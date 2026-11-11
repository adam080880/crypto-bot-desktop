import type { Candle } from '@shared/candles'
import type { Fvg } from '@shared/smc'

export interface FvgIdx extends Fvg {
  i: number
}

/** §4: gap between candle j's wick and candle j+2's wick. Status tracked from j+3. */
export function detectFvgs(c: readonly Candle[], minPct: number): FvgIdx[] {
  const out: FvgIdx[] = []
  for (let j = 0; j + 2 < c.length; j++) {
    const a = c[j]!
    const z = c[j + 2]!
    const ref = c[j + 1]!.c || 1
    let f: FvgIdx | null = null
    if (z.l > a.h && ((z.l - a.h) / ref) * 100 >= minPct)
      f = { i: j, t: a.t, direction: 'bullish', top: z.l, bottom: a.h, touchedT: null, filledT: null }
    else if (z.h < a.l && ((a.l - z.h) / ref) * 100 >= minPct)
      f = { i: j, t: a.t, direction: 'bearish', top: a.l, bottom: z.h, touchedT: null, filledT: null }
    if (!f) continue
    for (let m = j + 3; m < c.length; m++) {
      const k = c[m]!
      if (f.direction === 'bullish') {
        if (f.touchedT === null && k.l <= f.top) f.touchedT = k.t
        if (k.l <= f.bottom) {
          f.filledT = k.t
          break
        }
      } else {
        if (f.touchedT === null && k.h >= f.bottom) f.touchedT = k.t
        if (k.h >= f.top) {
          f.filledT = k.t
          break
        }
      }
    }
    out.push(f)
  }
  return out
}
