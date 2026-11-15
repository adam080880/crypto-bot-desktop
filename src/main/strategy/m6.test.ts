import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import { smcConfigSchema } from '@shared/config'
import { RADAR_BARS } from '../radar/radar'
import { analyzeSmc } from './analyze'
import { atrSeries } from './atr'
import { detectSetups } from './setups'

const H = 3_600_000
const Q = H / 4
const cfg = smcConfigSchema.parse({ models: ['M6'], pivot: 2 })

/** Flat 1h market; the last 24h before `spikeAt` trade 10× the volume, then a close above the box. */
function market(spike: boolean): { h1: Candle[]; m15: Candle[]; breakout: number } {
  const n = RADAR_BARS + 10
  const spikeAt = RADAR_BARS - 1
  const breakout = spikeAt + 3
  const h1: Candle[] = Array.from({ length: n }, (_, i) => {
    const hot = spike && i > spikeAt - 24 && i <= spikeAt
    const c = i === breakout ? 1.1 : i > breakout ? 1.12 : 1 + (i % 2) * 0.01
    return { t: i * H, o: 1, h: Math.max(c, 1.01), l: 0.99, c, v: hot ? 1000 : 100 }
  })
  const m15: Candle[] = h1.flatMap((k) => [0, 1, 2, 3].map((j) => ({ t: k.t + j * Q, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v / 4 })))
  return { h1, m15, breakout }
}

describe('M6 radar pump → 1h breakout', () => {
  it('volume spike + close above the 24h box → one long, SL = 3 × ATR24, no TP', () => {
    const { h1, m15, breakout } = market(true)
    const setups = detectSetups({ symbol: 'PUMPUSDT', entry: analyzeSmc(m15, '15m', cfg), poiAnalyses: [analyzeSmc(h1, '1h', cfg)], cfg })
    expect(setups).toHaveLength(1)
    const s = setups[0]!
    expect(s.model).toBe('M6')
    expect(s.direction).toBe('bullish')
    expect(s.entry).toBe(1.1)
    expect(s.entry - s.sl).toBeCloseTo(3 * atrSeries(h1, 24)[breakout]!, 9)
    expect(s.child.t).toBe(breakout * H)
    expect(s.tpLiquidity).toBeNull()
    // the coin is awake at that time: tagged for every model
    expect(s.confluence).toContain('anomaly')
  })
  it('no radar hit on normal volume', () => {
    const { h1, m15 } = market(false)
    expect(detectSetups({ symbol: 'X', entry: analyzeSmc(m15, '15m', cfg), poiAnalyses: [analyzeSmc(h1, '1h', cfg)], cfg })).toHaveLength(0)
  })
})
