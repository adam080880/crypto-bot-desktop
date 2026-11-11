import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import { TF_MS } from '@shared/timeframes'
import { aggregate } from './resample'

const M = TF_MS['1m']
const T0 = Date.UTC(2026, 9, 1, 8, 0) // 08:00 UTC, aligned to 4h

function minutes(n: number, from = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    t: from + i * M,
    o: 100 + i,
    h: 100 + i + 0.5 + (i === 7 ? 50 : 0),
    l: 100 + i - 0.5 - (i === 3 ? 20 : 0),
    c: 100 + i + 0.25,
    v: 1
  }))
}

describe('aggregate', () => {
  it('builds 5m OHLCV from 1m', () => {
    const out = aggregate(minutes(10), '5m')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ t: T0, o: 100, h: 104.5, l: 82.5, c: 104.25, v: 5, n: 5 })
    expect(out[1]).toEqual({ t: T0 + 5 * M, o: 105, h: 157.5, l: 104.5, c: 109.25, v: 5, n: 5 })
  })

  it('cascade (1m→5m→15m→1h→4h) equals direct aggregation', () => {
    const m = minutes(240 * 2) // two full 4h buckets
    const c5 = aggregate(m, '5m')
    const c15 = aggregate(c5, '15m')
    const c1h = aggregate(c15, '1h')
    const c4h = aggregate(c1h, '4h')
    expect(c4h).toEqual(aggregate(m, '4h'))
    expect(c4h.map((c) => c.n)).toEqual([240, 240])
    expect(c4h[0]!.t).toBe(T0)
  })

  it('aligns buckets to UTC boundaries and counts gaps via n', () => {
    const m = minutes(10, T0 + 3 * M).filter((_, i) => i !== 4) // starts at :03, one missing minute
    const out = aggregate(m, '5m')
    expect(out.map((c) => c.t)).toEqual([T0, T0 + 5 * M, T0 + 10 * M])
    expect(out.map((c) => c.n)).toEqual([2, 4, 3])
  })
})
