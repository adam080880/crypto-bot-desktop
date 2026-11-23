import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import type { SmcAnalysisFull } from './analyze'
import { modelM0 } from './setups'
import { cfg, T0 } from './testkit'

const H4 = 4 * 3_600_000
const M15 = 15 * 60_000

/**
 * Regression (2026-11-22, live vs backtest): a 4h POI that is broken by the 4h candle in progress is still valid
 * for an OB confirmed inside that candle — the break is only known when the 4h candle closes. The backtest
 * compared with the candle's OPEN time and dropped those trades (they mostly lost), so M0 looked better than live.
 */
describe('M0 POI invalidation timing', () => {
  // bullish 4h OB POI at 100 (wick 99), active from T0
  const poiOb = (invalidT: number | null) => ({
    i: 0,
    t: T0 - H4,
    direction: 'bullish' as const,
    line: 100,
    wickEnd: 99,
    bodyFar: 101,
    hasFvg: false,
    prevOpposite: true,
    confirmedAt: 0,
    confirmedT: T0 - H4,
    hitT: null,
    invalidT,
    sweptT: null
  })
  const h4 = (invalidT: number | null) =>
    ({ timeframe: '4h', candles: [] as Candle[], orderBlocksIdx: [poiOb(invalidT)], srFlips: [], qms: [], ocls: [] }) as unknown as SmcAnalysisFull
  // 15m: price comes down into the POI at #2 (T0 + 30m), a bullish 15m OB at #2 confirmed at #4 (T0 + 1h)
  const m15: Candle[] = [101.5, 101, 99.8, 100.4, 100.8, 101.2].map((l, i) => ({ t: T0 + i * M15, o: l + 0.3, h: l + 0.6, l, c: l + 0.4, v: 1 }))
  const entry = {
    timeframe: '15m',
    candles: m15,
    orderBlocksIdx: [{ ...poiOb(null), i: 2, t: T0 + 2 * M15, line: 100.1, wickEnd: 99.8, confirmedAt: 4, confirmedT: T0 + 4 * M15 }],
    srFlips: [],
    qms: [],
    ocls: []
  } as unknown as SmcAnalysisFull
  const run = (invalidT: number | null) => modelM0({ symbol: 'X', entry, poiAnalyses: [h4(invalidT)], cfg: cfg({ models: ['M0'], m0RequirePoiLiq: false, sameTfPoi: false }) }, [])

  it('takes the setup while the POI is intact', () => expect(run(null)).toHaveLength(1))
  it('the 4h candle that later closes through the POI opened BEFORE the OB was confirmed: still valid then', () => {
    // 4h candle T0 .. T0+4h closes through the POI; the OB is confirmed at T0+1h, long before that close
    expect(run(T0)).toHaveLength(1)
  })
  it('a POI whose break was already known (4h candle closed) before the OB is not used', () => {
    expect(run(T0 - H4)).toHaveLength(0)
  })
})
