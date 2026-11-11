import type { Candle } from '@shared/candles'
import { TF_MS, bucketOpen, type DerivedTimeframe } from '@shared/timeframes'
import { aggregate } from '../sync/resample'

const LIVE_TFS = ['5m', '15m', '1h', '4h'] as const satisfies readonly DerivedTimeframe[]
const MIN = TF_MS['1m']

/**
 * In-memory builder for forming higher-timeframe candles of one symbol.
 * Holds the closed 1m candles of the current 4h bucket (≤ 240) plus the forming 1m candle,
 * and derives forming 5m/15m/1h/4h with the same `aggregate()` used for stored data.
 */
export class FormingCandles {
  private closed: Candle[] = []
  private forming: Candle | null = null

  /** Seed with closed 1m candles from the DB (any range; only the current 4h bucket is kept). */
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
    const start = bucketOpen(now, '4h')
    if (this.closed.length && this.closed[0]!.t < start) this.closed = this.closed.filter((c) => c.t >= start)
    // guard against unbounded growth if timestamps are odd
    if (this.closed.length > 240) this.closed = this.closed.slice(-240)
  }

  get closedCount(): number {
    return this.closed.length
  }

  static readonly STEP = MIN
}
