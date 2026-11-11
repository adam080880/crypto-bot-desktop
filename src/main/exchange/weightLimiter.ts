import { sleep } from './http'

/**
 * Client-side guard for Binance's REQUEST_WEIGHT limit (per UTC minute).
 * Reserves weight before a request and syncs to the server's X-MBX-USED-WEIGHT-1M header.
 */
export class WeightLimiter {
  private windowStart = 0
  private used = 0

  constructor(
    private readonly limitPerMinute = 2400,
    private readonly safety = 0.75,
    private readonly now: () => number = Date.now
  ) {}

  get cap(): number {
    return Math.floor(this.limitPerMinute * this.safety)
  }

  get usedWeight(): number {
    this.roll()
    return this.used
  }

  private roll(): void {
    const w = Math.floor(this.now() / 60_000) * 60_000
    if (w !== this.windowStart) {
      this.windowStart = w
      this.used = 0
    }
  }

  /** Wait until `weight` fits in the current minute's budget, then reserve it. */
  async acquire(weight: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.roll()
      if (this.used + weight <= this.cap) {
        this.used += weight
        return
      }
      const wait = this.windowStart + 60_000 - this.now() + 250
      await sleep(Math.max(wait, 50), signal)
    }
  }

  /** Server is the source of truth; never lower our count below what it reports. */
  syncFromHeader(value: string | null): void {
    if (!value) return
    const n = Number(value)
    if (!Number.isFinite(n)) return
    this.roll()
    this.used = Math.max(this.used, n)
  }

  /** After a 429/418 treat the window as exhausted. */
  saturate(): void {
    this.roll()
    this.used = this.limitPerMinute
  }
}
