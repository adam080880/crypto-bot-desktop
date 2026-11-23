import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import type { SmcAnalysisFull } from './analyze'
import { modelM10 } from './setups'
import { cfg, path, T0 } from './testkit'

const H4 = 4 * 3_600_000
const M1 = 60_000
const M15 = 15 * M1

describe('M10: HTF POI hit → QM on 1m', () => {
  // the §7 sell QM path (level 13 = body of mountain 1, head wick 14.1) replayed as 1m candles from T0, then drifting lower
  const QM_PATH = [9, 9.5, 10, 11.5, 13, 12, 11, 12.5, 14, 12.5, 11, 10, 10.8, 11.8, 12.6, 12.4, 12.2, 11.5]
  const tail = Array.from({ length: 40 }, (_, i) => 11.4 - i * 0.02)
  const m1: Candle[] = path([...QM_PATH, ...tail]).map((k, i) => ({ ...k, t: T0 + i * M1 }))
  // 15m candles aggregated from the 1m ones
  const m15: Candle[] = []
  for (let i = 0; i + 15 <= m1.length; i += 15) {
    const g = m1.slice(i, i + 15)
    m15.push({ t: g[0]!.t, o: g[0]!.o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g.at(-1)!.c, v: 15 })
  }
  // bearish 4h OB POI at 13.9 (wick 14.5), active from T0: the 1m head (14.1) reaches into it
  const poiOb = {
    i: 0, t: T0 - H4, direction: 'bearish' as const, line: 13.9, wickEnd: 14.5, bodyFar: 13, hasFvg: false, prevOpposite: true,
    confirmedAt: 0, confirmedT: T0 - H4, hitT: null, invalidT: null, sweptT: null
  }
  const h4 = { timeframe: '4h', candles: [] as Candle[], orderBlocksIdx: [poiOb], srFlips: [], qms: [], ocls: [] } as unknown as SmcAnalysisFull
  const entry = { timeframe: '15m', candles: m15, orderBlocksIdx: [], srFlips: [], qms: [], ocls: [] } as unknown as SmcAnalysisFull
  const run = (ltf: { '1m'?: Candle[] } | undefined, p = {}) =>
    modelM10({ symbol: 'X', entry, poiAnalyses: [h4], ltf, cfg: cfg({ models: ['M10'], sameTfPoi: false, m10Pivot: 2, m10Timeframes: ['1m'], ...p }) })

  it('POI hit, then a 1m QM with its head in the POI → limit at the QM level, SL beyond the head', () => {
    const [d] = run({ '1m': m1 })
    expect(d).toMatchObject({ model: 'M10', dir: 'bearish', entry: 13, invalidLevel: 14.1, knownIdx: 0 })
    expect(d!.sl).toBeGreaterThan(14.1)
    expect(d!.child).toMatchObject({ kind: 'QM', timeframe: '1m' })
  })
  it('no lower-timeframe candles → no M10', () => expect(run(undefined)).toHaveLength(0))
  it('POI above the whole move (never hit) → no M10', () => {
    const far = { ...poiOb, line: 14.6, wickEnd: 15 }
    const h4far = { ...h4, orderBlocksIdx: [far] } as unknown as SmcAnalysisFull
    expect(modelM10({ symbol: 'X', entry, poiAnalyses: [h4far], ltf: { '1m': m1 }, cfg: cfg({ models: ['M10'], sameTfPoi: false, m10Pivot: 2, m10Timeframes: ['1m'] }) })).toHaveLength(0)
  })
})
