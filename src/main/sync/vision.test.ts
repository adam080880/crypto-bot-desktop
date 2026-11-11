import { describe, expect, it } from 'vitest'
import { WeightLimiter } from '../exchange/weightLimiter'
import { parseKlineCsv, visionUrl } from './vision'

describe('vision', () => {
  it('parses CSV with header, without header, CRLF and µs timestamps', () => {
    const withHeader =
      'open_time,open,high,low,close,volume,close_time\n1790812800000,1,2,0.5,1.5,10,1790812859999\r\n'
    const noHeader = '1790812860000000,1.5,3,1,2,5,0\n'
    expect(parseKlineCsv(withHeader + noHeader)).toEqual([
      { t: 1790812800000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: 1790812860000, o: 1.5, h: 3, l: 1, c: 2, v: 5 }
    ])
  })

  it('builds monthly and daily URLs', () => {
    expect(visionUrl('BTCUSDT', '1m', { kind: 'monthly', year: 2026, month: 5 })).toBe(
      'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2026-05.zip'
    )
    expect(visionUrl('BTCUSDT', '1m', { kind: 'daily', year: 2026, month: 11, day: 3 })).toMatch(/BTCUSDT-1m-2026-11-03\.zip$/)
  })
})

describe('WeightLimiter', () => {
  it('reserves weight and honours the server header', async () => {
    let now = 60_000 * 1000
    const l = new WeightLimiter(100, 1, () => now)
    await l.acquire(60)
    l.syncFromHeader('90')
    expect(l.usedWeight).toBe(90)
    l.syncFromHeader('10') // never lowers
    expect(l.usedWeight).toBe(90)
    now += 60_000 // next minute resets the window
    expect(l.usedWeight).toBe(0)
  })
})
