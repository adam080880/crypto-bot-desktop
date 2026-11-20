import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import { analyzeSmc } from './analyze'
import { detectSetups, snrLevels } from './setups'
import { cfg, T0 } from './testkit'

const H4 = 4 * 3_600_000
const M15 = 15 * 60_000

/** Candles from closes: open = previous close, wick 0.5 beyond the body. */
function fromCloses(closes: number[], start: number, step: number, wick = 0.5): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1]! : c
    return { t: start + i * step, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1 }
  })
}

// falling 4h market (bearish storyline) with one A peak (166 at #40) and one V valley (150 at #45), then a pause
const closes4h = Array.from({ length: 51 }, (_, i) => 200 - i)
Object.assign(closes4h, { 40: 166, 45: 150, 46: 154, 47: 153, 48: 154, 49: 156, 50: 155 })
const h4 = fromCloses(closes4h, T0, H4)

describe('MSNR levels (line chart of closes)', () => {
  it('finds A/V pivots of the closes and when a wick first touches them', () => {
    const lv = snrLevels(h4, '4h', 2)
    const a = lv.find((l) => l.kind === 'A' && l.price === 166)!
    const v = lv.find((l) => l.kind === 'V' && l.price === 150)!
    expect(a.knownT).toBe(T0 + 43 * H4) // close of the 2nd candle after the peak
    expect(a.touchT).toBe(Infinity) // later wicks stay below 166 → still fresh
    expect(v.touchT).toBe(Infinity)
  })
})

describe('M7 MSNR', () => {
  it('short limit at a fresh A level when price comes near in a bearish storyline, TP at the next fresh V', () => {
    // 15m rally from 155.5 toward the A level (highs stay below 166)
    const m15 = fromCloses(Array.from({ length: 16 }, (_, i) => 155.5 + i * 0.5), T0 + 51 * H4, M15, 0.2)
    const c = cfg({ models: ['M7'], msnrStoryEma: 5, msnrNearAtr: 2 })
    const setups = detectSetups({ symbol: 'X', entry: analyzeSmc(m15, '15m', c), poiAnalyses: [analyzeSmc(h4, '4h', c)], cfg: c })
    expect(setups).toHaveLength(1)
    const s = setups[0]!
    expect(s).toMatchObject({ model: 'M7', direction: 'bearish', entry: 166, tp: 150, tpLiquidity: 150, status: 'pending' })
    expect(s.sl).toBeGreaterThan(166)
    expect(s.rr).toBeGreaterThanOrEqual(1.5)
  })

  it('no setup when the storyline points the other way', () => {
    const m15 = fromCloses(Array.from({ length: 16 }, (_, i) => 155.5 + i * 0.5), T0 + 51 * H4, M15, 0.2)
    const rising = h4.map((x) => ({ ...x, o: 400 - x.o, h: 400 - x.l, l: 400 - x.h, c: 400 - x.c })) // mirror: bullish storyline
    const c = cfg({ models: ['M7'], msnrStoryEma: 5, msnrNearAtr: 2 })
    const setups = detectSetups({ symbol: 'X', entry: analyzeSmc(m15, '15m', c), poiAnalyses: [analyzeSmc(rising, '4h', c)], cfg: c })
    expect(setups.filter((s) => s.direction === 'bearish')).toHaveLength(0)
  })
})
