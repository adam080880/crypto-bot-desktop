import { describe, expect, it } from 'vitest'
import { analyzeSmc } from './analyze'
import { at, bars, cfg, path } from './testkit'

// Materi 2 – OB bullish: red, red, GREEN with a longer lower wick at the low, then a rally.
const OB_BULL: [number, number, number, number][] = [
  [10, 10.5, 9, 9.2], // 0 red
  [9.2, 9.4, 8, 8.2], // 1 red
  [8.2, 8.5, 7.6, 8.0], // 2 red, lower wick 0.4
  [8.0, 8.6, 6.5, 8.4], // 3 GREEN, lower wick 1.5 reaching below candle 2 → OB
  [8.4, 9.0, 8.2, 8.9], // 4 closes above OB high 8.6
  [8.9, 9.6, 8.8, 9.5], // 5 (low 8.8 > 8.6 → FVG with candle 3)
  [9.5, 10, 9.4, 9.9] // 6
]

describe('order block (§3)', () => {
  it('detects a green long-wick swing-low candle as bullish OB with FVG', () => {
    const a = analyzeSmc(bars(OB_BULL), '15m', cfg())
    const ob = a.orderBlocks.find((o) => o.direction === 'bullish')!
    expect(ob).toMatchObject({ t: at(3), line: 8.0, wickEnd: 6.5, bodyFar: 8.4, hasFvg: true, prevOpposite: true })
    expect(ob.confirmedT).toBe(at(5))
    // wick liquidity zone of the OB
    expect(a.liquidity).toContainEqual(
      expect.objectContaining({ kind: 'wick', side: 'sell', top: 8.0, bottom: 6.5, t: at(3), sweptT: null })
    )
  })

  it('rejects the same shape when the candle is red (colour matters, Q5)', () => {
    const rows = OB_BULL.map((r) => [...r] as [number, number, number, number])
    rows[3] = [8.4, 8.6, 6.5, 8.0] // red, same wick
    const a = analyzeSmc(bars(rows), '15m', cfg())
    expect(a.orderBlocks.filter((o) => o.direction === 'bullish')).toHaveLength(0)
  })

  it('rejects a doji (Q5c) and a wick that is not longer than the previous one (Q4)', () => {
    const doji = OB_BULL.map((r) => [...r] as [number, number, number, number])
    doji[3] = [8.0, 8.6, 6.5, 8.02]
    expect(analyzeSmc(bars(doji), '15m', cfg()).orderBlocks.filter((o) => o.direction === 'bullish')).toHaveLength(0)
    const shortWick = OB_BULL.map((r) => [...r] as [number, number, number, number])
    shortWick[2] = [8.2, 8.5, 7.6, 8.0] // previous lower wick 0.4
    shortWick[3] = [8.0, 8.6, 7.7, 8.4] // green, wick 0.3 — shorter and not lower → not an OB
    expect(analyzeSmc(bars(shortWick), '15m', cfg()).orderBlocks.filter((o) => o.direction === 'bullish')).toHaveLength(0)
  })

  it('tracks hit, sweep of the wick liquidity and invalidation', () => {
    const rows = [...OB_BULL, [9.9, 10, 7.9, 8.2], [8.2, 8.3, 6.4, 7.0], [7.0, 7.1, 6.0, 6.2]] as [number, number, number, number][]
    const ob = analyzeSmc(bars(rows), '15m', cfg()).orderBlocks.find((o) => o.t === at(3))!
    expect(ob.hitT).toBe(at(7))
    expect(ob.sweptT).toBe(at(8))
    expect(ob.invalidT).toBe(at(9)) // close 6.2 < wick end 6.5
  })
})

describe('FVG (§4)', () => {
  it('finds the gap between candle 1 and candle 3 wicks', () => {
    const a = analyzeSmc(bars(OB_BULL), '15m', cfg())
    expect(a.fvgs).toContainEqual(expect.objectContaining({ t: at(3), direction: 'bullish', bottom: 8.6, top: 8.8 }))
  })
})

describe('structure & BOS (§1–2)', () => {
  it('labels HH/HL and flags a BOS when the last HL is closed below', () => {
    const c = path([10, 11, 12, 11, 10.5, 11.5, 13, 14, 13, 12, 12.5, 13.5, 15, 14, 12.5, 11.5, 11, 10, 9])
    const a = analyzeSmc(c, '15m', cfg())
    expect(a.swings.map((s) => s.label).filter(Boolean)).toEqual(expect.arrayContaining(['HH', 'HL']))
    const bos = a.breaks.at(-1)!
    expect(bos.direction).toBe('bearish')
    const lastHl = a.swings.filter((s) => s.label === 'HL').at(-1)!
    expect(bos.level).toBe(lastHl.price)
    expect(a.trend).toBe('bearish')
  })
})

describe('RBS / SBR (§5)', () => {
  it('turns a broken swing-high body into RBS, then hit, then invalid', () => {
    const c = path([10, 10.5, 11, 11.5, 12, 11.5, 11, 10.8, 11.6, 12.4, 13, 13.4, 12.6, 11.9, 11.7, 11.2])
    const a = analyzeSmc(c, '15m', cfg())
    const rbs = a.srFlips.find((f) => f.kind === 'RBS')!
    expect(rbs.level).toBe(12) // body top of the swing-high candle (Q10)
    expect(rbs.breakT).toBe(at(8))
    expect(rbs.hitT).toBe(at(12))
    expect(rbs.invalidT).toBe(at(12))
  })
})

describe('OCL (§6)', () => {
  it("OCL Break Buy (user's example): red OCL, green body closes above the red body", () => {
    const c = bars([
      [105, 106, 99, 100], // 0 big red — OCL bearish at its close (100), area = body 100–105
      [100, 101, 97, 99], // 1 small red continues from that close (same colour)
      [99, 106, 98.5, 105.5], // 2 green BODY closes above 105 (whole OCL area) → OCL Break Buy @100
      [105.5, 108.2, 105.3, 108],
      [108, 108.1, 99.8, 102] // 4 pullback touches 100 → hit
    ])
    const o = analyzeSmc(c, '15m', cfg()).ocls.find((x) => x.t === at(0))!
    expect(o).toMatchObject({ kind: 'OCL_BREAK', direction: 'bullish', level: 100, breakT: at(2), hitT: at(4), invalidT: null })
  })

  it('no break when the green candle only closes inside the OCL area', () => {
    const c = bars([
      [105, 106, 99, 100],
      [100, 101, 97, 99],
      [99, 104, 98.5, 103.5], // closes above the level but not above 105 → not a break
      [103.5, 103.8, 101, 101.5]
    ])
    const o = analyzeSmc(c, '15m', cfg()).ocls.find((x) => x.t === at(0))!
    expect(o.kind).toBe('OCL')
    expect(o.invalidT).toBe(at(2)) // a bearish OCL closed through upward without a qualifying break
  })

  it('needs the second candle to have the same colour (no body-size rule)', () => {
    const c = bars([
      [105, 106, 99, 100],
      [100, 101, 97, 100.5], // green → not an OCL pair
      [100.5, 101, 99, 99.5]
    ])
    expect(analyzeSmc(c, '15m', cfg()).ocls.find((x) => x.t === at(0))).toBeUndefined()
  })
})

describe('QM (§7)', () => {
  // H1 body top 13 (wick 13.1) → L1 → H2 body 14 breaks H1's wick → L2 < L1 → back to 13
  const QM_PATH = [9, 9.5, 10, 11.5, 13, 12, 11, 12.5, 14, 12.5, 11, 10, 10.8, 11.8, 12.6, 13.1, 12.2, 11.5]

  it('sell QM: level = BODY of mountain 1, invalid above mountain 2', () => {
    const q = analyzeSmc(path(QM_PATH), '15m', cfg()).qms.find((x) => x.direction === 'bearish')!
    expect(q.level).toBeCloseTo(13) // body, not the 13.1 wick
    expect(q.invalidLevel).toBeCloseTo(14.1)
    expect(q.hitT).toBe(at(14))
  })

  it("requires mountain 2's body to break mountain 1's wick (configurable)", () => {
    const weak = [...QM_PATH]
    weak[8] = 13.05 // mountain 2 body top 13.05 < mountain 1 wick 13.1; wick 13.15 still a higher high
    const strict = analyzeSmc(path(weak), '15m', cfg()).qms.filter((x) => x.direction === 'bearish')
    expect(strict).toHaveLength(0)
    const loose = analyzeSmc(path(weak), '15m', cfg({ qmRequireBodyBreak: false })).qms.filter((x) => x.direction === 'bearish')
    expect(loose).toHaveLength(1)
  })
})
