import { describe, expect, it } from 'vitest'
import { screenerConfigSchema } from '@shared/config'
import type { Setup } from '@shared/smc'
import type { Poi } from '../strategy/setups'
import { rankRows, screenSymbol, type ScreenInput } from './screen'

const H = 3_600_000
const NOW = Date.UTC(2026, 10, 11, 12)
const cfg = screenerConfigSchema.parse({})

const poi = (p: Partial<Poi>): Poi => ({
  kind: 'OB',
  timeframe: '4h',
  direction: 'bullish',
  level: 99.5,
  t: NOW - 50 * H,
  activeFrom: NOW - 40 * H,
  invalidT: null,
  origin: null,
  ...p
})

const setup = (s: Partial<Setup>): Setup => ({
  id: 'x',
  symbol: 'AAAUSDT',
  direction: 'bullish',
  model: 'M1',
  poi: { kind: 'OB', timeframe: '1h', level: 99, t: NOW - 10 * H, hitT: NOW - 3 * H, origin: 'sweep' },
  child: { kind: 'OB', timeframe: '15m', t: NOW - 2 * H, level: 99.2, extreme: 98.9, hasFvg: true, origin: 'sweep' },
  tpLiquidity: null,
  confluence: [],
  entry: 99.2,
  sl: 98.8,
  tp: 101,
  rr: 4.5,
  score: 3,
  reasons: [],
  createdT: NOW - 2 * H,
  status: 'pending',
  statusT: null,
  filledT: null,
  ...s
})

const input = (p: Partial<ScreenInput>): ScreenInput => ({
  symbol: 'AAAUSDT',
  price: 100,
  priceT: NOW - 60_000,
  trend: { '4h': null, '1h': null, '15m': null },
  pois: [],
  setups: [],
  lastBreak: { '15m': null, '1h': null, '4h': null },
  ...p
})

describe('screenSymbol', () => {
  it('returns nothing without an entry location or recent BOS (trend alone is not enough)', () => {
    const rows = screenSymbol(input({ trend: { '4h': 'bullish', '1h': 'bullish', '15m': 'bullish' } }), cfg, NOW)
    expect(rows).toEqual([])
  })

  it('picks the nearest POI on the correct side within nearPoiPct', () => {
    const rows = screenSymbol(
      input({
        pois: [
          poi({ level: 99.5 }), // 0.5% below → candidate
          poi({ level: 99.8, timeframe: '1h' }), // closer → wins
          poi({ level: 100.5 }), // bullish above price → wrong side
          poi({ level: 98.5 }), // 1.5% → too far
          poi({ level: 99.9, timeframe: '15m' }), // TF not screened by default
          poi({ level: 100.6, direction: 'bearish', kind: 'SBR' })
        ]
      }),
      cfg,
      NOW
    )
    expect(rows.map((r) => [r.direction, r.nearPoi?.kind, r.nearPoi?.timeframe, r.nearPoi?.level])).toEqual([
      ['bullish', 'OB', '1h', 99.8],
      ['bearish', 'SBR', '4h', 100.6]
    ])
    expect(rows[0]!.nearPoi!.distPct).toBeCloseTo(0.2)
  })

  it('keeps only active setups and takes the newest one per direction', () => {
    const rows = screenSymbol(
      input({
        setups: [
          setup({ id: 'old', createdT: NOW - 5 * H }),
          setup({ id: 'new', createdT: NOW - H, status: 'triggered' }),
          setup({ id: 'done', createdT: NOW, status: 'win' }),
          setup({ id: 'short', direction: 'bearish', status: 'expired' })
        ]
      }),
      cfg,
      NOW
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.setup).toMatchObject({ id: 'new', status: 'triggered', poi: { kind: 'OB', timeframe: '1h' } })
  })

  it('flags a BOS only in the same direction and within bosRecentHours (from candle close)', () => {
    const recent = { t: NOW - 5 * H, direction: 'bearish' as const, level: 101, swingT: NOW - 20 * H }
    const old = { t: NOW - 30 * H, direction: 'bullish' as const, level: 97, swingT: NOW - 40 * H }
    const rows = screenSymbol(input({ lastBreak: { '15m': null, '1h': recent, '4h': old } }), cfg, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ direction: 'bearish', recentBos: { timeframe: '1h', level: 101 } })
  })

  it('marks trend alignment per direction', () => {
    const trend = { '4h': 'bullish' as const, '1h': 'bullish' as const, '15m': 'bullish' as const }
    const rows = screenSymbol(input({ trend, pois: [poi({}), poi({ direction: 'bearish', level: 100.4 })] }), cfg, NOW)
    expect(rows.map((r) => [r.direction, r.trendAligned])).toEqual([
      ['bullish', true],
      ['bearish', false]
    ])
  })
})

describe('rankRows', () => {
  it('puts setups first, then more criteria, then closer POIs', () => {
    const base = screenSymbol(input({ pois: [poi({ level: 99.2 })] }), cfg, NOW)[0]!
    const a = { ...base, symbol: 'A', nearPoi: { ...base.nearPoi!, distPct: 0.9 } }
    const b = { ...base, symbol: 'B', nearPoi: { ...base.nearPoi!, distPct: 0.1 } }
    const c = { ...base, symbol: 'C', trendAligned: true, nearPoi: { ...base.nearPoi!, distPct: 0.9 } }
    const d = { ...base, symbol: 'D', setup: screenSymbol(input({ setups: [setup({})] }), cfg, NOW)[0]!.setup }
    expect(rankRows([a, b, c, d]).map((r) => r.symbol)).toEqual(['D', 'C', 'B', 'A'])
  })
})
