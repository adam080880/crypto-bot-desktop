import type { Candle } from '@shared/candles'
import { TF_MS, bucketOpen, type DerivedTimeframe } from '@shared/timeframes'
import { aggregate } from '../sync/resample'

export const LIVE_TFS = ['3m', '5m', '10m', '15m', '45m', '1h', '2h', '3h', '4h'] as const satisfies readonly DerivedTimeframe[]

/** Earliest bucket start among the live timeframes containing `now` (a 45m bucket can start before the 4h one). */
export const formingStart = (now: number): number => Math.min(...LIVE_TFS.map((tf) => bucketOpen(now, tf)))
const MIN = TF_MS['1m']

/**
 * In-memory builder for forming higher-timeframe candles of one symbol.
 * Holds the closed 1m candles of the current buckets (≤ ~285, see formingStart) plus the forming 1m candle,
 * and derives forming 3m…4h with the same `aggregate()` used for stored data.
 */
export class FormingCandles {
  private closed: Candle[] = []
  private forming: Candle | null = null

  /** Seed with closed 1m candles from the DB (any range; only the current buckets are kept). */
  seed(closed1m: readonly Candle[]): void {
    this.closed = [...closed1m].sort((a, b) => a.t - b.t)
    this.trim()
  }

  /** Apply a 1m kline update. Returns the current forming candles for 1m…4h. */
  update(k: Candle, isClosed: boolean): Record<'1m' | (typeof LIVE_TFS)[number], Candle> {
    if (isClosed) {
      const last = this.closed[this.closed.length - 1]
      if (!last || k.t > last.t) this.closed.push(k)
      else if (k.t === last.t) this.closed[this.closed.length - 1] = k
      this.forming = null
    } else {
      this.forming = k
    }
    this.trim(k.t)
    const out = { '1m': k } as Record<'1m' | (typeof LIVE_TFS)[number], Candle>
    const all = this.forming ? [...this.closed, this.forming] : this.closed
    for (const tf of LIVE_TFS) {
      const start = bucketOpen(k.t, tf)
      const inBucket = all.filter((c) => c.t >= start && c.t < start + TF_MS[tf])
      const agg = aggregate(inBucket, tf)
      const bar = agg[agg.length - 1]
      if (bar) out[tf] = { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }
    }
    return out
  }

  private trim(now = this.closed[this.closed.length - 1]?.t ?? 0): void {
    const start = formingStart(now)
    if (this.closed.length && this.closed[0]!.t < start) this.closed = this.closed.filter((c) => c.t >= start)
    // guard against unbounded growth if timestamps are odd
    if (this.closed.length > 300) this.closed = this.closed.slice(-300)
  }

  get closedCount(): number {
    return this.closed.length
  }

  static readonly STEP = MIN
}
