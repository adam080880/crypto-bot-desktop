import { describe, expect, it } from 'vitest'
import { bbMomentumAt, bollinger, inTradeZone, legRetrace, rangePosition } from './premium'
import { path } from './testkit'

describe('premium / discount', () => {
  const c = path(Array.from({ length: 31 }, (_, i) => 100 + i)) // 30 candles closing 101 → 130, wick 0.1
  it('position inside the range of the last N candles', () => {
    const pos = rangePosition(c, 29, 30, 115)!
    expect(pos).toBeGreaterThan(0.45)
    expect(pos).toBeLessThan(0.55)
    expect(rangePosition(c, 29, 30, 101)!).toBeLessThan(0.1)
    expect(rangePosition(c, 3, 30, 101)).toBeNull() // too few candles
  })
  it('long only in discount, short only in premium', () => {
    expect(inTradeZone(0.3, 'bullish', 0.5)).toBe(true)
    expect(inTradeZone(0.8, 'bullish', 0.5)).toBe(false)
    expect(inTradeZone(0.8, 'bearish', 0.5)).toBe(true)
    expect(inTradeZone(0.2, 'bearish', 0.5)).toBe(false) // no short at the bottom
  })
})

describe('Bollinger momentum', () => {
  it('flat then rally = bullish momentum, not bearish', () => {
    const closes = [...Array.from({ length: 25 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2)), 101, 102.5, 104, 106]
    const c = path(closes)
    const bb = bollinger(c, 20, 2)
    const i = c.length - 1
    expect(bb.upper[i]!).toBeGreaterThan(bb.mid[i]!)
    expect(bbMomentumAt(c, bb, i, 'bullish', 3)).toBe(true)
    expect(bbMomentumAt(c, bb, i, 'bearish', 3)).toBe(false)
  })
  it('flat market = no momentum either way', () => {
    const c = path(Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2)))
    const bb = bollinger(c, 20, 2)
    expect(bbMomentumAt(c, bb, 39, 'bullish', 3)).toBe(false)
    expect(bbMomentumAt(c, bb, 39, 'bearish', 3)).toBe(false)
  })
})

describe('golden ratio / OTE (legRetrace)', () => {
  // up leg 100 → 130 (index 0–30), then a pullback to 115 (index 31–36)
  const c = path([...Array.from({ length: 31 }, (_, i) => 100 + i), 127, 124, 121, 118, 116, 115])
  const top = Math.max(...c.map((x) => x.h))
  const low = Math.min(...c.slice(0, 31).map((x) => x.l))
  it('measures the entry against the last leg (0 = top, 1 = leg low)', () => {
    const at = (p: number): number => legRetrace(c, c.length - 1, 40, p, 'bullish')!
    expect(at(top)).toBeCloseTo(0)
    expect(at(low)).toBeCloseTo(1)
    expect(at(top - 0.7 * (top - low))).toBeCloseTo(0.7)
    expect(legRetrace(c, 3, 40, 101, 'bullish')).toBeNull() // too few candles
  })
  it('mirrors for shorts', () => {
    const d = path([...Array.from({ length: 31 }, (_, i) => 130 - i), 103, 106, 109])
    const hi = Math.max(...d.slice(0, 31).map((x) => x.h))
    const bot = Math.min(...d.map((x) => x.l))
    expect(legRetrace(d, d.length - 1, 40, bot + 0.65 * (hi - bot), 'bearish')!).toBeCloseTo(0.65)
  })
})
