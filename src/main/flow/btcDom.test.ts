import { describe, expect, it, vi } from 'vitest'
import type { Candle } from '@shared/candles'
import { smcConfigSchema } from '@shared/config'
import { BtcDomFeed } from './btcDom'

const H4 = 4 * 3_600_000
const candles = (n: number, end: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const x = 100 + Math.sin(i / 5) * 5
    return { t: end - (n - i) * H4, o: x, h: x + 1, l: x - 1, c: x + 0.5, v: 1 }
  })

describe('BtcDomFeed', () => {
  const cfg = smcConfigSchema.parse({})

  it('never fetches until enabled', () => {
    const fetcher = vi.fn(async () => candles(50, 0))
    const f = new BtcDomFeed(fetcher)
    expect(f.get(cfg, 10 * H4)).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('serves the cached analysis and refetches only after a newer candle closed', async () => {
    const now = 1000 * H4 + 60_000 // 1 min after a 4h close
    const fetcher = vi.fn(async (_tf: string, _from: number, to: number) => candles(200, Math.floor(to / H4) * H4))
    const f = new BtcDomFeed(fetcher)
    f.enable()
    await f.refresh('4h', now)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const a = f.get(cfg, now)!
    expect(a.timeframe).toBe('4h')
    expect(f.get(cfg, now)).toBe(a) // cached per config object
    expect(f.get(cfg, now + H4 - 120_000)).toBe(a) // same candle still forming → no fetch
    expect(fetcher).toHaveBeenCalledTimes(1)
    f.get(cfg, now + H4) // next 4h candle closed → background refresh
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps the old data when a fetch fails', async () => {
    let fail = false
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('down')
      return candles(200, 1000 * H4)
    })
    const f = new BtcDomFeed(fetcher)
    f.enable()
    await f.refresh('4h', 1000 * H4)
    fail = true
    await f.refresh('4h', 1001 * H4 + 60_000)
    expect(f.get(cfg, 1001 * H4 + 60_000)).toBeDefined()
  })
})
