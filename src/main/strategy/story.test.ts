import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import type { SmcAnalysisFull } from './analyze'
import { liquidityPools, poiStory, tfWeight } from './story'
import type { Poi } from './setups'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 10) // Tuesday 00:00 UTC

/** Minimal analysis: swing liquidity pools + candles. */
const an = (tf: '1h' | '4h' | '1d', candles: Candle[], liq: { t: number; price: number; side: 'buy' | 'sell'; confirmedT: number; sweptT?: number; equal?: boolean }[]) =>
  ({
    timeframe: tf,
    candles,
    swings: liq.map((l) => ({ t: l.t, kind: l.side === 'buy' ? 'high' : 'low', price: l.price, label: null, confirmedT: l.confirmedT })),
    liquidity: liq.map((l) => ({ kind: 'swing', side: l.side, top: l.price, bottom: l.price, t: l.t, sweptT: l.sweptT ?? null, equal: !!l.equal })),
    atr: candles.map(() => 1),
    fvgsIdx: [],
    breaks: [],
    trendChanges: []
  }) as unknown as SmcAnalysisFull
const bar = (t: number, l: number, h: number): Candle => ({ t, o: (l + h) / 2, h, l, c: (l + h) / 2, v: 1 })

describe('liquidity map (POI story layer 2)', () => {
  const h1 = Array.from({ length: 30 }, (_, i) => bar(T0 + i * H, 99, 101))
  it('only pools already known and not yet swept at `at`; equal doubles the weight; neighbours merge', () => {
    const a = an('1h', h1, [
      { t: T0, price: 105, side: 'buy', confirmedT: T0 + 2 * H }, // known at 03:00
      { t: T0 + H, price: 105.1, side: 'buy', confirmedT: T0 + 3 * H, equal: true }, // within 0.15 % → merged
      { t: T0 + 2 * H, price: 95, side: 'sell', confirmedT: T0 + 3 * H, sweptT: T0 + 5 * H }, // swept, known at 06:00
      { t: T0 + 3 * H, price: 90, side: 'sell', confirmedT: T0 + 20 * H } // not known yet at 10:00
    ])
    const at = T0 + 10 * H
    const pools = liquidityPools([a], at)
    expect(pools).toHaveLength(1)
    expect(pools[0]).toMatchObject({ side: 'buy', kind: 'equal' })
    expect(pools[0]!.weight).toBeGreaterThan(3 * tfWeight('1h'))
    // before the sweep candle closed, the 95 pool was still resting
    expect(liquidityPools([a], T0 + 5 * H).some((p) => p.price === 95)).toBe(true)
  })

  it('previous day high / low stay pools until price trades through them', () => {
    const d1 = an('1d', [bar(T0 - 24 * H, 90, 110)], [])
    const fine = an('1h', [bar(T0, 95, 105), bar(T0 + H, 96, 111)], [])
    expect(liquidityPools([d1, fine], T0 + H).filter((p) => p.kind === 'pdh' || p.kind === 'pdl')).toHaveLength(2)
    // the 01:00 candle (closed at 02:00) took yesterday's high
    expect(liquidityPools([d1, fine], T0 + 2 * H).map((p) => p.kind)).toEqual(['pdl'])
  })
})

describe('POI story (layer 1)', () => {
  it('names the HTF pool its origin candle swept, the draw B and a clean stop side', () => {
    const c4: Candle[] = [bar(T0, 100, 104), bar(T0 + 4 * H, 96, 101), bar(T0 + 8 * H, 100, 106), bar(T0 + 12 * H, 103, 107)]
    // 4h SSL at 98 swept by the 04:00 candle (low 96); 4h BSL at 120 resting above
    const a4 = an('4h', c4, [
      { t: T0 - 8 * H, price: 98, side: 'sell', confirmedT: T0 - 4 * H, sweptT: T0 + 4 * H },
      { t: T0 - 8 * H, price: 120, side: 'buy', confirmedT: T0 - 4 * H }
    ])
    const poi: Poi = { kind: 'OB', timeframe: '4h', direction: 'bullish', level: 100, t: T0 + 4 * H, activeFrom: T0 + 12 * H, invalidT: null, origin: 'sweep', extreme: 96, originT: T0 + 4 * H }
    const at = T0 + 16 * H
    const s = poiStory(poi, [a4], { at, price: 105, pois: [poi], pools: liquidityPools([a4], at) })!
    expect(s.taken[0]).toMatchObject({ price: 98, tf: '4h' })
    expect(s.facts.find((f) => f.kind === 'cause')).toMatchObject({ sign: 1 })
    expect(s.target).toMatchObject({ price: 120 })
    expect(s.behindSl).toBeNull()
    expect(s.touches).toBe(0)
  })
})
