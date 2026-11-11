import { describe, expect, it } from 'vitest'
import { bucketOpen, weekStartUtc } from './timeframes'

describe('time alignment', () => {
  it('weekStartUtc returns Monday 00:00 UTC', () => {
    const wed = Date.UTC(2026, 10, 11, 15, 30) // Wed 11 Nov 2026
    expect(new Date(weekStartUtc(wed)).toISOString()).toBe('2026-11-09T00:00:00.000Z')
    const mon = Date.UTC(2026, 10, 9, 0, 0)
    expect(weekStartUtc(mon)).toBe(mon)
    const sun = Date.UTC(2026, 10, 15, 23, 59)
    expect(weekStartUtc(sun)).toBe(mon)
  })

  it('4h buckets start at 00/04/08/12/16/20 UTC', () => {
    const t = Date.UTC(2026, 10, 11, 10, 17)
    expect(new Date(bucketOpen(t, '4h')).toISOString()).toBe('2026-11-11T08:00:00.000Z')
  })
})
