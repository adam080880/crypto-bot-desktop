import { describe, expect, it } from 'vitest'
import { fmtR, rAt, targetsText, tpText } from './rText'

const plan = { ladder: [{ atR: 1, slToR: 0, closePct: 0 }, { atR: 3, slToR: 1, closePct: 50 }], trailStepR: 1, trailGapR: 2, tightSlPct: 1, tightBeAtR: 2, tightBeLockR: 0.5 }

describe('R text for notifications', () => {
  it('short: TP and ladder targets in R with prices', () => {
    const t = { entry: 100, slInitial: 102, direction: 'bearish' as const, tp: 95, exitPlan: plan } // SL 2 % → not tight
    expect(rAt(t, 95)).toBeCloseTo(2.5)
    expect(tpText(t)).toBe('TP 95 (+2.50R)')
    expect(targetsText(t)).toBe('target: 1R @98 → SL BE · lalu trailing (best − 2R)') // 3R is beyond the TP
    expect(fmtR(rAt(t, 102))).toBe('-1.00R')
  })
  it('tight SL moves the BE step to 2R and locks +0.5R; no TP = trailing', () => {
    const t = { entry: 100, slInitial: 99.5, direction: 'bullish' as const, tp: null, exitPlan: plan }
    expect(tpText(t)).toBe('TP trailing (tanpa TP)')
    expect(targetsText(t)).toBe('target: 2R @101 → SL +0.50R · 3R @101.5 → tutup 50% + SL +1.00R · lalu trailing (best − 2R)')
  })
})
