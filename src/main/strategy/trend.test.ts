import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import { defaultAppConfig, trendExit } from '@shared/config'
import type { ScreenerSetup } from '@shared/screener'
import { analyzeSmc } from './analyze'
import { detectSetups, inKillzone } from './setups'
import { atrSeries } from './atr'
import { cfg, T0 } from './testkit'
import { exitFor, setupGate, type Candidate } from '../bot/gate'
import { defaultPlans, simulateSetup } from '../backtest/simulate'

const H4 = 4 * 3_600_000
const M15 = 15 * 60_000

/** 4h candles from closes (range ±0.5 around each close) plus matching flat 15m candles. */
function series(closes: number[], dips: Record<number, number> = {}): { h4: Candle[]; m15: Candle[] } {
  const h4: Candle[] = closes.map((c, i) => ({ t: T0 + i * H4, o: i ? closes[i - 1]! : c, h: Math.max(c, i ? closes[i - 1]! : c) + 0.5, l: Math.min(c, i ? closes[i - 1]! : c) - 0.5, c, v: 1 }))
  const m15: Candle[] = []
  closes.forEach((c, i) => {
    for (let k = 0; k < 16; k++) {
      const t = T0 + i * H4 + k * M15
      const low = k === 0 && dips[i] !== undefined ? dips[i]! : c - 0.05
      m15.push({ t, o: c, h: c + 0.05, l: low, c, v: 1 })
    }
  })
  return { h4, m15 }
}

// 30 candles ranging around 100, breakout close 105 at index 30, then higher closes (not fresh)
const CLOSES = [...Array.from({ length: 30 }, (_, i) => (i % 2 ? 100.5 : 99.5)), 105, 106, 107, 108]

function setups(closes: number[], dips: Record<number, number> = {}, over = {}) {
  const c = cfg({ models: ['M5'], trendEma: 0, trendTimeframe: '4h', ...over })
  const { h4, m15 } = series(closes, dips)
  const entry = analyzeSmc(m15, '15m', c)
  const four = analyzeSmc(h4, '4h', c)
  return { list: detectSetups({ symbol: 'XUSDT', entry, poiAnalyses: [four], cfg: c }), h4, m15 }
}

describe('M5 trend breakout', () => {
  it('fresh 4h close above the 20-candle high → limit at the close, SL 3×ATR, known at the 4h close', () => {
    const { list, h4 } = setups(CLOSES.slice(0, 32))
    expect(list).toHaveLength(1)
    const s = list[0]!
    const atr = atrSeries(h4, 14)[30]!
    expect(s).toMatchObject({ model: 'M5', direction: 'bullish', entry: 105, tpLiquidity: null, expiryCandles: 16 })
    expect(s.poi).toMatchObject({ kind: 'BO', timeframe: '4h', level: 101 })
    expect(s.sl).toBeCloseTo(105 - 3 * atr, 9)
    // known on the close of the breakout 4h candle = last 15m candle inside it
    expect(s.createdT).toBe(T0 + 31 * H4 - M15)
    expect(s.status).toBe('pending')
    // never filled within 16 × 15m → expired
    expect(setups(CLOSES).list[0]!.status).toBe('expired')
  })

  it('fills when price comes back to the breakout close; not-fresh closes give no new setup', () => {
    const { list } = setups(CLOSES, { 31: 104.9 })
    expect(list).toHaveLength(1)
    expect(list[0]!.status).toBe('triggered')
    expect(setups(CLOSES, {}, { trendFreshOnly: false }).list.length).toBe(4)
  })

  it('EMA filter and long-only', () => {
    const down = [...Array.from({ length: 30 }, (_, i) => (i % 2 ? 100.5 : 99.5)), 95, 94]
    expect(setups(down).list[0]).toMatchObject({ direction: 'bearish', entry: 95 })
    expect(setups(down, {}, { trendLongOnly: true }).list).toHaveLength(0)
    // EMA 25 still above 95? no: a close below a long flat range is also below its EMA → kept
    expect(setups(down, {}, { trendEma: 25 }).list).toHaveLength(1)
  })

  it('backtest: trend plan trails only (no break-even at 1R)', () => {
    const { list, m15 } = setups(CLOSES, { 31: 104.9 })
    const plans = defaultPlans(defaultAppConfig.exit, defaultAppConfig.smc)
    const p = plans.find((x) => x.key === 'trend')!
    expect(p).toMatchObject({ tpMode: 'trail', ladder: [], trailGapR: 1, trailStepR: 0.25 })
    const r = simulateSetup(list[0]!, p, { entry: m15, entryTf: '15m', fees: { makerFeePct: 0.02, takerFeePct: 0.05, slippagePct: 0.02 }, expiry: 96 })
    expect(r.filledT).not.toBeNull()
  })
})

describe('killzone', () => {
  it('London 07–10 and New York 12–15 UTC', () => {
    const z = defaultAppConfig.smc.killzonesUtc
    expect(inKillzone(Date.UTC(2026, 0, 5, 7, 0), z)).toBe(true)
    expect(inKillzone(Date.UTC(2026, 0, 5, 9, 59), z)).toBe(true)
    expect(inKillzone(Date.UTC(2026, 0, 5, 10, 0), z)).toBe(false)
    expect(inKillzone(Date.UTC(2026, 0, 5, 13, 30), z)).toBe(true)
    expect(inKillzone(Date.UTC(2026, 0, 5, 20, 0), z)).toBe(false)
  })
})

describe('bot: M5', () => {
  const setup: ScreenerSetup = {
    id: 'X-M5',
    model: 'M5',
    entry: 100,
    sl: 94,
    tp: 220,
    tpLiquidity: null,
    rr: 20,
    score: 3,
    confluence: [],
    status: 'pending',
    createdT: 1_000_000,
    poi: { kind: 'BO', timeframe: '4h', origin: null },
    child: { kind: 'BREAKOUT', timeframe: '4h' },
    expiryCandles: 16
  }
  const cand: Candidate = { symbol: 'XUSDT', direction: 'bullish', price: 101, dataT: 0, setup, setups: [setup], nearPoi: null, trendAligned: false, trend: { '4h': null, '1h': null, '15m': null }, recentBos: null }
  const bot = { ...defaultAppConfig.bot, models: ['M5' as const], requireConfluence: ['fvg' as const, 'trendParent' as const] }

  it('uses its own required list (default: OI up with the move), not the SMC one', () => {
    const o = { entryTf: '15m' as const, universe: new Set(['XUSDT']), now: 1_000_000 + M15 + 60_000, exit: defaultAppConfig.exit }
    expect(setupGate(cand, { ...o, bot })).toMatch(/oiConfirm/)
    expect(setupGate({ ...cand, setup: { ...setup, confluence: ['oiConfirm'] } }, { ...o, bot })).toBeNull()
    expect(setupGate(cand, { ...o, bot: { ...bot, trendRequireConfluence: [] } })).toBeNull()
  })

  it('uses the trailing-only plan unless the coin has a profile', () => {
    const e = exitFor('M5', defaultAppConfig.exit, null, defaultAppConfig.smc)
    expect(e).toMatchObject(trendExit(defaultAppConfig.smc))
    expect(exitFor('M1', defaultAppConfig.exit, null, defaultAppConfig.smc)).toBe(defaultAppConfig.exit)
  })
})
