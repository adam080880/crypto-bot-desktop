import { describe, expect, it } from 'vitest'
import { analyzeSmc } from './analyze'
import { atrSeries } from './atr'
import { detectSetups, liquidityBehindSl, poiLiqIntact, stackedTfs, trendKnownAt, type Poi } from './setups'
import { at, bars, cfg } from './testkit'

type Row = [number, number, number, number]
const ROWS: Row[] = [
  [11, 11.5, 10.9, 11.4],
  [11.4, 12.0, 11.3, 11.9],
  [11.9, 12.5, 11.8, 11.9], // 2 swing high 12.5
  [11.9, 12.0, 10.0, 10.2],
  [10.2, 10.3, 9.0, 9.2],
  [9.2, 9.4, 8.0, 8.2],
  [8.2, 8.5, 7.6, 8.0], // 6 red, lower wick 0.4
  [8.0, 8.6, 6.5, 8.4], // 7 GREEN long lower wick → OB (line 8.0)
  [8.4, 9.0, 8.2, 8.9],
  [8.9, 9.6, 8.8, 9.5], // FVG
  [9.5, 10, 9.4, 9.9], // 10 swing high 10.0 → TP target
  [9.9, 9.95, 9.0, 9.1],
  [9.1, 9.2, 8.6, 8.7],
  [8.7, 8.8, 8.3, 8.4], // 13 red
  [8.4, 8.9, 7.95, 8.6], // 14 GREEN, wick hits OB line 8.0 → OB valid (line 8.4)
  [8.6, 9.2, 8.5, 9.1], // closes above 8.9
  [9.1, 9.6, 9.0, 9.5], // FVG from OB valid
  [9.5, 9.8, 9.4, 9.7],
  [9.7, 9.75, 8.35, 8.5], // 18 limit 8.4 filled
  [8.5, 10.1, 8.45, 10.0] // 19 TP 10.0 hit → win
]

describe('setups: POI hit → OB valid (§8)', () => {
  it('builds a scored long setup and follows it to the target', () => {
    const c = cfg({ minRR: 2, models: ['M0'] })
    const entry = analyzeSmc(bars(ROWS), '15m', c)
    const setups = detectSetups({ symbol: 'TESTUSDT', entry, poiAnalyses: [], cfg: c })
    const s = setups.find((x) => x.child.t === at(14))!
    expect(s).toBeDefined()
    expect(s.direction).toBe('bullish')
    expect(s.model).toBe('M0')
    expect(s.poi).toMatchObject({ level: 8.0, hitT: at(14) })
    expect(s.entry).toBe(8.4)
    expect(s.sl).toBeCloseTo(7.95 * 0.999, 6)
    expect(s.tp).toBe(10)
    expect(s.rr).toBeGreaterThanOrEqual(2)
    expect(s.child.hasFvg).toBe(true)
    expect(s.createdT).toBe(at(16))
    expect(s.status).toBe('win')
    expect(s.statusT).toBe(at(19))
    expect(s.confluence).toContain('prevOpposite')
  })

  it('tags btcDom: alt long while BTC dominance trends down, BTC long while it trends up', () => {
    const c = cfg({ minRR: 2, models: ['M0'] })
    const entry = analyzeSmc(bars(ROWS), '15m', c)
    const dom = (trend: 'bullish' | 'bearish') => ({ timeframe: '4h' as const, trendChanges: [{ t: at(0) - 8 * 3_600_000, trend }] })
    const tags = (symbol: string, trend: 'bullish' | 'bearish') =>
      detectSetups({ symbol, entry, poiAnalyses: [], cfg: c, btcDom: dom(trend) }).find((x) => x.child.t === at(14))!.confluence
    expect(tags('TESTUSDT', 'bearish')).toContain('btcDom')
    expect(tags('TESTUSDT', 'bullish')).not.toContain('btcDom')
    expect(tags('BTCUSDT', 'bullish')).toContain('btcDom')
    expect(tags('BTCUSDT', 'bearish')).not.toContain('btcDom')
    // a dominance change that only closes after the setup is known does not count (no look-ahead)
    const late = { timeframe: '4h' as const, trendChanges: [{ t: at(30), trend: 'bearish' as const }] }
    expect(detectSetups({ symbol: 'TESTUSDT', entry, poiAnalyses: [], cfg: c, btcDom: late }).find((x) => x.child.t === at(14))!.confluence).not.toContain('btcDom')
  })

  it('widens a stop tighter than minSlAtr × ATR14 (entry unchanged)', () => {
    const c = cfg({ minRR: 0.5, models: ['M0'], minSlAtr: 3 })
    const entry = analyzeSmc(bars(ROWS), '15m', c)
    const s = detectSetups({ symbol: 'TESTUSDT', entry, poiAnalyses: [], cfg: c }).find((x) => x.child.t === at(14))!
    expect(s.entry).toBe(8.4)
    expect(s.sl).toBeLessThan(7.95 * 0.999)
    const atr = atrSeries(entry.candles, 14)[entry.candles.findIndex((k) => k.t === at(16))]!
    expect(s.entry - s.sl).toBeCloseTo(3 * atr, 6)
  })

  it('skips the setup when RR is below the minimum', () => {
    const c = cfg({ minRR: 5, models: ['M0'] })
    const entry = analyzeSmc(bars(ROWS), '15m', c)
    expect(detectSetups({ symbol: 'T', entry, poiAnalyses: [], cfg: c }).filter((x) => x.child.t === at(14))).toHaveLength(0)
  })

  it('needs a green OB valid for a long (colour rule)', () => {
    const rows = ROWS.map((r) => [...r] as Row)
    rows[14] = [8.6, 8.9, 7.95, 8.4] // red instead of green
    const c = cfg({ models: ['M0'] })
    const entry = analyzeSmc(bars(rows), '15m', c)
    expect(detectSetups({ symbol: 'T', entry, poiAnalyses: [], cfg: c }).filter((x) => x.child.t === at(14))).toHaveLength(0)
  })
})

describe('trendKnownAt (no look-ahead in the trend score)', () => {
  const H = 3_600_000
  const t0 = Date.UTC(2026, 10, 2, 8) // 4h candle 08:00–12:00 UTC
  const a = { timeframe: '4h' as const, trendChanges: [{ t: t0 - 8 * H, trend: 'bearish' as const }, { t: t0, trend: 'bullish' as const }] }

  it('ignores a break whose higher-TF candle has not closed yet', () => {
    expect(trendKnownAt(a, t0 + H)).toBe('bearish') // 15m setup at 09:00 can't see the 4h close of 12:00
    expect(trendKnownAt(a, t0 + 4 * H - 1)).toBe('bearish')
  })

  it('uses the break once its candle has closed', () => {
    expect(trendKnownAt(a, t0 + 4 * H)).toBe('bullish')
    expect(trendKnownAt(a, t0 - 9 * H)).toBe(null)
  })
})

describe('setups: limit cancelled when price reaches the TP first', () => {
  it("marks the setup 'missed' (no trade) instead of filling it later", () => {
    const rows = ROWS.map((r) => [...r] as Row)
    rows[17] = [9.5, 10.2, 9.4, 10.1] // TP 10.0 reached before the limit 8.4 filled
    const c = cfg({ minRR: 2, models: ['M0'] })
    const entry = analyzeSmc(bars(rows), '15m', c)
    const s = detectSetups({ symbol: 'T', entry, poiAnalyses: [], cfg: c }).find((x) => x.child.t === at(14))!
    expect(s.status).toBe('missed')
    expect(s.statusT).toBe(at(17))
    expect(s.filledT).toBeNull()
  })

  it('records the fill candle of a closed trade', () => {
    const c = cfg({ minRR: 2, models: ['M0'] })
    const entry = analyzeSmc(bars(ROWS), '15m', c)
    const s = detectSetups({ symbol: 'T', entry, poiAnalyses: [], cfg: c }).find((x) => x.child.t === at(14))!
    expect(s.filledT).toBe(at(18))
  })
})

describe('liquidity tags (user 2026-11-18)', () => {
  it('poiLiq: the POI extreme was not traded through between the hit and the OB valid', () => {
    const c = bars([
      [10, 10.2, 9.8, 10],
      [10, 10.1, 9.5, 9.9], // hit, low 9.5
      [9.9, 10.3, 9.6, 10.2]
    ])
    expect(poiLiqIntact(c, { direction: 'bullish', extreme: 9.4 }, 1, 2)).toBe(true)
    expect(poiLiqIntact(c, { direction: 'bullish', extreme: 9.55 }, 1, 2)).toBe(false) // wick swept
    expect(poiLiqIntact(c, { direction: 'bearish', extreme: 10.25 }, 1, 2)).toBe(false)
    expect(poiLiqIntact(c, { direction: 'bullish' }, 1, 2)).toBe(false) // unknown extreme
  })

  it('slLiqClear: unswept swing just behind the SL counts, swept / far / later ones do not', () => {
    const c = cfg({ models: ['M0'] })
    const a = analyzeSmc(bars(ROWS), '15m', c)
    const lows = a.liquidity.filter((l) => l.kind === 'swing' && l.side === 'sell')
    expect(lows.length).toBeGreaterThan(0)
    const end = at(ROWS.length) + 3_600_000
    const unswept = lows.find((l) => l.sweptT === null)
    expect(unswept).toBeDefined()
    if (unswept) {
      // SL just above that low → liquidity right behind the stop
      expect(liquidityBehindSl([a], true, unswept.top + 0.01, 0.5, end)).toBe(true)
      // zone too small to reach it
      expect(liquidityBehindSl([a], true, unswept.top + 1, 0.5, end)).toBe(false)
      // not known yet at the start of the data
      expect(liquidityBehindSl([a], true, unswept.top + 0.01, 0.5, at(0))).toBe(false)
    }
    // short side looks for buy-side liquidity (highs) above the SL
    expect(liquidityBehindSl([a], false, 1000, 1, end)).toBe(false)
  })
})

describe('stackedTfs (poiStack)', () => {
  const P = (o: Partial<Poi>): Poi => ({ kind: 'OB', timeframe: '4h', direction: 'bullish', level: 100, t: 0, activeFrom: 1000, invalidT: null, origin: 'sweep', ...o })
  const parent = { timeframe: '1h' as const, level: 100 }
  it('counts an active same-direction POI of another TF ≥ 1h near the parent level', () => {
    expect(stackedTfs([P({}), P({ timeframe: '1d', level: 100.2 })], parent, 'bullish', 2000, 0.3).sort()).toEqual(['1d', '4h'])
  })
  it('ignores own TF, 15m, other direction, too far, not yet known, invalidated and OCL Break', () => {
    const pois = [
      P({ timeframe: '1h' }),
      P({ timeframe: '15m' }),
      P({ direction: 'bearish' }),
      P({ level: 101 }),
      P({ activeFrom: 30_000_000 }),
      P({ invalidT: 0 }),
      P({ kind: 'OCL_BREAK' })
    ]
    expect(stackedTfs(pois, parent, 'bullish', 20_000_000, 0.3)).toEqual([])
  })
})
