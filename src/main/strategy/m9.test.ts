import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import type { SmcAnalysisFull } from './analyze'
import { InducementIndex } from './inducement'
import { modelM9, type Poi } from './setups'
import type { Pivot } from './swings'
import { cfg, T0 } from './testkit'

const H4 = 4 * 3_600_000
const M15 = 15 * 60_000

/** Flat 4h history before T0 (ATR 2). */
const h4c: Candle[] = Array.from({ length: 30 }, (_, i) => ({ t: T0 - (30 - i) * H4, o: 101, h: 102, l: 100, c: 101, v: 1 }))
const an = (tf: SmcAnalysisFull['timeframe'], candles: Candle[], ltfPivots: Pivot[] = []): SmcAnalysisFull =>
  ({ timeframe: tf, candles, atr: candles.map(() => 2), ltfPivots, trendChanges: [] }) as unknown as SmcAnalysisFull
const m15 = (lows: number[]): Candle[] => lows.map((l, i) => ({ t: T0 + i * M15, o: l + 0.2, h: l + 0.4, l, c: l + 0.2, v: 1 }))
/** B: bullish 4h OB at 100 (extreme 98.5), with origin. */
const B = (p: Partial<Poi> = {}): Poi => ({ kind: 'OB', timeframe: '4h', direction: 'bullish', level: 100, t: T0 - 10 * H4, activeFrom: T0, invalidT: null, origin: 'sweep', extreme: 98.5, ...p })
/** Bait: bullish 15m OB without origin in front of B (at 103). */
const bait = (p: Partial<Poi> = {}): Poi => ({ kind: 'OB', timeframe: '15m', direction: 'bullish', level: 103, t: T0 - M15, activeFrom: T0, invalidT: null, origin: null, extreme: 102.8, ...p })
const IND = { baitDays: 7, windowAtr: 6 }

function run(lows: number[], pois: Poi[], c: Parameters<typeof cfg>[0] = {}) {
  const entry = an('15m', m15(lows))
  const all = [entry, an('4h', h4c)]
  const input = { symbol: 'X', entry, poiAnalyses: all.slice(1), cfg: cfg({ models: ['M9'], ...c }) }
  return modelM9(input, all, pois, new InducementIndex(entry, all, pois, IND))
}

describe('M9 bait → POI behind', () => {
  it('arms a limit at B once the bait in front was taken and price is within 1R', () => {
    // #2 wicks to 102.9 → bait at 103 taken; first close within 1.7 (risk) of 100 after that is #3 (101.4)
    const d = run([106, 104, 102.9, 101.2, 100.8], [B(), bait()])
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ model: 'M9', dir: 'bullish', entry: 100, knownIdx: 3 })
    expect(d[0]!.sl).toBeCloseTo(98.3, 6)
  })

  it('no bait (the POI in front has an origin, or is farther than idmWindowAtr) → nothing', () => {
    expect(run([106, 104, 102.9, 101.2], [B(), bait({ origin: 'sweep' })])).toHaveLength(0)
    // 6 ATR × 2 = 12 → a POI at 113 is outside the window although price traded through it
    expect(run([106, 104, 102.9, 101.2], [B(), bait({ level: 113 })])).toHaveLength(0)
  })

  it('a bait touched before B existed does not count', () => {
    expect(run([106, 102.9, 104, 101.2], [B({ activeFrom: T0 + 2 * M15 }), bait()])).toHaveLength(0)
  })

  it('ignores kinds outside m9Kinds and a B already touched', () => {
    expect(run([106, 104, 102.9, 101.2], [B({ kind: 'OCL_BREAK' }), bait()])).toHaveLength(0)
    expect(run([106, 99.9, 102.9, 101.2], [B(), bait()])).toHaveLength(0)
  })
})

describe('inducement context (strict IDM, extreme, decisional)', () => {
  // 4h pullback low at 102 (candle #24, after B at #20), confirmed by #26 → swept by the 15m low 101.5 at #1
  const idmPivot: Pivot = { i: 24, kind: 'low', price: 102, confirmedAt: 26 }
  const ctx = (pois: Poi[], pivots: Pivot[] = [idmPivot]) => {
    const entry = an('15m', m15([103, 101.5, 101, 100.5]))
    const all = [entry, an('4h', h4c, pivots)]
    return new InducementIndex(entry, all, pois, IND)
  }
  const at = T0 + 3 * M15

  it('strict IDM swept + nothing behind/between → idm, extreme, decisional', () => {
    const b = B()
    expect(ctx([b]).at(b, at)).toEqual({ baitT: null, idm: true, extreme: true, decisional: true })
  })

  it('a POI behind B → not extreme; a POI between B and the IDM → not decisional', () => {
    const b = B()
    const behind: Poi = { ...B(), timeframe: '1h', level: 99, t: T0 - 5 * H4 }
    const between: Poi = { ...B(), timeframe: '1h', level: 101, t: T0 - 5 * H4 }
    expect(ctx([b, behind]).at(b, at)).toMatchObject({ extreme: false, decisional: true })
    expect(ctx([b, between]).at(b, at)).toMatchObject({ extreme: true, decisional: false })
  })

  it('no pullback in the leg (B is the first pullback) → no IDM, no decisional', () => {
    const b = B()
    expect(ctx([b], []).at(b, at)).toMatchObject({ idm: false, decisional: false })
  })

  it('bait touch is reported with the close time of the touching candle', () => {
    const b = B()
    const a = bait({ level: 101.6 })
    expect(ctx([b, a]).at(b, at).baitT).toBe(T0 + 2 * M15)
  })
})
