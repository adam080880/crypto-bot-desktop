import { describe, expect, it } from 'vitest'
import type { BtResult, BtSetup } from '@shared/backtest'
import { applyFilter, metaTable, simulateEquity, stats } from '@shared/backtestStats'
import type { Candle } from '@shared/candles'
import type { Poi } from '../strategy/setups'
import { poiTouch } from './engine'
import { splitTime } from './runBacktest'

const M = 15 * 60_000
const T0 = Date.UTC(2026, 5, 1)
const DAY = 86_400_000

const res = (r: number, f: number, x: number, s: BtResult['s'] = r > 0.05 ? 'w' : r < -0.05 ? 'l' : 'b'): BtResult => ({ s, f, x, r })
const bt = (p: Partial<BtSetup> & { res: BtResult[] }): BtSetup => ({
  id: Math.random().toString(36),
  t: p.res[0]?.f ?? T0,
  dir: 'bullish',
  model: 'M1',
  poiKind: 'OB',
  poiTf: '4h',
  origin: 'sweep',
  childKind: 'QM',
  childTf: '15m',
  score: 5,
  conf: ['fvg', 'trendParent'],
  entry: 100,
  sl: 99,
  slPct: 1,
  tpLiquidity: null,
  ...p
})

describe('backtest stats (renderer filters)', () => {
  it('counts wins / break-even / losses and the funnel per plan', () => {
    const list = [
      bt({ res: [res(1, T0, T0 + M), res(-1, T0, T0 + M)] }),
      bt({ res: [res(0, T0 + DAY, T0 + DAY + M), res(2, T0 + DAY, T0 + DAY + M)] }),
      bt({ res: [{ s: 'm', f: null, x: T0, r: 0 }, res(-1, T0 + 2 * DAY, T0 + 2 * DAY + M)] })
    ]
    expect(stats(list, 0)).toMatchObject({ trades: 2, wins: 1, be: 1, losses: 0, winrate: 0.5, noLoss: 1, totalR: 1, missed: 1, setups: 3 })
    expect(stats(list, 1)).toMatchObject({ trades: 3, totalR: 0, maxDdR: 1 })
  })

  it('filters by model, POI and required confluences', () => {
    const a = bt({ model: 'M4', poiTf: '15m', res: [] })
    const b = bt({ conf: ['fvg'], res: [] })
    const c = bt({ res: [] })
    const f = { models: ['M1' as const], dirs: [], pois: ['OB|4h'], childKinds: [], conf: ['fvg' as const, 'trendParent' as const], minScore: 0 }
    expect(applyFilter([a, b, c], f)).toEqual([c])
  })

  it('meta table: robust only when in-sample and out-of-sample are both positive', () => {
    const split = T0 + 10 * DAY
    const good = [0, 1, 2].map((i) => bt({ res: [res(1, T0 + i * DAY, T0 + i * DAY + M)] }))
    const goodOos = bt({ res: [res(1, split + DAY, split + DAY + M)] })
    const fitted = [0, 1, 2].map((i) => bt({ model: 'M4', res: [res(1, T0 + i * DAY, T0 + i * DAY + M)] }))
    const fittedOos = bt({ model: 'M4', res: [res(-1, split + DAY, split + DAY + M)] })
    const rows = metaTable([...good, goodOos, ...fitted, fittedOos].map((s) => ({ ...s, t: s.res[0]!.f! })), 1, split, 3)
    expect(rows.map((r) => [r.model, r.robust])).toEqual([
      ['M1', true],
      ['M4', false]
    ])
  })
})

describe('simulateEquity (shared)', () => {
  const opts = { startEquity: 10, riskPct: 1, maxLeverage: 5, maxDailyLossPct: 3 }

  it('risks a fixed % of current equity per trade (compounding)', () => {
    const sim = simulateEquity([bt({ res: [res(-1, T0, T0 + M)] }), bt({ res: [res(2, T0 + DAY, T0 + DAY + M)] })], 0, opts)
    expect(sim.endEquity).toBeCloseTo(9.9 + 0.198)
    expect(sim.taken).toBe(2)
    expect(sim.maxDdPct).toBeCloseTo(1)
  })

  it('skips a fill while a position on the symbol is still open', () => {
    const sim = simulateEquity([bt({ res: [res(1, T0, T0 + 10 * M)] }), bt({ res: [res(1, T0 + 5 * M, T0 + 20 * M)] })], 0, opts)
    expect(sim).toMatchObject({ taken: 1, skippedOpen: 1 })
  })

  it('caps the size at max leverage when the stop is very tight', () => {
    const sim = simulateEquity([bt({ slPct: 0.1, res: [res(-1, T0, T0 + M)] })], 0, opts)
    expect(sim.leverageCapped).toBe(1)
    expect(sim.endEquity).toBeCloseTo(10 - 0.05)
  })

  it('stops entering for the rest of the UTC day after the daily loss limit', () => {
    const losses = [0, 1, 2, 3].map((i) => bt({ res: [res(-1, T0 + i * 2 * M, T0 + (i * 2 + 1) * M)] }))
    const next = bt({ res: [res(1, T0 + DAY, T0 + DAY + M)] })
    const sim = simulateEquity([...losses, next], 0, { ...opts, maxDailyLossPct: 2.5 })
    expect(sim).toMatchObject({ taken: 4, skippedHalt: 1, maxLosingStreak: 3 })
  })
})

describe('poiTouch', () => {
  const poi: Poi = { kind: 'OB', timeframe: '1h', direction: 'bullish', level: 100, t: T0, activeFrom: T0, invalidT: null, origin: null }
  const c = (rows: [number, number, number, number][]): Candle[] => rows.map(([o, h, l, cl], i) => ({ t: T0 + i * M, o, h, l, c: cl, v: 1 }))

  it('races from the POI level: +X% before −X% counts as a win', () => {
    const t = poiTouch(poi, c([[101, 101.2, 100.6, 101], [101, 101.1, 99.9, 100.2], [100.2, 100.8, 100, 100.7], [100.7, 101.2, 100.6, 101.1]]), DAY)!
    expect(t.touchT).toBe(T0 + M)
    expect(t.race).toEqual(['win', 'win', 'timeout'])
    expect(t.maePct).toBeCloseTo(0.1)
  })

  it('counts the adverse side first, including the touch candle', () => {
    const t = poiTouch(poi, c([[101, 101, 99.4, 101.5], [101.5, 102.5, 101, 102.4]]), DAY)!
    expect(t.race).toEqual(['loss', 'win', 'win'])
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
