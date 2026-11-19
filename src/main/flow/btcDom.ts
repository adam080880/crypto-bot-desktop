import type { Candle } from '@shared/candles'
import type { SmcConfig } from '@shared/config'
import { TF_MS } from '@shared/timeframes'
import { BinanceFuturesClient } from '../exchange/binanceFutures'
import { logger } from '../logger'
import { analyzeSmc, type SmcAnalysisFull } from '../strategy/analyze'

/**
 * BTC dominance (user 2026-11-17): Binance's BTCDOMUSDT index contract, read straight from the public
 * REST klines. Not stored (it stays in data.excludeSymbols, so it is never backfilled, screened or traded).
 */
export const BTCDOM = 'BTCDOMUSDT'
type Tf = SmcConfig['btcDomTimeframe']
const log = logger('btcdom')
const LIVE_CANDLES = 1000
const RETRY_MS = 30_000

/** Closed BTCDOM candles with open time in [from, to) (the forming candle is excluded). */
export async function fetchBtcDom(tf: Tf, from: number, to = Date.now(), client = new BinanceFuturesClient(), signal?: AbortSignal): Promise<Candle[]> {
  const end = Math.floor(to / TF_MS[tf]) * TF_MS[tf]
  const out: Candle[] = []
  for await (const rows of client.klines(BTCDOM, tf, Math.max(0, from), end, signal)) out.push(...rows)
  return out
}

/**
 * Per-process cache of the live BTCDOM candles. `get` never blocks: it returns what is cached and starts a
 * background refresh once a newer candle has closed. Off until `enable()` (tests / CLI never hit the network).
 */
export class BtcDomFeed {
  private candles: Candle[] = []
  private tf: Tf | null = null
  private loading: Promise<void> | null = null
  private triedAt = 0
  private enabled = false
  private analyses = new WeakMap<SmcConfig, SmcAnalysisFull>()

  constructor(private readonly fetcher: (tf: Tf, from: number, to: number) => Promise<Candle[]> = (tf, from, to) => fetchBtcDom(tf, from, to)) {}

  enable(): void {
    this.enabled = true
  }

  /** Fetch now (awaitable; used to warm up before the first scan). */
  refresh(tf: Tf, now = Date.now()): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    if (this.loading) return this.loading
    this.triedAt = now
    this.loading = this.fetcher(tf, now - LIVE_CANDLES * TF_MS[tf], now)
      .then((c) => {
        if (!c.length) throw new Error('no candles')
        this.candles = c
        this.tf = tf
        this.analyses = new WeakMap()
      })
      .catch((err) => log.warn({ err: (err as Error).message }, 'BTCDOM fetch failed; btcDom tag skipped until it works'))
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  /** Is a newer candle closed than the newest one cached (or the timeframe changed)? */
  stale(tf: Tf, now = Date.now()): boolean {
    if (this.tf !== tf || !this.candles.length) return true
    return now >= this.candles.at(-1)!.t + 2 * TF_MS[tf]
  }

  /** Cached analysis (undefined when none yet / wrong timeframe); refreshes in the background when stale. */
  get(cfg: SmcConfig, now = Date.now()): SmcAnalysisFull | undefined {
    const tf = cfg.btcDomTimeframe
    if (this.enabled && this.stale(tf, now) && now - this.triedAt >= RETRY_MS) void this.refresh(tf, now)
    if (this.tf !== tf || !this.candles.length) return undefined
    let a = this.analyses.get(cfg)
    if (!a) {
      a = analyzeSmc(this.candles, tf, cfg)
      this.analyses.set(cfg, a)
    }
    return a
  }
}

export const btcDomFeed = new BtcDomFeed()
