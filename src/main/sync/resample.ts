import type { Candle, DerivedCandle } from '@shared/candles'
import { DERIVED_CASCADE, TF_MS, bucketOpen, type DerivedTimeframe } from '@shared/timeframes'
import type { CandleRepo } from '../db/candles'
import { markSynced } from '../db/symbolsRepo'
import type { Db } from '../db/client'

/**
 * Pure OHLCV aggregation into `tf` buckets (UTC-aligned).
 *   open = first source open, high = max, low = min, close = last source close,
 *   volume = sum, n = number of underlying 1m candles (source.n, or 1 for raw 1m).
 *   taker buy volume (bv) / trades (nt) = sum, null when any source minute lacks them (old rows);
 *   left out entirely when the sources don't carry them (plain OHLCV input).
 * Input must be ascending by `t`. Buckets are emitted even if incomplete; callers decide
 * which ones are final (see `rebuildDerived`) and `n` exposes gaps.
 */
export function aggregate(source: readonly (Candle | DerivedCandle)[], tf: DerivedTimeframe): DerivedCandle[] {
  const out: DerivedCandle[] = []
  let cur: DerivedCandle | null = null
  for (const s of source) {
    const b = bucketOpen(s.t, tf)
    const n = 'n' in s ? s.n : 1
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur)
      cur = { t: b, o: s.o, h: s.h, l: s.l, c: s.c, v: s.v, n }
      if (s.bv !== undefined) cur.bv = s.bv
      if (s.nt !== undefined) cur.nt = s.nt
    } else {
      if (s.h > cur.h) cur.h = s.h
      if (s.l < cur.l) cur.l = s.l
      cur.c = s.c
      cur.v += s.v
      cur.n += n
      if (cur.bv !== undefined) cur.bv = cur.bv === null || s.bv == null ? null : cur.bv + s.bv
      if (cur.nt !== undefined) cur.nt = cur.nt === null || s.nt == null ? null : cur.nt + s.nt
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Max number of 1m candles a bucket of `tf` can hold (240 for 4h). */
export const expectedMinutes = (tf: DerivedTimeframe): number => TF_MS[tf] / TF_MS['1m']

const CHUNK_MS = 7 * TF_MS['1d'] // multiple of 4h, so chunk edges never split a bucket

/**
 * Recompute 5m → 15m → 1h → 4h for 1m data in [from, coveredUntil).
 * `coveredUntil` = exclusive end of time for which 1m data is final; only buckets that end
 * at or before it are written (forming candles stay in memory, never in the DB).
 */
export function rebuildDerived(
  db: Db,
  repo: CandleRepo,
  symbolId: number,
  from: number,
  coveredUntil: number
): Record<DerivedTimeframe, number> {
  const start = bucketOpen(from, '4h')
  const written = { '5m': 0, '15m': 0, '1h': 0, '4h': 0 } as Record<DerivedTimeframe, number>
  const tx = db.$client.transaction(() => {
    for (const [target, src] of DERIVED_CASCADE) {
      let first: number | null = null
      let last: number | null = null
      for (let a = start; a < coveredUntil; a += CHUNK_MS) {
        const b = Math.min(a + CHUNK_MS, coveredUntil)
        const rows = repo.rangeFlow(src, symbolId, a, b)
        if (!rows.length) continue
        const buckets = aggregate(rows, target).filter((k) => k.t + TF_MS[target] <= coveredUntil)
        if (!buckets.length) continue
        repo.upsertDerived(target, symbolId, buckets)
        written[target] += buckets.length
        first ??= buckets[0]!.t
        last = buckets[buckets.length - 1]!.t
      }
      if (first !== null && last !== null) markSynced(db, symbolId, target, first, last)
    }
  })
  tx()
  return written
}
