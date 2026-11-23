import { describe, expect, it } from 'vitest'
import { FormingCandles } from './formingCandles'

const M = 60_000
const T0 = Date.UTC(2026, 10, 11, 8, 0) // 4h bucket start

describe('FormingCandles', () => {
  it('derives forming 5m…4h from closed 1m + live 1m', () => {
    const f = new FormingCandles()
    f.seed([
      { t: T0 - 121 * M, o: 1, h: 1, l: 1, c: 1, v: 1 }, // 05:59, before every current bucket (3h starts 06:00) → dropped
      { t: T0 - M, o: 2, h: 2, l: 2, c: 2, v: 1 }, // previous 4h bucket, but inside the 07:30 45m bucket → kept
      { t: T0, o: 10, h: 12, l: 9, c: 11, v: 2 },
      { t: T0 + M, o: 11, h: 15, l: 10, c: 14, v: 3 }
    ])
    expect(f.closedCount).toBe(3)
    const out = f.update({ t: T0 + 2 * M, o: 14, h: 14.5, l: 8, c: 13, v: 1 }, false)
    expect(out['1m'].c).toBe(13)
    expect(out['5m']).toEqual({ t: T0, o: 10, h: 15, l: 8, c: 13, v: 6 })
    expect(out['4h']).toEqual({ t: T0, o: 10, h: 15, l: 8, c: 13, v: 6 })
    expect(out['45m']).toEqual({ t: T0 - 30 * M, o: 2, h: 15, l: 2, c: 13, v: 7 })
    expect(out['3m']).toEqual({ t: T0, o: 10, h: 15, l: 8, c: 13, v: 6 })
    expect(out['3h']).toEqual({ t: T0 - 120 * M, o: 2, h: 15, l: 2, c: 13, v: 7 })

    // next 5m bucket starts a fresh 5m bar but 15m keeps accumulating
    f.update({ t: T0 + 2 * M, o: 14, h: 14.5, l: 8, c: 13, v: 1 }, true)
    const later = f.update({ t: T0 + 5 * M, o: 13, h: 20, l: 13, c: 19, v: 4 }, false)
    expect(later['5m']).toEqual({ t: T0 + 5 * M, o: 13, h: 20, l: 13, c: 19, v: 4 })
    expect(later['15m']).toEqual({ t: T0, o: 10, h: 20, l: 8, c: 19, v: 10 })
  })
})
