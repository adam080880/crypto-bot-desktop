import type { Candle } from '@shared/candles'
import type { Qm } from '@shared/smc'
import type { Pivot } from './swings'

/**
 * §7 Quasimodo from alternating swings.
 *  sell: H1, L1, H2 > H1, L2 < L1 → sell at H1 (wick, Q13); invalid on a close above H2.
 *  buy:  L1, H1, L2 < L1, H2 > H1 → buy at L1; invalid on a close below L2.
 * Active once the 4th swing is confirmed (Q12: the structure break is required).
 */
export function detectQms(c: readonly Candle[], alt: readonly Pivot[]): Qm[] {
  const out: Qm[] = []
  for (let n = 0; n + 3 < alt.length; n++) {
    const [p1, p2, p3, p4] = [alt[n]!, alt[n + 1]!, alt[n + 2]!, alt[n + 3]!]
    let q: Qm | null = null
    if (p1.kind === 'high' && p3.price > p1.price && p4.price < p2.price) {
      q = {
        direction: 'bearish',
        level: p1.price,
        invalidLevel: p3.price,
        points: { h1: c[p1.i]!.t, l1: c[p2.i]!.t, h2: c[p3.i]!.t, l2: c[p4.i]!.t },
        activeT: c[p4.confirmedAt]!.t,
        hitT: null,
        invalidT: null
      }
    } else if (p1.kind === 'low' && p3.price < p1.price && p4.price > p2.price) {
      q = {
        direction: 'bullish',
        level: p1.price,
        invalidLevel: p3.price,
        points: { h1: c[p1.i]!.t, l1: c[p2.i]!.t, h2: c[p3.i]!.t, l2: c[p4.i]!.t },
        activeT: c[p4.confirmedAt]!.t,
        hitT: null,
        invalidT: null
      }
    }
    if (!q) continue
    for (let m = p4.confirmedAt + 1; m < c.length; m++) {
      const x = c[m]!
      if (q.direction === 'bearish') {
        if (q.hitT === null && x.h >= q.level) q.hitT = x.t
        if (x.c > q.invalidLevel) {
          q.invalidT = x.t
          break
        }
      } else {
        if (q.hitT === null && x.l <= q.level) q.hitT = x.t
        if (x.c < q.invalidLevel) {
          q.invalidT = x.t
          break
        }
      }
    }
    out.push(q)
  }
  return out
}
