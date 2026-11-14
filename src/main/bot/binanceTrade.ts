import { createHmac } from 'node:crypto'
import { FAPI_BASE } from '../exchange/binanceFutures'
import { HttpError, timeoutSignal, withRetry } from '../exchange/http'
import { logger } from '../logger'
import type { SymbolRules } from './sizing'

const log = logger('binance-trade')

export class BinanceApiError extends Error {
  constructor(
    readonly code: number,
    msg: string,
    readonly path: string
  ) {
    super(`Binance ${code}: ${msg}`)
  }
}

export interface ExchangeSymbol {
  symbol: string
  underlyingType: string
  underlyingSubType: string[]
  contractType: string
  status: string
  quoteAsset: string
  rules: SymbolRules
}

export interface OrderInfo {
  orderId: number
  clientOrderId: string
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'EXPIRED_IN_MATCH' | 'REJECTED'
  executedQty: string
  avgPrice: string
  updateTime: number
}

export interface PositionRisk {
  symbol: string
  positionAmt: string
  entryPrice: string
  unRealizedProfit: string
}

/**
 * Signed Binance USDT-M REST client for the bot (production only; testnet skipped by the user).
 * Reads retry; order mutations are never retried automatically (no duplicate orders) — callers
 * re-query by client id instead. Conditional orders (SL/TP market) go through the Algo Order API.
 */
export class BinanceTradeClient {
  private offset = 0
  private syncedAt = 0

  constructor(
    private readonly key = '',
    private readonly secret = '',
    private readonly base = FAPI_BASE
  ) {}

  async syncTime(): Promise<void> {
    const t0 = Date.now()
    const { serverTime } = await this.publicGet<{ serverTime: number }>('/fapi/v1/time')
    this.offset = serverTime - Math.round((t0 + Date.now()) / 2)
    this.syncedAt = Date.now()
  }

  /** Clock offset vs Binance (ms, positive = PC behind). */
  get clockOffsetMs(): number {
    return this.offset
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    if (!this.hasKeys()) throw new Error('API key Binance belum diisi (Settings → API keys)')
    // PC clocks drift; Binance rejects timestamps >1 s ahead (-1021). Sync lazily and every 30 min.
    if (Date.now() - this.syncedAt > 30 * 60_000) await this.syncTime()
    const once = async (): Promise<T> => {
      const qs = new URLSearchParams(
        Object.entries({ ...params, recvWindow: 5000, timestamp: Date.now() + this.offset }).map(([k, v]): [string, string] => [k, String(v)])
      )
      qs.set('signature', createHmac('sha256', this.secret).update(qs.toString()).digest('hex'))
      const res = await fetch(`${this.base}${path}?${qs}`, {
        method,
        headers: { 'X-MBX-APIKEY': this.key },
        signal: timeoutSignal(15_000)
      })
      const text = await res.text()
      if (!res.ok) {
        let body: { code?: number; msg?: string } = {}
        try {
          body = JSON.parse(text) as typeof body
        } catch {
          /* not json */
        }
        if (body.code !== undefined) throw new BinanceApiError(body.code, body.msg ?? '', path)
        throw new HttpError(res.status, `${this.base}${path}`, null, text)
      }
      return JSON.parse(text) as T
    }
    // -1021 = rejected for its timestamp (never executed), so resync + one retry is safe even for orders
    const run = async (): Promise<T> => {
      try {
        return await once()
      } catch (err) {
        if (!(err instanceof BinanceApiError && err.code === -1021)) throw err
        log.warn({ path, offset: this.offset }, 'timestamp rejected (-1021); resyncing clock')
        await this.syncTime()
        return once()
      }
    }
    if (method !== 'GET') return run()
    return withRetry(run, { retries: 3, onRetry: (a, err) => log.warn({ a, path, err: (err as Error).message }, 'retry') })
  }

  private async publicGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return withRetry(async () => {
      const qs = new URLSearchParams(params)
      const res = await fetch(`${this.base}${path}${qs.size ? `?${qs}` : ''}`, { signal: timeoutSignal(30_000) })
      if (!res.ok) throw new HttpError(res.status, path, null, await res.text())
      return (await res.json()) as T
    })
  }

  /** Total margin balance (wallet + unrealised PnL), USDT. */
  async equity(): Promise<number> {
    const a = await this.request<{ totalMarginBalance: string; availableBalance: string }>('GET', '/fapi/v3/account')
    return Number(a.totalMarginBalance)
  }

  async isHedgeMode(): Promise<boolean> {
    const r = await this.request<{ dualSidePosition: boolean }>('GET', '/fapi/v1/positionSide/dual')
    return r.dualSidePosition
  }

  async setIsolated(symbol: string): Promise<void> {
    try {
      await this.request('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' })
    } catch (err) {
      if (!(err instanceof BinanceApiError && err.code === -4046)) throw err // -4046 = already isolated
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.request('POST', '/fapi/v1/leverage', { symbol, leverage })
  }

  /** Post-only limit entry (GTX): rejected instead of filling as taker if price already crossed. */
  async limitEntry(p: { symbol: string; side: 'BUY' | 'SELL'; qty: string; price: string; clientId: string }): Promise<OrderInfo> {
    return this.request<OrderInfo>('POST', '/fapi/v1/order', {
      symbol: p.symbol,
      side: p.side,
      type: 'LIMIT',
      timeInForce: 'GTX',
      quantity: p.qty,
      price: p.price,
      newClientOrderId: p.clientId,
      newOrderRespType: 'RESULT'
    })
  }

  /** Reduce-only limit take-profit for the filled quantity (maker fee). */
  async limitTakeProfit(p: { symbol: string; side: 'BUY' | 'SELL'; qty: string; price: string; clientId: string }): Promise<OrderInfo> {
    return this.request<OrderInfo>('POST', '/fapi/v1/order', {
      symbol: p.symbol,
      side: p.side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: p.qty,
      price: p.price,
      reduceOnly: true,
      newClientOrderId: p.clientId
    })
  }

  /** Stop-market that closes the whole position at the trigger (mark price). */
  async stopLoss(p: { symbol: string; side: 'BUY' | 'SELL'; triggerPrice: string; clientId: string }): Promise<{ algoId: number; clientAlgoId: string }> {
    return this.request('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol: p.symbol,
      side: p.side,
      type: 'STOP_MARKET',
      triggerPrice: p.triggerPrice,
      closePosition: true,
      workingType: 'MARK_PRICE',
      priceProtect: true,
      clientAlgoId: p.clientId
    })
  }

  /**
   * Modify Order (PUT /fapi/v1/order): only for regular LIMIT orders (here the reduce-only TP).
   * Binance requires both quantity and price; algo/conditional orders cannot be modified.
   */
  async modifyOrder(p: { symbol: string; side: 'BUY' | 'SELL'; clientId: string; qty: string; price: string }): Promise<OrderInfo> {
    return this.request<OrderInfo>('PUT', '/fapi/v1/order', { symbol: p.symbol, origClientOrderId: p.clientId, side: p.side, quantity: p.qty, price: p.price })
  }

  /** Open algo (conditional) orders of a symbol (GET /fapi/v1/openAlgoOrders). */
  async openAlgoOrders(symbol: string): Promise<{ algoId: number; clientAlgoId: string; triggerPrice: string }[]> {
    return this.request('GET', '/fapi/v1/openAlgoOrders', { symbol })
  }

  /** Cancel one SL algo order by its client id (already gone = fine). */
  async cancelAlgo(symbol: string, clientAlgoId: string): Promise<void> {
    try {
      await this.request('DELETE', '/fapi/v1/algoOrder', { symbol, clientAlgoId })
    } catch (err) {
      if (err instanceof BinanceApiError && (err.code === -2011 || err.code === -2013)) return
      throw err
    }
  }

  /** Emergency close of a position with a reduce-only market order. */
  async marketClose(symbol: string, positionAmt: number): Promise<void> {
    // positionAmt comes back from Binance already on the lot step
    await this.request('POST', '/fapi/v1/order', {
      symbol,
      side: positionAmt > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: String(Math.abs(positionAmt)).includes('e') ? Math.abs(positionAmt).toFixed(8) : Math.abs(positionAmt),
      reduceOnly: true
    })
  }

  hasKeys(): boolean {
    return !!this.key && !!this.secret
  }

  async getOrder(symbol: string, clientId: string): Promise<OrderInfo | null> {
    try {
      return await this.request<OrderInfo>('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientId })
    } catch (err) {
      if (err instanceof BinanceApiError && err.code === -2013) return null // order does not exist
      throw err
    }
  }

  async cancelOrder(symbol: string, clientId: string): Promise<OrderInfo | null> {
    try {
      return await this.request<OrderInfo>('DELETE', '/fapi/v1/order', { symbol, origClientOrderId: clientId })
    } catch (err) {
      if (err instanceof BinanceApiError && (err.code === -2011 || err.code === -2013)) return null // already gone
      throw err
    }
  }

  /** Cancel every regular and algo (SL) order on the symbol. */
  async cancelAll(symbol: string): Promise<void> {
    await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol })
    await this.request('DELETE', '/fapi/v1/algoOpenOrders', { symbol })
  }

  async position(symbol: string): Promise<PositionRisk | null> {
    const rows = await this.request<PositionRisk[]>('GET', '/fapi/v3/positionRisk', { symbol })
    return rows.find((r) => Number(r.positionAmt) !== 0) ?? null
  }

  /** Realised PnL minus commission of fills since `from` (USDT-margined, commission in USDT). */
  async realised(symbol: string, from: number): Promise<{ pnl: number; lastPrice: number | null; lastTime: number | null }> {
    const fills = await this.request<{ realizedPnl: string; commission: string; commissionAsset: string; price: string; time: number }[]>(
      'GET',
      '/fapi/v1/userTrades',
      { symbol, startTime: from, limit: 1000 }
    )
    let pnl = 0
    for (const f of fills) pnl += Number(f.realizedPnl) - (f.commissionAsset === 'USDT' ? Number(f.commission) : 0)
    const last = fills.at(-1)
    return { pnl, lastPrice: last ? Number(last.price) : null, lastTime: last?.time ?? null }
  }

  /** Public: perpetual symbols with their order filters and underlying type. */
  async exchangeSymbols(): Promise<ExchangeSymbol[]> {
    type F = { filterType: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string }
    const info = await this.publicGet<{
      symbols: { symbol: string; underlyingType: string; underlyingSubType: string[]; contractType: string; status: string; quoteAsset: string; filters: F[] }[]
    }>('/fapi/v1/exchangeInfo')
    return info.symbols.map((s) => {
      const f = (t: string): F => s.filters.find((x) => x.filterType === t) ?? { filterType: t }
      return {
        symbol: s.symbol,
        underlyingType: s.underlyingType,
        underlyingSubType: s.underlyingSubType ?? [],
        contractType: s.contractType,
        status: s.status,
        quoteAsset: s.quoteAsset,
        rules: {
          tickSize: Number(f('PRICE_FILTER').tickSize ?? 0),
          stepSize: Number(f('LOT_SIZE').stepSize ?? 0),
          minQty: Number(f('LOT_SIZE').minQty ?? 0),
          minNotional: Number(f('MIN_NOTIONAL').notional ?? 0)
        }
      }
    })
  }

  /** Public: 24h quote volume per symbol. */
  async quoteVolumes(): Promise<Map<string, number>> {
    const rows = await this.publicGet<{ symbol: string; quoteVolume: string }[]>('/fapi/v1/ticker/24hr')
    return new Map(rows.map((r) => [r.symbol, Number(r.quoteVolume)]))
  }
}

/** Crypto-only filter: no TradFi equities, commodities (XAU), indices or pre-market contracts. */
export const isCryptoPerp = (s: ExchangeSymbol): boolean =>
  s.contractType === 'PERPETUAL' &&
  s.status === 'TRADING' &&
  s.quoteAsset === 'USDT' &&
  s.underlyingType === 'COIN' &&
  s.underlyingSubType.includes('Crypto')

export function topCrypto(symbols: readonly ExchangeSymbol[], volumes: ReadonlyMap<string, number>, n: number): string[] {
  return symbols
    .filter(isCryptoPerp)
    .map((s) => ({ s: s.symbol, v: volumes.get(s.symbol) ?? 0 }))
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((x) => x.s)
}
