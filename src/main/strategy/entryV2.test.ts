import { describe, expect, it } from 'vitest'
import { exitConfigSchema } from '@shared/config'
import { analyzeSmc } from './analyze'
import { ExitTracker } from './exit'
import { collectAllPois, detectSetups, refine } from './setups'
import { at, bars, cfg } from './testkit'
import { detectWyckoff, wyckoffAt } from './wyckoff'
import { atrSeries } from './atr'

type Row = [number, number, number, number]

// L1 (3) → H1 (5) → deeper low sweeps L1 with body (7) → big green closes above H1 (9) = CHoCH
const CHOCH: Row[] = [
  [12, 12.1, 11.6, 11.7],
  [11.7, 11.8, 11.2, 11.3],
  [11.3, 11.4, 10.8, 10.9],
  [10.9, 11.0, 10.0, 10.2], // 3 L1 (body low 10.2)
  [10.2, 10.9, 10.1, 10.8],
  [10.8, 11.2, 10.6, 11.0], // 5 H1 = 11.2
  [11.0, 11.1, 10.4, 10.5], // 6 parent POI hit here
  [10.5, 10.6, 9.4, 9.6], // 7 extreme, body below L1 wick → mountain 2
  [9.6, 10.3, 9.5, 10.2],
  [10.2, 11.8, 10.1, 11.7], // 9 displacement close > 11.2 → CHoCH
  [11.7, 11.9, 11.0, 11.1],
  [11.1, 11.2, 10.15, 10.4], // 11 retest of the QM level 10.2 → fill
  [10.4, 13, 10.3, 12.8]
]

describe('refine: POI hit → CHoCH LTF → small POI (M1)', () => {
  it('enters at the QM the reaction created, SL beyond the reaction extreme', () => {
    const c = cfg({ ltfPivot: 2 })
    const a = analyzeSmc(bars(CHOCH), '15m', c)
    const r = refine(a, c, 'bullish', 6, null)!
    expect(r).not.toBeNull()
    expect(r.child).toMatchObject({ kind: 'QM', level: 10.2, extreme: 9.4, t: at(3), origin: 'sweep+htfPoi' })
    expect(r.knownIdx).toBe(9)
    expect(r.sl).toBeCloseTo(9.4 * 0.999, 6)
    expect(r.confluence).toEqual(expect.arrayContaining(['displacement', 'sweep']))
  })

  it('no setup without displacement when it is required', () => {
    const rows = CHOCH.map((x) => [...x] as Row)
    rows[9] = [10.2, 11.3, 10.1, 11.25] // small body just above H1, no gap
    const c = cfg({ dispBodyAtr: 5 })
    const a = analyzeSmc(bars(rows), '15m', c)
    expect(refine(a, c, 'bullish', 6, null)).toBeNull()
    expect(refine(a, cfg({ dispBodyAtr: 5, requireDisplacement: false }), 'bullish', 6, null)).not.toBeNull()
  })

  it('stops when the parent POI died before the CHoCH', () => {
    const c = cfg()
    const a = analyzeSmc(bars(CHOCH), '15m', c)
    expect(refine(a, c, 'bullish', 6, at(8))).toBeNull()
  })
})

// swing low 100 (2) → OB candle sweeps it (5) → rally → higher low 100.9 in front of the OB (9)
// → later price sweeps 100.9 and fills the OB line 100.5 (13) → rally
const GRAB: Row[] = [
  [103, 103.5, 102, 102.2],
  [102.2, 102.5, 101, 101.2],
  [101.2, 101.4, 100, 100.3], // 2 swing low 100
  [100.3, 101.2, 100.2, 101.0],
  [101.0, 101.1, 100.4, 100.5],
  [100.5, 101.0, 99.0, 100.8], // 5 green OB, sweeps 100 → origin sweep; line 100.5, wick 99
  [100.8, 101.6, 100.7, 101.5],
  [101.5, 102.5, 101.4, 102.3],
  [102.3, 102.6, 101.6, 101.7], // 8 swing high
  [101.7, 101.8, 100.9, 101.1], // 9 SSL 100.9 in front of the OB (≤ 1 %)
  [101.1, 102.0, 101.0, 101.9],
  [101.9, 102.8, 101.8, 102.7], // 11 SSL confirmed → limit goes in
  [102.7, 102.9, 101.9, 102.0],
  [102.0, 102.1, 100.4, 100.6], // 13 sweeps 100.9, fills 100.5
  [100.6, 104, 100.5, 103.8]
]

describe('M2a: liquidity grab (OB behind unswept SSL)', () => {
  it('places the limit at the OB once the liquidity in front of it is known', () => {
    const c = cfg({ models: ['M2a'], poiTimeframes: ['1h'] })
    const a = analyzeSmc(bars(GRAB), '15m', c)
    const s = detectSetups({ symbol: 'T', entry: a, poiAnalyses: [], cfg: c, exit: { tpMode: 'fixedR', tpR: 2 } })
    const m = s.find((x) => x.model === 'M2a' && x.child.t === at(5))!
    expect(m).toBeDefined()
    expect(m.entry).toBe(100.5)
    expect(m.sl).toBeCloseTo(99 * 0.999, 6)
    expect(m.poi.origin).toContain('sweep')
    expect(m.createdT).toBe(at(11))
    expect(m.filledT).toBe(at(13))
    expect(m.status).toBe('win')
  })

  it('every POI carries its origin (sweep of the swing before it)', () => {
    const c = cfg()
    const a = analyzeSmc(bars(GRAB), '15m', c)
    const ob = collectAllPois([a], c).find((p) => p.kind === 'OB' && p.t === at(5))!
    expect(ob.origin).toBe('sweep')
  })
})

describe('exit ladder (1R → BE incl. fee, 3R → take 50 % + SL 1R, then trail)', () => {
  const plan = exitConfigSchema.parse({ orderFlowHold: false })
  const NO = { makerFeePct: 0, takerFeePct: 0, slippagePct: 0 }
  const b = (i: number, h: number, l: number, c: number) => ({ t: at(i), h, l, c })

  it('moves the stop to break-even after 1R', () => {
    const x = new ExitTracker('bullish', 100, 99, null, plan, NO)
    x.bar(b(0, 100.2, 99.9, 100), true)
    x.bar(b(1, 101.2, 100.3, 101))
    x.bar(b(2, 100.5, 99.95, 100))
    const r = x.result()
    expect(r.done).toBe(true)
    expect(r.r).toBeCloseTo(0)
  })

  it('takes half at 3R and keeps the rest with the stop at 1R', () => {
    const x = new ExitTracker('bullish', 100, 99, null, plan, NO)
    x.bar(b(0, 100.1, 99.9, 100), true)
    x.bar(b(1, 103.1, 100.5, 102.8))
    x.bar(b(2, 102.9, 100.9, 101))
    expect(x.result().r).toBeCloseTo(0.5 * 3 + 0.5 * 1)
  })

  it('trails 2R behind every new full R after the last step', () => {
    const x = new ExitTracker('bullish', 100, 99, null, plan, NO)
    x.bar(b(0, 100.1, 99.9, 100), true)
    x.bar(b(1, 103.1, 100.5, 103))
    x.bar(b(2, 105.2, 103, 105))
    x.bar(b(3, 105, 102.9, 103))
    expect(x.result().r).toBeCloseTo(0.5 * 3 + 0.5 * 3)
  })

  it('break-even stop pays the fees (≈ 0R net)', () => {
    const fees = { makerFeePct: 0.02, takerFeePct: 0.05, slippagePct: 0.02 }
    const x = new ExitTracker('bullish', 100, 99, null, plan, fees)
    x.bar(b(0, 100.1, 99.9, 100), true)
    x.bar(b(1, 101.2, 100.3, 101))
    x.bar(b(2, 100.5, 99.9, 100))
    expect(x.result().r).toBeCloseTo(0, 3)
  })

  it('stop before target inside one bar (conservative)', () => {
    const x = new ExitTracker('bearish', 100, 101, 97, plan, NO)
    x.bar(b(0, 100.1, 99.9, 100), true)
    x.bar(b(1, 101.5, 96.5, 98))
    expect(x.result().r).toBeCloseTo(-1)
  })

  // tight stop (SL 0,5 % < tightSlPct 1 %): no BE at 1R; at 2R the stop locks +0,5R net of fees
  it('tight stop: 1R does not move the stop to break-even', () => {
    const x = new ExitTracker('bullish', 100, 99.5, null, plan, NO)
    x.bar(b(0, 100.1, 99.9, 100), true)
    x.bar(b(1, 100.6, 100.2, 100.5)) // +1,2R
    x.bar(b(2, 100.4, 99.4, 99.6))
    expect(x.result().r).toBeCloseTo(-1)
  })

  it('tight stop: 2R locks +0,5R after fees', () => {
    const fees = { makerFeePct: 0.02, takerFeePct: 0.05, slippagePct: 0.02 }
    const x = new ExitTracker('bullish', 100, 99.5, null, plan, fees)
    x.bar(b(0, 100.1, 99.9, 100), true)
    x.bar(b(1, 101.05, 100.5, 101)) // +2,1R
    x.bar(b(2, 101, 99.8, 100))
    expect(x.result().r).toBeCloseTo(0.5, 2)
  })

  it('stop of 1 % or more keeps break-even at 1R', () => {
    const x = new ExitTracker('bullish', 100, 98.5, null, plan, NO)
    x.bar(b(0, 100.1, 99.9, 100), true)
    x.bar(b(1, 101.6, 100.5, 101.5)) // +1,07R
    x.bar(b(2, 101, 99.5, 99.8))
    expect(x.result().r).toBeCloseTo(0)
  })
})

describe('Wyckoff (score only)', () => {
  const rows: Row[] = []
  let p = 120
  for (let i = 0; i < 10; i++, p -= 2) rows.push([p, p + 0.5, p - 2.5, p - 2]) // decline, ATR ≈ 3
  const range: Row[] = [
    [100, 101.5, 99.5, 101],
    [101, 101.5, 99.6, 99.8],
    [99.8, 101.2, 99.5, 101],
    [101, 101.4, 99.7, 100],
    [100, 101.3, 99.6, 101.1],
    [101.1, 101.4, 99.8, 100.2],
    [100.2, 100.4, 98, 100.5], // spring: wick below, close back in
    [100.5, 101.3, 100.1, 101],
    [101, 103.5, 100.8, 103], // closes above
    [103, 104.5, 102.8, 104],
    [104, 105.5, 103.8, 105] // still outside after 2 more candles → breakout
  ]
  const c = bars([...rows, ...range])
  const w = detectWyckoff(c, '15m', atrSeries(c, 14), { rangeCandles: 5, rangeAtr: 1.5, reclaimCandles: 2 })

  it('finds an accumulation range, its spring and the markup breakout', () => {
    expect(w).toHaveLength(1)
    expect(w[0]!.kind).toBe('accumulation')
    expect(w[0]!.manipulations.map((m) => m.kind)).toEqual(['spring'])
    expect(w[0]!.breakout?.direction).toBe('bullish')
  })

  it('phase as known at a time (no look-ahead)', () => {
    const spring = w[0]!.manipulations[0]!.t
    expect(wyckoffAt(w, spring - 1)?.phase).toBe('accumulation')
    expect(wyckoffAt(w, spring)).toMatchObject({ phase: 'manipulation', dir: 'bullish', manipulation: 'spring' })
    expect(wyckoffAt(w, w[0]!.breakout!.t)?.phase).toBe('markup')
  })
})

describe('order-flow hold (FVG retest / reactive wick → hold; BE step still applies)', () => {
  const NO = { makerFeePct: 0, takerFeePct: 0, slippagePct: 0 }
  const k = (i: number, o: number, h: number, l: number, c: number) => ({ t: at(i), o, h, l, c })
  const FVG_RUN = [
    k(0, 100, 100.2, 99.8, 100.1), // fill
    k(1, 100.1, 100.6, 100.0, 100.5),
    k(2, 100.5, 102.5, 100.5, 102.4), // displacement (≥ 1R → BE)
    k(3, 102.4, 102.8, 101.0, 102.6), // FVG 100.6–101.0
    k(4, 102.6, 102.7, 100.8, 101.6), // retest into the FVG, closes above → order flow
    k(5, 101.6, 103.5, 101.5, 103.4), // 3.5R: no partial while holding
    k(6, 103.4, 103.5, 100.6, 100.7) // back down: stop at the retest low
  ]

  it('holds after the FVG retest: no partial at 3R, stop at the retest low (orderFlowMoveSl)', () => {
    const plan = exitConfigSchema.parse({ orderFlowSignals: ['fvg'], orderFlowMoveSl: true })
    const x = new ExitTracker('bullish', 100, 99, null, plan, NO)
    FVG_RUN.slice(0, 6).forEach((b, i) => x.bar(b, i === 0))
    const mid = x.result()
    expect(mid.holding).toBe(true)
    expect(mid.fills).toHaveLength(0)
    expect(mid.sl).toBeCloseTo(100.8 * 0.999, 6)
    x.bar(FVG_RUN[6]!)
    expect(x.result().r).toBeCloseTo(100.8 * 0.999 - 100, 6)
  })

  it('default: holds after the FVG retest (no partial at 3R) but the stop stays at break-even', () => {
    const plan = exitConfigSchema.parse({ orderFlowSignals: ['fvg'] })
    const x = new ExitTracker('bullish', 100, 99, null, plan, NO)
    FVG_RUN.slice(0, 6).forEach((b, i) => x.bar(b, i === 0))
    const mid = x.result()
    expect(mid.holding).toBe(true)
    expect(mid.fills).toHaveLength(0)
    expect(mid.sl).toBeCloseTo(100, 6)
    x.bar(FVG_RUN[6]!) // low 100.6 stays above BE → still open
    expect(x.result().done).toBe(false)
  })

  it('without order flow the ladder takes 50 % at 3R and stops the rest at 1R', () => {
    const plan = exitConfigSchema.parse({ orderFlowHold: false })
    const x = new ExitTracker('bullish', 100, 99, null, plan, NO)
    FVG_RUN.forEach((b, i) => x.bar(b, i === 0))
    expect(x.result().r).toBeCloseTo(0.5 * 3 + 0.5 * 1)
  })

  it('a reactive wick back at the entry confirms the POI; the stop never drops below break-even once reached', () => {
    const plan = exitConfigSchema.parse({ orderFlowSignals: ['wick'], orderFlowMoveSl: true })
    const x = new ExitTracker('bullish', 100, 99, null, plan, NO)
    x.bar(k(0, 100, 100.2, 99.8, 100.1), true) // fill candle: its wick is not a signal
    x.bar(k(1, 100.1, 101.5, 100.05, 101.4)) // ≥ 1R → BE
    x.bar(k(2, 101.3, 101.4, 100.3, 101.2)) // long lower wick near the entry, closes above
    x.bar(k(3, 101.2, 101.3, 101.0, 101.1))
    const r = x.result()
    expect(r.holding).toBe(true)
    expect(r.orderFlowHolds).toBe(1)
    expect(r.sl).toBeCloseTo(100.3 * 0.999, 6)

    const deep = new ExitTracker('bullish', 100, 99, null, plan, NO)
    deep.bar(k(0, 100, 100.2, 99.8, 100.1), true)
    deep.bar(k(1, 100.1, 100.4, 99.4, 100.3)) // wick below the entry, closes above, < 1R
    deep.bar(k(2, 100.3, 100.5, 100.2, 100.4))
    expect(deep.result().sl).toBeCloseTo(99.4 * 0.999, 6) // tighter than the 99 stop, BE not reached yet
    deep.bar(k(3, 100.4, 101.2, 100.3, 101.1)) // 1R → BE still applies while holding
    deep.bar(k(4, 101.1, 101.2, 100.9, 101))
    expect(deep.result().sl).toBeCloseTo(100, 6)
  })
})
