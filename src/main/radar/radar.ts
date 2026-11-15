import type { Candle } from '@shared/candles'
import type { RadarConfig } from '@shared/config'
import type { RadarHit } from '@shared/radar'

const HOUR = 3_600_000
/** 30 daily windows before the current one + the current 24h. */
export const RADAR_BARS = 31 * 24

/**
 * Pump radar on closed 1h candles (oldest first), evaluated at the last candle. Pure, no look-ahead:
 * quote volume ≈ volume × close; the 24h sum is compared with the median of the 30 previous
 * 24h windows (the same features as the lab, docs/entry-v2.md §12). Needs RADAR_BARS contiguous candles.
 */
export function radarCheck(symbol: string, c: readonly Candle[], funding: readonly { t: number; r: number }[], cfg: RadarConfig): RadarHit | null {
  const n = c.length
  if (n < RADAR_BARS) return null
  const first = n - RADAR_BARS
  if (c[n - 1]!.t - c[first]!.t !== (RADAR_BARS - 1) * HOUR) return null // gap in the data → skip
  const q = (i: number): number => c[i]!.v * c[i]!.c
  const sum24 = (end: number): number => {
    let s = 0
    for (let i = end - 23; i <= end; i++) s += q(i)
    return s
  }
  const last = n - 1
  const now24 = sum24(last)
  const past: number[] = []
  for (let k = 1; k <= 30; k++) past.push(sum24(last - 24 * k))
  past.sort((a, b) => a - b)
  const median = (past[14]! + past[15]!) / 2
  if (!(median > 0)) return null
  const volRatio = now24 / median
  const closeT = c[last]!.t + HOUR
  let fr: number | null = null
  for (let i = funding.length - 1; i >= 0; i--)
    if (funding[i]!.t <= closeT) {
      // stale funding (> 9h, i.e. older than one settlement) is not used
      if (closeT - funding[i]!.t <= 9 * HOUR) fr = funding[i]!.r
      break
    }
  const reasons: RadarHit['reasons'] = []
  if (volRatio >= cfg.volMult) reasons.push('vol')
  if (fr !== null && fr <= cfg.fundingMax && volRatio >= cfg.fundingVolMult) reasons.push('funding')
  if (!reasons.length) return null
  return {
    symbol,
    t: c[last]!.t,
    reasons,
    volRatio: Math.round(volRatio * 100) / 100,
    funding: fr,
    ret24: c[last]!.c / c[last - 24]!.c - 1,
    price: c[last]!.c
  }
}
