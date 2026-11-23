import { describe, expect, it } from 'vitest'
import type { SmcAnalysisFull } from './analyze'
import { liquidityAround } from './setups'
import { T0 } from './testkit'

const H = 3_600_000
/** Analysis stub with swing liquidity only (what liquidityAround reads). */
function an(tf: SmcAnalysisFull['timeframe'], liq: { price: number; side: 'buy' | 'sell'; t: number; sweptT?: number | null }[]): SmcAnalysisFull {
  return {
    timeframe: tf,
    liquidity: liq.map((l) => ({ kind: 'swing', side: l.side, top: l.price, bottom: l.price, t: l.t, sweptT: l.sweptT ?? null, equal: false })),
    swings: liq.map((l) => ({ t: l.t, confirmedT: l.t }))
  } as unknown as SmcAnalysisFull
}

// long: entry 100, SL 98 → R = 2; "behind" = 96–98, in zone = 98–100, in front = above 100
const K = T0 + 100 * H

describe('liquidity around a trade (liqHtfBehind / liqInPoi / cleanApproach)', () => {
  it('counts unswept stop-side swings in the zone and an HTF one behind the SL', () => {
    const a = liquidityAround(
      [
        an('15m', [
          { price: 99, side: 'sell', t: T0 },
          { price: 98.5, side: 'sell', t: T0 },
          { price: 99.5, side: 'buy', t: T0 } // other side: ignored
        ]),
        an('4h', [{ price: 97, side: 'sell', t: T0 }])
      ],
      true,
      100,
      98,
      K
    )
    expect(a).toEqual({ htfBehind: true, inZone: 2, induced: 0 })
  })

  it('a 15m swing behind the SL is not HTF; swings known after `known` are ignored', () => {
    const a = liquidityAround([an('15m', [{ price: 97, side: 'sell', t: T0 }]), an('4h', [{ price: 97, side: 'sell', t: K + H }])], true, 100, 98, K)
    expect(a.htfBehind).toBe(false)
  })

  it('swings in front swept during the last 24h count as inducement; a sweep counts once its candle closed', () => {
    const a = liquidityAround(
      [
        an('1h', [
          { price: 102, side: 'sell', t: T0, sweptT: K - 5 * H }, // swept 5h ago, within 3R in front
          { price: 103, side: 'sell', t: T0, sweptT: K - 30 * H }, // too old
          { price: 101, side: 'sell', t: T0, sweptT: K - 30 * 60_000 } // its 1h candle closes after K → not known yet: still unswept, in front
        ])
      ],
      true,
      100,
      98,
      K
    )
    expect(a.induced).toBe(1)
    expect(a.inZone).toBe(0)
  })

  it('mirrors for a short', () => {
    const a = liquidityAround([an('1d', [{ price: 103, side: 'buy', t: T0 }]), an('1h', [{ price: 101, side: 'buy', t: T0 }])], false, 100, 102, K)
    expect(a).toEqual({ htfBehind: true, inZone: 1, induced: 0 })
  })
})
