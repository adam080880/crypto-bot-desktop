import type { SmcConfig } from '@shared/config'
import type { Confluence, Dir } from '@shared/smc'

/**
 * Futures positioning around a setup (docs/entry-v2.md §10). Open interest = hourly snapshots
 * (value in USDT, `t` = snapshot time); funding = settled rates (`t` = funding time).
 * Live keeps only the last 3 days of OI and ~35 days of funding; the backtest downloads history.
 */
export interface FlowData {
  oi: readonly { t: number; v: number }[]
  funding: readonly { t: number; r: number }[]
}

const HOUR = 3_600_000
/** Funding settlements used for the percentile (~30 days at 8h). */
export const FUNDING_WINDOW = 90

/** Index of the last element with t ≤ x (−1 if none). Arrays are sorted by t. */
function lastAtOrBefore(a: readonly { t: number }[], x: number): number {
  let lo = 0
  let hi = a.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (a[mid]!.t <= x) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** OI value at `t` (the newest snapshot at or before it, at most 2h old). */
function oiAt(oi: FlowData['oi'], t: number): number | null {
  const i = lastAtOrBefore(oi, t)
  if (i < 0 || t - oi[i]!.t > 2 * HOUR) return null
  return oi[i]!.v
}

export interface FlowSnapshot {
  oiChg4h: number | null
  oiChg24h: number | null
  funding: number | null
  /** Share of the last FUNDING_WINDOW settlements ≤ the latest one (0–1). */
  fundingPct: number | null
}

/** Positioning known at time `t` (no look-ahead: only snapshots/settlements at or before t). */
export function flowAt(flow: FlowData, t: number): FlowSnapshot {
  const now = oiAt(flow.oi, t)
  const a4 = oiAt(flow.oi, t - 4 * HOUR)
  const a24 = oiAt(flow.oi, t - 24 * HOUR)
  const fi = lastAtOrBefore(flow.funding, t)
  let funding: number | null = null
  let fundingPct: number | null = null
  if (fi >= 0) {
    funding = flow.funding[fi]!.r
    const from = Math.max(0, fi - FUNDING_WINDOW + 1)
    let le = 0
    for (let k = from; k <= fi; k++) if (flow.funding[k]!.r <= funding) le++
    // a percentile over a handful of settlements means nothing
    fundingPct = fi - from + 1 >= 15 ? le / (fi - from + 1) : null
  }
  return {
    oiChg4h: now !== null && a4 ? now / a4 - 1 : null,
    oiChg24h: now !== null && a24 ? now / a24 - 1 : null,
    funding,
    fundingPct
  }
}

/**
 * Flow confluences for a setup known at `t` in direction `dir`. `pxChg24h` = price change over the
 * same 24h (from the entry candles). Missing data → no tag (never a guess).
 */
export function flowConfluence(flow: FlowData | undefined, t: number, dir: Dir, pxChg24h: number | null, cfg: Pick<SmcConfig, 'flowOiFlushPct' | 'flowFundingPct'>): Confluence[] {
  if (!flow) return []
  const f = flowAt(flow, t)
  const bull = dir === 'bullish'
  const out: Confluence[] = []
  if (f.oiChg24h !== null && pxChg24h !== null && f.oiChg24h > 0 && (bull ? pxChg24h > 0 : pxChg24h < 0)) out.push('oiConfirm')
  if (f.oiChg4h !== null && f.oiChg4h <= -cfg.flowOiFlushPct / 100) out.push('oiFlush')
  if (f.fundingPct !== null && (bull ? f.fundingPct <= cfg.flowFundingPct : f.fundingPct >= 1 - cfg.flowFundingPct)) out.push('fundingContra')
  return out
}
