import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import { extraFeatures } from './extra'

const M15 = 15 * 60_000
const DAY0 = Date.UTC(2026, 10, 17) // Tuesday 00:00 UTC
const bar = (i: number, o: number, h: number, l: number, c: number, bv = 0.5): Candle => ({ t: DAY0 + i * M15, o, h, l, c, v: 1, bv })

describe('extra features (OTE, Power of 3, opens, CVD)', () => {
  // Asia 00–07 UTC = 28 candles in 100–102, then London takes the Asian low (99) and price comes back
  const c: Candle[] = []
  for (let i = 0; i < 28; i++) c.push(bar(i, 101, 102, 100, 101))
  c.push(bar(28, 101, 101, 99, 99.5), bar(29, 99.5, 101.5, 99.4, 101))
  for (let i = 30; i < 40; i++) c.push(bar(i, 101, 101.5, 100.5, 101))
  const known = DAY0 + 40 * M15

  it('Judas: the Asian low swept before a long → judas, not chasing', () => {
    const f = extraFeatures({ c, dir: 'bullish', entry: 100.5, known })
    expect(f).toMatchObject({ inAsia: 0, judas: 1, asiaWith: 0, dow: 2 })
    expect(extraFeatures({ c, dir: 'bearish', entry: 100.5, known })).toMatchObject({ judas: 0, asiaWith: 1 })
    expect(extraFeatures({ c, dir: 'bullish', entry: 100.5, known: DAY0 + 10 * M15 }).inAsia).toBe(1)
  })
  it('opens: a long below the daily open is on the cheap side', () => {
    expect(extraFeatures({ c, dir: 'bullish', entry: 100, known }).dayOpenPos).toBeCloseTo(1)
    expect(extraFeatures({ c, dir: 'bearish', entry: 100, known }).dayOpenPos).toBeCloseTo(-1)
  })
  it('OTE depth: how far back into the leg (origin extreme → best price since) the entry sits', () => {
    // leg from 99 (origin extreme, candle 28) up to 101.5 (the high since then): entry 99.9 → (101.5 − 99.9) / 2.5 = 0.64
    expect(extraFeatures({ c, dir: 'bullish', entry: 99.9, known, poiExtreme: 99, originT: DAY0 + 28 * M15 }).oteDepth).toBeCloseTo(0.64)
  })
  it('CVD divergence: lower low in price, higher low in cumulative delta', () => {
    const d: Candle[] = []
    for (let i = 0; i < 8; i++) d.push(bar(i, 100, 100.5, 99.5 - (i === 4 ? 0.5 : 0), 100, 0.2)) // sellers dominate
    for (let i = 8; i < 16; i++) d.push(bar(i, 100, 100.5, 98.8, 100, 0.8)) // new low, but buyers absorb
    expect(extraFeatures({ c: d, dir: 'bullish', entry: 99, known: DAY0 + 16 * M15 }).cvdDiv).toBe(1)
  })
})
