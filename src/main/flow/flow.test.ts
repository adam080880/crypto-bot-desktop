import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { smcConfigSchema } from '@shared/config'
import { openDatabase } from '../db/client'
import { flowAt, flowConfluence, type FlowData } from '../strategy/flow'
import { FlowRepo } from './flowRepo'
import { parseFundingCsv, parseMetricsCsv } from './visionFlow'

const H = 3_600_000
const T = Date.UTC(2026, 0, 10)
const cfg = smcConfigSchema.parse({})

/** Hourly OI from `T − 30h` to `T`, value given per hours-before-T. */
function oiSeries(at: (hoursBefore: number) => number): FlowData['oi'] {
  return Array.from({ length: 31 }, (_, i) => ({ t: T - (30 - i) * H, v: at(30 - i) }))
}
const funding = (rates: number[]): FlowData['funding'] => rates.map((r, i) => ({ t: T - (rates.length - i) * 8 * H, r }))

describe('flow features', () => {
  it('OI change over 4h / 24h and the funding percentile, no look-ahead', () => {
    const f: FlowData = { oi: [...oiSeries((h) => 100 + (30 - h)), { t: T + H, v: 999 }], funding: funding(Array.from({ length: 20 }, (_, i) => i / 10000)) }
    const s = flowAt(f, T)
    expect(s.oiChg4h).toBeCloseTo(130 / 126 - 1, 9)
    expect(s.oiChg24h).toBeCloseTo(130 / 106 - 1, 9)
    // latest settlement is the highest of 20 → percentile 1
    expect(s.fundingPct).toBe(1)
    expect(s.funding).toBeCloseTo(0.0019, 9)
  })

  it('tags: oiConfirm needs OI up AND price moving with the trade', () => {
    const f: FlowData = { oi: oiSeries((h) => 100 + (30 - h)), funding: [] }
    expect(flowConfluence(f, T, 'bullish', 0.02, cfg)).toContain('oiConfirm')
    expect(flowConfluence(f, T, 'bullish', -0.02, cfg)).not.toContain('oiConfirm')
    expect(flowConfluence(f, T, 'bearish', -0.02, cfg)).toContain('oiConfirm')
  })

  it('tags: oiFlush when OI fell ≥ 1% over 4h; fundingContra in the opposite tail', () => {
    const drop: FlowData = { oi: oiSeries((h) => (h >= 4 ? 100 : 98)), funding: funding([...Array.from({ length: 19 }, () => 0.0001), -0.0005]) }
    const tags = flowConfluence(drop, T, 'bullish', 0, cfg)
    expect(tags).toEqual(expect.arrayContaining(['oiFlush', 'fundingContra']))
    // the crowd is short (lowest funding): a short is WITH the crowd
    expect(flowConfluence(drop, T, 'bearish', 0, cfg)).not.toContain('fundingContra')
  })

  it('missing or stale data → no tags', () => {
    expect(flowConfluence(undefined, T, 'bullish', 0.1, cfg)).toEqual([])
    const stale: FlowData = { oi: oiSeries(() => 100).map((x) => ({ ...x, t: x.t - 10 * H })), funding: funding([0.0001, 0.0002]) }
    const s = flowAt(stale, T)
    expect(s.oiChg4h).toBeNull()
    expect(s.fundingPct).toBeNull() // fewer than 15 settlements
  })
})

describe('data.binance.vision parsers', () => {
  it('metrics: keeps the on-the-hour rows (OI value column)', () => {
    const csv = [
      'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio',
      '2025-01-01 00:00:00,BTCUSDT,91253.336,8545728911.06,1.8,2.1,1.8,0.76',
      '2025-01-01 00:05:00,BTCUSDT,91236.202,8538844785.07,1.8,2.1,1.8,0.98',
      '2025-01-01 01:00:00,BTCUSDT,91000,8500000000,1.8,2.1,1.8,0.9'
    ].join('\n')
    expect(parseMetricsCsv(csv)).toEqual([
      { t: Date.UTC(2025, 0, 1, 0), v: 8545728911.06 },
      { t: Date.UTC(2025, 0, 1, 1), v: 8500000000 }
    ])
  })

  it('funding', () => {
    expect(parseFundingCsv('calc_time,funding_interval_hours,last_funding_rate\n1730419200000,8,0.00010000\n')).toEqual([{ t: 1730419200000, r: 0.0001 }])
  })
})

describe('FlowRepo', () => {
  it('stores, reads oldest first, prunes OI after 3 days and funding after 35', () => {
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    const repo = new FlowRepo(db)
    repo.saveOi(1, [
      { t: T - 4 * 86_400_000, v: 1 },
      { t: T, v: 2 }
    ])
    repo.saveFunding(1, [
      { t: T - 40 * 86_400_000, r: 0.1 },
      { t: T - H, r: 0.2 }
    ])
    expect(repo.lastOiT(1)).toBe(T)
    expect(repo.prune(T)).toEqual({ oi: 1, funding: 1 })
    expect(repo.get(1)).toEqual({ oi: [{ t: T, v: 2 }], funding: [{ t: T - H, r: 0.2 }] })
    db.$client.close()
  })
})
