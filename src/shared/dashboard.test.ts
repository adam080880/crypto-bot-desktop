import { describe, expect, it } from 'vitest'
import type { BotTrade } from './bot'
import { breakdown, buckets, closedIn, maxDdUsd, openSummary, pnlCurve, utcWeek } from './dashboard'

const D = 86_400_000
const T0 = Date.UTC(2026, 10, 23) // Monday
let n = 0
const tr = (p: Partial<BotTrade>): BotTrade =>
  ({
    id: `t${++n}`,
    mode: 'live',
    setupId: `s${n}`,
    symbol: 'AAAUSDT',
    direction: 'bullish',
    model: 'M8',
    confluence: [],
    poi: { kind: 'RBS', timeframe: '4h' },
    score: 3,
    analysisId: null,
    confidence: null,
    entry: 100,
    sl: 99,
    slInitial: 99,
    tp: 103,
    qty: 1,
    closedQty: 0,
    realized: 0,
    partials: 0,
    slSeq: 0,
    exitPlan: null,
    exitState: null,
    equity: 100,
    riskUsd: 1,
    leverage: 10,
    status: 'closed',
    reason: 'tp',
    createdAt: T0,
    expiresAt: T0 + D,
    filledAt: T0,
    filledQty: 1,
    closedAt: T0 + 3_600_000,
    exitPrice: null,
    pnl: 1,
    entryOrderId: null,
    slOrderId: null,
    tpOrderId: null,
    ...p
  }) as BotTrade

const all = { from: null, to: null, models: [], dir: 'all' as const }

describe('dashboard', () => {
  it('utcWeek starts on Monday', () => {
    expect(utcWeek(T0 + 3 * D + 5000)).toBe(T0)
    expect(utcWeek(T0 - 1)).toBe(T0 - 7 * D)
  })

  it('closedIn filters by close time, model and direction; skips open / unfilled', () => {
    const ts = [
      tr({ closedAt: T0 + 1000 }),
      tr({ closedAt: T0 + 2 * D, model: 'M0' }),
      tr({ closedAt: T0 + 3 * D, direction: 'bearish' }),
      tr({ status: 'open', closedAt: null, pnl: null }),
      tr({ status: 'cancelled', filledAt: null, pnl: null })
    ]
    expect(closedIn(ts, all)).toHaveLength(3)
    expect(closedIn(ts, { ...all, from: T0 + D, to: T0 + 3 * D })).toHaveLength(1)
    expect(closedIn(ts, { ...all, models: ['M8'] })).toHaveLength(2)
    expect(closedIn(ts, { ...all, dir: 'bearish' })).toHaveLength(1)
  })

  it('buckets, curve and drawdown', () => {
    const c = closedIn([tr({ closedAt: T0 + 10, pnl: 2 }), tr({ closedAt: T0 + 20, pnl: -1.5 }), tr({ closedAt: T0 + 8 * D, pnl: 1 })], all)
    const w = buckets(c, 'week')
    expect(w.map((b) => b.start)).toEqual([T0, T0 + 7 * D])
    expect(w[0]!.stat.pnl).toBeCloseTo(0.5)
    expect(buckets(c, 'day')).toHaveLength(2)
    const curve = pnlCurve(c)
    expect(curve.map((p) => p.pnl)).toEqual([2, 0.5, 1.5])
    expect(maxDdUsd(curve)).toBeCloseTo(1.5)
  })

  it('breakdown sorts by total R', () => {
    const c = closedIn([tr({ poi: { kind: 'SBR', timeframe: '1d' }, pnl: 3 }), tr({ pnl: -1 }), tr({ pnl: -1 })], all)
    const rows = breakdown(c, 'poiTf')
    expect(rows.map((r) => [r.key, r.trades, r.totalR])).toEqual([
      ['1d', 1, 3],
      ['4h', 2, -2]
    ])
  })

  it('openSummary: floating PnL at the mark, stop result, pending risk', () => {
    const ts = [
      tr({ status: 'open', closedAt: null, pnl: null, symbol: 'AAAUSDT', qty: 2, filledQty: 2, riskUsd: 2 }),
      tr({ status: 'open', closedAt: null, pnl: null, symbol: 'BBBUSDT', direction: 'bearish', entry: 50, sl: 49, slInitial: 51 }),
      tr({ status: 'open', closedAt: null, pnl: null, symbol: 'CCCUSDT' }),
      tr({ status: 'pending', closedAt: null, pnl: null, filledAt: null, riskUsd: 0.5 })
    ]
    const s = openSummary(ts, { AAAUSDT: { price: 101, t: 1 }, BBBUSDT: { price: 48, t: 1 } }, all)
    expect(s.rows).toHaveLength(3)
    expect(s.upnl).toBeCloseTo(2 + 2)
    expect(s.r).toBeCloseTo(1 + 2)
    expect(s.noMark).toBe(1)
    // AAA long stop 99: −2; BBB short stop moved to 49: +1; CCC: −1
    expect(s.atStop).toBeCloseTo(-2)
    expect(s.pending).toMatchObject({ count: 1, risk: 0.5 })
  })
})
