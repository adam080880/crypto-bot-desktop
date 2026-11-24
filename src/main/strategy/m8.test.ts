import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import type { Dir } from '@shared/smc'
import type { SmcAnalysisFull } from './analyze'
import { modelM8, type Poi } from './setups'
import { cfg, T0 } from './testkit'

const H4 = 4 * 3_600_000
const M15 = 15 * 60_000
const DAY = 86_400_000

/** Flat 4h history before T0 (each candle 100–102 → ATR 2). */
const h4: Candle[] = Array.from({ length: 30 }, (_, i) => ({ t: T0 - (30 - i) * H4, o: 101, h: 102, l: 100, c: 101, v: 1 }))
const an = (tf: SmcAnalysisFull['timeframe'], candles: Candle[], trend: Dir | null = null): SmcAnalysisFull =>
  ({ timeframe: tf, candles, trendChanges: trend ? [{ t: T0 - 20 * DAY, trend }] : [] }) as unknown as SmcAnalysisFull
/** 15m candles from T0 by lows; high = low + 0.4, close = low + 0.2. */
const m15 = (lows: number[]): Candle[] => lows.map((l, i) => ({ t: T0 + i * M15, o: l + 0.2, h: l + 0.4, l, c: l + 0.2, v: 1 }))
const rbs = (p: Partial<Poi> = {}): Poi => ({ kind: 'RBS', timeframe: '4h', direction: 'bullish', level: 100, t: T0 - 10 * H4, activeFrom: T0, invalidT: null, origin: null, extreme: 98.5, ...p })

function run(lows: number[], o: { btc?: Dir; d1?: Dir; poi?: Partial<Poi>; c?: Parameters<typeof cfg>[0] } = {}) {
  const entry = an('15m', m15(lows))
  const all = [entry, an('4h', h4), an('1d', [], o.d1 ?? 'bullish')]
  return modelM8({ symbol: 'X', entry, poiAnalyses: all.slice(1), cfg: cfg({ models: ['M8'], ...o.c }), btc: { '4h': an('4h', [], o.btc ?? 'bullish') } }, all, [rbs(o.poi)])
}

describe('M8 HTF POI with the trend', () => {
  it('arms a long limit at the POI line once price is within 1R, SL beyond the POI extreme', () => {
    const d = run([106, 104, 102, 101.2, 100.8, 100.5])
    expect(d).toHaveLength(1)
    // ATR 2: SL = 98.5 − 0.2 = 98.3 (1.7 % ≥ 1 %); first close within 1.7 of 100 is #3 (101.4)
    expect(d[0]).toMatchObject({ model: 'M8', dir: 'bullish', entry: 100, knownIdx: 3, expiry: 32 })
    expect(d[0]!.sl).toBeCloseTo(98.3, 6)
  })

  it('needs BTC 4h and the 1d trend on its side', () => {
    expect(run([106, 104, 102, 101.2], { btc: 'bearish' })).toHaveLength(0)
    expect(run([106, 104, 102, 101.2], { d1: 'bearish' })).toHaveLength(0)
    expect(run([106, 104, 102, 101.2], { btc: 'bearish', c: { m8RequireBtc4h: false } })).toHaveLength(1)
  })

  it('skips a POI whose stop would be under m8MinSlPct', () => {
    expect(run([106, 104, 102, 101.2], { c: { m8MinSlPct: 2 } })).toHaveLength(0)
  })

  it('skips a POI whose stop would be wider than m8MaxSlPct (0 = no cap)', () => {
    // SL 1.7 % below the line
    expect(run([106, 104, 102, 101.2], { c: { m8MaxSlPct: 1.5 } })).toHaveLength(0)
    expect(run([106, 104, 102, 101.2], { c: { m8MaxSlPct: 2 } })).toHaveLength(1)
    expect(run([106, 104, 102, 101.2], { c: { m8MaxSlPct: 0 } })).toHaveLength(1)
  })

  it('only the first touch: a touch before the order is armed uses the POI up', () => {
    // #1 wicks to 99.9 before any close came within 1R → that was the first touch; later approaches are ignored
    expect(run([106, 99.9, 104, 101.2, 100.6])).toHaveLength(0)
  })

  it('re-arms after an unfilled limit expires while the POI is still untouched, not after a touch', () => {
    const near = Array.from({ length: 10 }, () => 101)
    // armed at #0, expires after 4 candles without a touch → armed again at #5
    expect(run(near, { c: { m8ExpiryCandles: 4 } }).map((x) => x.knownIdx)).toEqual([0, 5])
    // a touch inside the first window (#2) ends the POI
    const touched = [101, 101, 99.9, 101, 101, 101, 101, 101]
    expect(run(touched, { c: { m8ExpiryCandles: 4 } }).map((x) => x.knownIdx)).toEqual([0])
  })

  it('ignores POI kinds / timeframes outside m8Kinds / m8PoiTimeframes', () => {
    expect(run([106, 104, 102, 101.2], { poi: { kind: 'OB' } })).toHaveLength(0)
    expect(run([106, 104, 102, 101.2], { poi: { timeframe: '1h' } })).toHaveLength(0)
  })
})
