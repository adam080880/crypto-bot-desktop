import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import type { Setup } from '@shared/smc'
import type { Poi } from '../strategy/setups'
import { netR, poiTouch, simulateEquity, toTrades, tradeStats, type Trade } from './engine'
import { splitTime } from './runBacktest'

const M = 15 * 60_000
const T0 = Date.UTC(2026, 5, 1)
const DAY = 86_400_000
const NO_FEES = { makerFeePct: 0, takerFeePct: 0, slippagePct: 0 }
const FEES = { makerFeePct: 0.02, takerFeePct: 0.05, slippagePct: 0.02 }

const setup = (s: Partial<Setup>): Setup => ({
  id: 'x',
  symbol: 'T',
  direction: 'bullish',
  poi: { kind: 'OB', timeframe: '1h', level: 99, t: T0, hitT: T0 },
  obValid: { timeframe: '15m', t: T0, line: 100, wickEnd: 99, hasFvg: true },
  entry: 100,
  sl: 99,
  tp: 103,
  rr: 3,
  score: 3,
  reasons: [],
  createdT: T0,
  status: 'win',
  statusT: T0 + 4 * M,
  filledT: T0 + M,
  ...s
})

describe('netR', () => {
  it('is the plain RR without costs', () => {
    expect(netR(setup({}), NO_FEES)).toBeCloseTo(3)
    expect(netR(setup({ status: 'loss' }), NO_FEES)).toBeCloseTo(-1)
  })

  it('subtracts maker fees on a win and taker fee + slippage on a stop', () => {
    // win: (3 − 0.02%·100 − 0.02%·103) / 1
    expect(netR(setup({}), FEES)).toBeCloseTo(3 - 0.02 - 0.0206)
    // loss: −(1 + 0.02%·99 + 0.02%·100 + 0.05%·99) / 1
    expect(netR(setup({ status: 'loss' }), FEES)).toBeCloseTo(-(1 + 0.0198 + 0.02 + 0.0495))
  })
})

describe('toTrades / tradeStats', () => {
  it('keeps only filled setups that closed, and measures the R drawdown', () => {
    const setups = [
      setup({ id: 'a', statusT: T0 + 1 * DAY }),
      setup({ id: 'b', status: 'loss', statusT: T0 + 2 * DAY }),
      setup({ id: 'c', status: 'loss', statusT: T0 + 3 * DAY }),
      setup({ id: 'd', status: 'missed', filledT: null }),
      setup({ id: 'e', status: 'triggered', statusT: T0 + 5 * DAY })
    ]
    const s = tradeStats(toTrades(setups, NO_FEES))
    expect(s).toMatchObject({ trades: 3, wins: 1, totalR: 1, maxDdR: 2 })
    expect(s.winrate).toBeCloseTo(1 / 3)
    expect(s.profitFactor).toBeCloseTo(1.5)
  })
})

describe('simulateEquity', () => {
  const trade = (p: Partial<Trade> & { r: number; filledT: number; exitT: number }): Trade => ({
    setup: setup({}),
    slDist: 0.01,
    ...p
  })
  const opts = { startEquity: 10, riskPct: 1, maxLeverage: 5, maxDailyLossPct: 3 }

  it('risks a fixed % of current equity per trade (compounding)', () => {
    const sim = simulateEquity([trade({ r: -1, filledT: T0, exitT: T0 + M }), trade({ r: 2, filledT: T0 + DAY, exitT: T0 + DAY + M })], opts)
    // 10 → 9.9 (−1% of 10) → 9.9 + 2 × 0.099
    expect(sim.endEquity).toBeCloseTo(9.9 + 0.198)
    expect(sim.taken).toBe(2)
    expect(sim.maxDdPct).toBeCloseTo(1)
  })

  it('skips a fill while a position on the symbol is still open', () => {
    const sim = simulateEquity([trade({ r: 1, filledT: T0, exitT: T0 + 10 * M }), trade({ r: 1, filledT: T0 + 5 * M, exitT: T0 + 20 * M })], opts)
    expect(sim).toMatchObject({ taken: 1, skippedOpen: 1 })
  })

  it('caps the size at max leverage when the stop is very tight', () => {
    // SL 0.1% away: 1% risk would need 10× notional, capped at 5× → half the risk
    const sim = simulateEquity([trade({ r: -1, slDist: 0.001, filledT: T0, exitT: T0 + M })], opts)
    expect(sim.leverageCapped).toBe(1)
    expect(sim.endEquity).toBeCloseTo(10 - 0.05)
  })

  it('stops entering for the rest of the UTC day after the daily loss limit', () => {
    const losses = [0, 1, 2, 3].map((i) => trade({ r: -1, filledT: T0 + i * 2 * M, exitT: T0 + (i * 2 + 1) * M }))
    const next = trade({ r: 1, filledT: T0 + DAY, exitT: T0 + DAY + M })
    const sim = simulateEquity([...losses, next], { ...opts, maxDailyLossPct: 2.5 })
    // 3 losses (≈2.97%) pass the 2.5% limit → 4th entry skipped, trading resumes next day
    expect(sim).toMatchObject({ taken: 4, skippedHalt: 1, maxLosingStreak: 3 })
  })
})

describe('poiTouch', () => {
  const poi: Poi = { kind: 'OB', timeframe: '1h', direction: 'bullish', level: 100, t: T0, activeFrom: T0, invalidT: null }
  const c = (rows: [number, number, number, number][]): Candle[] => rows.map(([o, h, l, cl], i) => ({ t: T0 + i * M, o, h, l, c: cl, v: 1 }))

  it('races from the POI level: +X% before −X% counts as a win', () => {
    const t = poiTouch(poi, c([[101, 101.2, 100.6, 101], [101, 101.1, 99.9, 100.2], [100.2, 100.8, 100, 100.7], [100.7, 101.2, 100.6, 101.1]]), DAY)!
    expect(t.touchT).toBe(T0 + M)
    expect(t.race).toEqual(['win', 'win', 'timeout']) // +0.5%, +1%, +2%
    expect(t.maePct).toBeCloseTo(0.1)
  })

  it('counts the adverse side first, including the touch candle', () => {
    const t = poiTouch(poi, c([[101, 101, 99.4, 101.5], [101.5, 102.5, 101, 102.4]]), DAY)!
    expect(t.race).toEqual(['loss', 'win', 'win']) // touch wick −0.6% already lost the 0.5% race
  })

  it('ignores touches after the POI was invalidated', () => {
    expect(poiTouch({ ...poi, invalidT: T0 + M }, c([[101, 101, 100.5, 101], [101, 101, 99, 99.5]]), DAY)).toBeNull()
  })
})

describe('splitTime', () => {
  it('uses the last oosDays when there is enough history, else a 2:1 split', () => {
    expect(splitTime(T0, T0 + 180 * DAY, 60)).toEqual({ splitT: T0 + 120 * DAY, splitAdjusted: false })
    expect(splitTime(T0, T0 + 42 * DAY, 60)).toEqual({ splitT: T0 + 28 * DAY, splitAdjusted: true })
  })
})
