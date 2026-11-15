import { describe, expect, it } from 'vitest'
import type { Candle } from '@shared/candles'
import { radarConfigSchema } from '@shared/config'
import { RADAR_BARS, radarCheck } from './radar'

const H = 3_600_000
const cfg = radarConfigSchema.parse({ volMult: 3, fundingMax: -0.0002, fundingVolMult: 2 })
const series = (lastVol: number, lastClose = 1.1): Candle[] =>
  Array.from({ length: RADAR_BARS }, (_, i) => {
    const recent = i >= RADAR_BARS - 24
    const c = recent && i === RADAR_BARS - 1 ? lastClose : 1
    return { t: i * H, o: 1, h: c, l: 1, c, v: recent ? lastVol : 100 }
  })

describe('radarCheck', () => {
  it('flags 24h volume ≥ 3× the 30-day median', () => {
    const hit = radarCheck('X', series(400), [], cfg)!
    expect(hit.reasons).toEqual(['vol'])
    expect(hit.volRatio).toBeGreaterThan(3)
    expect(hit.ret24).toBeCloseTo(0.1)
  })
  it('stays quiet on normal volume', () => expect(radarCheck('X', series(150, 1), [], cfg)).toBeNull())
  it('negative funding + volume ≥ 2× is a hit', () => {
    const closeT = (RADAR_BARS - 1) * H + H
    const hit = radarCheck('X', series(220, 1), [{ t: closeT - 2 * H, r: -0.0005 }], cfg)!
    expect(hit.reasons).toEqual(['funding'])
    expect(hit.funding).toBe(-0.0005)
  })
  it('ignores stale funding and data with gaps', () => {
    expect(radarCheck('X', series(220, 1), [{ t: 0, r: -0.0005 }], cfg)).toBeNull()
    const gap = series(400)
    gap.splice(100, 1)
    expect(radarCheck('X', gap, [], cfg)).toBeNull()
  })
})
