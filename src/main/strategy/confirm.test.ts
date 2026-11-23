import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import { cisdEvents, cisdIn, ifvgIn, smtAt } from './confirm'
import { detectFvgs } from './fvg'

const M15 = 15 * 60_000
const H1 = 3_600_000
const mk = (rows: [number, number, number, number][], step = M15): Candle[] => rows.map(([o, h, l, c], i) => ({ t: i * step, o, h, l, c, v: 1 }))

describe('CISD', () => {
  // bearish run from 110 (two red candles), then a close above 110 → bullish CISD on candle 4
  const c = mk([[105, 111, 104, 110], [110, 110.5, 106, 107], [107, 107.5, 103, 104], [104, 106, 103.5, 105], [105, 111, 104.5, 110.5]])
  it('fires when a close passes the open of the first candle of the last opposite run', () => {
    expect(cisdEvents(c, '15m').bullish).toEqual([5 * M15])
    expect(cisdIn(c, '15m', 'bullish', 0, 5 * M15)).toBe(true)
    expect(cisdIn(c, '15m', 'bullish', 5 * M15, 6 * M15)).toBe(false) // window starts after it
    expect(cisdEvents(c, '15m').bearish).toEqual([3 * M15]) // candle 2 closed below the open (105) of the bullish run
  })
})

describe('inverse FVG', () => {
  // bearish FVG between candle 0 low (100) and candle 2 high (98); candle 4 closes above 100 → bullish IFVG
  const c = mk([[101, 102, 100, 100.5], [100.5, 100.6, 97, 97.5], [97.5, 98, 96, 96.5], [96.5, 99, 96, 98.8], [98.8, 101.5, 98.5, 101]])
  const f = detectFvgs(c, 0)
  it('a bearish FVG closed above is a bullish IFVG, known at that close', () => {
    expect(f.some((x) => x.direction === 'bearish')).toBe(true)
    expect(ifvgIn(c, f, '15m', 'bullish', 0, 5 * M15)).toBe(true)
    expect(ifvgIn(c, f, '15m', 'bullish', 0, 5 * M15 - 1)).toBe(false) // not before the close
  })
})

describe('SMT', () => {
  const flat = (n: number, lo: number): [number, number, number, number][] => Array.from({ length: n }, () => [lo + 1, lo + 2, lo, lo + 1])
  it('one of the two took the range low, the other held', () => {
    const coin = mk([...flat(24, 100), ...flat(5, 100), [100, 101, 99, 100.5]], H1) // coin sweeps 100
    const ref = mk([...flat(24, 50), ...flat(6, 50)], H1) // reference holds
    const at = 30 * H1
    expect(smtAt(coin, ref, '1h', 'bullish', at, 6, 24)).toBe(true)
    expect(smtAt(coin, coin, '1h', 'bullish', at, 6, 24)).toBe(false) // both swept
    expect(smtAt(ref, ref, '1h', 'bullish', at, 6, 24)).toBe(false) // neither
    expect(smtAt(coin, ref, '1h', 'bullish', at - 1, 6, 24)).toBe(false) // last candle not closed yet
  })
})
