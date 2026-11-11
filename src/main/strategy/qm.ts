import type { Candle } from '@shared/candles'
import type { Qm } from '@shared/smc'
import { bodyHi, bodyLo } from './candle'
import type { Pivot } from './swings'

/**
 * §7 Quasimodo — three mountains (user-confirmed details):
 *  sell: H1, L1, H2, L2 with L2 < L1 (structure break).
 *        Mountain 2's BODY breaks above mountain 1's WICK (bodyHi[H2] > high[H1]) when
 *        `requireBodyBreak` (default true; "biasanya").
 *        Entry level = mountain 1's BODY top (like an OB line), hit when price comes back there
 *        (mountain 3). Invalid on a close above mountain 2's high.
 *  buy:  mirror (L1, H1, L2, H2 with H2 > H1; bodyLo[L2] < low[L1]; level = bodyLo[L1]).
 */
export function detectQms(c: readonly Candle[], alt: readonly Pivot[], requireBodyBreak = true): Qm[] {
  const out: Qm[] = []
  for (let n = 0; n + 3 < alt.length; n++) {
    const [p1, p2, p3, p4] = [alt[n]!, alt[n + 1]!, alt[n + 2]!, alt[n + 3]!]
    const k1 = c[p1.i]!
    const k3 = c[p3.i]!
    let q: Qm | null = null
    const points = { h1: k1.t, l1: c[p2.i]!.t, h2: k3.t, l2: c[p4.i]!.t }
    if (p1.kind === 'high' && p3.price > p1.price && p4.price < p2.price && (!requireBodyBreak || bodyHi(k3) > k1.h)) {
      q = { direction: 'bearish', level: bodyHi(k1), invalidLevel: k3.h, points, activeT: c[p4.confirmedAt]!.t, hitT: null, invalidT: null }
    } else if (p1.kind === 'low' && p3.price < p1.price && p4.price > p2.price && (!requireBodyBreak || bodyLo(k3) < k1.l)) {
      q = { direction: 'bullish', level: bodyLo(k1), invalidLevel: k3.l, points, activeT: c[p4.confirmedAt]!.t, hitT: null, invalidT: null }
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
