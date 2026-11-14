import { describe, expect, it } from 'vitest'
import { rotationConfigSchema } from '@shared/rotation'
import { emptyState, mark, nextRebalanceAt, rankUniverse, rebalance, targets, type CoinDaily } from './paper'

const D = 20_000 // a day index
const coin = (symbol: string, firstDay: number, closeAt: (d: number) => number, vol = 1): CoinDaily => {
  const close = new Map<number, number>()
  const qv = new Map<number, number>()
  for (let d = firstDay; d <= D; d++) {
    close.set(d, closeAt(d))
    qv.set(d, vol)
  }
  return { symbol, firstDay, close, qv }
}
const cfg = { ...rotationConfigSchema.parse({ lookbackDays: 10, perSide: 1, minAgeDays: 20 }), universe: 3 }

describe('rankUniverse (point in time)', () => {
  const coins = [
    coin('AUSDT', D - 100, (d) => 100 + (d - (D - 100)), 5), // up
    coin('BUSDT', D - 100, () => 50, 4), // flat
    coin('CUSDT', D - 100, (d) => 200 - (d - (D - 100)), 3), // down
    coin('DUSDT', D - 100, (d) => 10 * 2 ** ((d - (D - 100)) / 10), 0.1), // best return but least traded → outside top 3
    coin('NEWUSDT', D - 5, (d) => d - D + 50, 99) // listed 5 days ago → too young
  ]
  it('takes the most traded coins old enough, then sorts by lookback return', () => {
    const rows = rankUniverse(coins, D, cfg)
    expect(rows.map((r) => r.symbol)).toEqual(['AUSDT', 'BUSDT', 'CUSDT'])
    expect(rows[0]!.ret).toBeCloseTo(200 / 190 - 1, 9)
  })
  it('targets: long the strongest, short the weakest, half the equity per side', () => {
    const w = targets(rankUniverse(coins, D, cfg), cfg)
    expect([...w]).toEqual([
      ['AUSDT', 0.5],
      ['CUSDT', -0.5]
    ])
    expect([...targets(rankUniverse(coins, D, cfg), { ...cfg, longShort: false })]).toEqual([['AUSDT', 1]])
  })
})

describe('paper accounting', () => {
  const base = { ...emptyState(rotationConfigSchema.parse({ startEquity: 1000, costPct: 0.1 })), running: true }
  const prices = new Map([
    ['AUSDT', 10],
    ['CUSDT', 20]
  ])
  const w = new Map([
    ['AUSDT', 0.5],
    ['CUSDT', -0.5]
  ])

  it('rebalance: units from equity × weight, cost on the traded notional', () => {
    const s = rebalance(base, D, w, (x) => prices.get(x))
    expect(s.positions.find((p) => p.symbol === 'AUSDT')).toMatchObject({ side: 'long', qty: 50, entryPrice: 10 })
    expect(s.positions.find((p) => p.symbol === 'CUSDT')).toMatchObject({ side: 'short', qty: -25 })
    expect(s.rebalances[0]).toMatchObject({ turnover: 1, cost: 1, longs: ['AUSDT'], shorts: ['CUSDT'] })
    expect(s.equity).toBe(999)
  })

  it('mark: long gains when price rises, short gains when it falls; long pays positive funding', () => {
    const s = rebalance(base, D, w, (x) => prices.get(x))
    const next = new Map([
      ['AUSDT', 11],
      ['CUSDT', 18]
    ])
    // funding +0.01% on both since the last mark
    const m = mark(s, D + 1, (x) => next.get(x), () => 0.0001, 100)
    const pnl = 50 * 1 + -25 * -2 // +50 long, +50 short
    const fund = -0.0001 * 50 * 10 + -0.0001 * -25 * 20 // long pays 0.05, short receives 0.05
    expect(m.equity).toBeCloseTo(999 + pnl + fund, 9)
    expect(m.curve.at(-1)).toMatchObject({ t: (D + 1) * 86_400_000, btc: 100 })
    expect(m.lastDay).toBe(D + 1)
  })

  it('drawdown is tracked from the peak; a coin without a new close keeps its last price', () => {
    const s = rebalance(base, D, w, (x) => prices.get(x))
    const up = mark(s, D + 1, (x) => (x === 'AUSDT' ? 12 : 20), () => 0, null)
    const down = mark(up, D + 2, (x) => (x === 'AUSDT' ? 9 : undefined), () => 0, null)
    expect(down.positions.find((p) => p.symbol === 'CUSDT')!.lastPrice).toBe(20)
    expect(down.maxDdPct).toBeCloseTo(((up.equity - down.equity) / up.equity) * 100, 9)
  })

  it('next rebalance: 00:30 UTC on the chosen weekday, strictly after now', () => {
    const mon = Date.UTC(2026, 10, 16, 0, 30) // Monday
    expect(nextRebalanceAt(Date.UTC(2026, 10, 14, 12), 1)).toBe(mon)
    expect(nextRebalanceAt(mon, 1)).toBe(mon + 7 * 86_400_000)
    expect(nextRebalanceAt(Date.UTC(2026, 10, 16, 0, 10), 1)).toBe(mon)
  })
})
