import type { Candle } from '@shared/candles'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { SymbolInfo } from '../db/symbolsRepo'
import { logger } from '../logger'
import { HttpError, timeoutSignal, withRetry } from './http'
import { WeightLimiter } from './weightLimiter'

const log = logger('binance-rest')
export const FAPI_BASE = 'https://fapi.binance.com'

/** Binance USDT-M klines weight by `limit`. 1000 gives the best candles-per-weight ratio. */
export function klinesWeight(limit: number): number {
  if (limit < 100) return 1
  if (limit < 500) return 2
  if (limit <= 1000) return 5
  return 10
}

/**
 * Minimal public-market-data client for USDT-M futures (no API key needed).
 * Market data always comes from production endpoints; testnet prices are synthetic.
 * Order placement will go through ccxt later and is intentionally not here.
 */
export class BinanceFuturesClient {
  constructor(
    readonly limiter = new WeightLimiter(),
    private readonly base = FAPI_BASE
  ) {}

  private async get<T>(path: string, params: Record<string, string | number>, weight: number, signal?: AbortSignal): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ''}`
    return withRetry(
      async () => {
        await this.limiter.acquire(weight, signal)
        const res = await fetch(url, { signal: timeoutSignal(30_000, signal) })
        this.limiter.syncFromHeader(res.headers.get('x-mbx-used-weight-1m'))
        if (!res.ok) {
          const ra = res.headers.get('retry-after')
          if (res.status === 429 || res.status === 418) {
            this.limiter.saturate()
            log.warn({ status: res.status, retryAfter: ra, path }, 'rate limited by Binance')
          }
          throw new HttpError(res.status, url, ra ? Number(ra) * 1000 : null, await res.text())
        }
        return (await res.json()) as T
      },
      {
        signal,
        onRetry: (attempt, err, delay) =>
          log.warn({ attempt, delay, err: (err as Error).message, path }, 'retrying request')
      }
    )
  }

  /** Active USDT-margined perpetual contracts (status TRADING). */
  async perpetualSymbols(signal?: AbortSignal): Promise<SymbolInfo[]> {
    const info = await this.get<{
      symbols: {
        symbol: string
        contractType: string
        status: string
        quoteAsset: string
        baseAsset: string
        onboardDate: number
      }[]
    }>('/fapi/v1/exchangeInfo', {}, 1, signal)
    return info.symbols
      .filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map((s) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        onboardDate: s.onboardDate,
        status: s.status
      }))
  }

  /**
   * Closed klines with open time in [startTime, endTime), paging with limit 1000.
   * `endTime` should be the start of the currently forming candle so it's excluded.
   */
  async *klines(
    symbol: string,
    tf: Timeframe,
    startTime: number,
    endTime: number,
    signal?: AbortSignal
  ): AsyncGenerator<Candle[]> {
    let cursor = startTime
    while (cursor < endTime) {
      // Ask only for what's missing: small catch-ups cost weight 1 instead of 5.
      const limit = Math.min(1000, Math.max(1, Math.ceil((endTime - cursor) / TF_MS[tf])))
      const raw = await this.get<(string | number)[][]>(
        '/fapi/v1/klines',
        { symbol, interval: tf, startTime: cursor, endTime: endTime - 1, limit },
        klinesWeight(limit),
        signal
      )
      const rows = raw
        .map(parseKline)
        .filter((c) => c.t >= cursor && c.t < endTime)
      if (rows.length) yield rows
      if (raw.length < limit) return
      const last = parseKline(raw[raw.length - 1]!).t
      cursor = last + TF_MS[tf]
    }
  }
}

export function parseKline(k: (string | number)[]): Candle {
  return { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) }
}
