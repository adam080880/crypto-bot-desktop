import type { BotTrade } from '@shared/bot'
import type { BinanceTradeClient } from './binanceTrade'
import { fmtStep, roundStep, type OrderPlan, type SymbolRules } from './sizing'

/** Price extremes seen since the previous sync (from the live 1m stream). */
export interface Bar {
  high: number
  low: number
  last: number
}

export type TradePatch = Partial<BotTrade>

/** Fees used by the paper broker and the risk estimate (same defaults as the backtest). */
export const FEES = { makerPct: 0.02, takerPct: 0.05, slippagePct: 0.02 }

export interface Broker {
  readonly mode: 'paper' | 'live'
  equity(): Promise<number>
  /** Place the limit entry and its SL together. Throws (after cleaning up) if the SL can't be placed. */
  open(trade: BotTrade, plan: OrderPlan, rules: SymbolRules): Promise<TradePatch>
  /** Cancel a pending entry. A partial fill turns into an open trade (SL stays, TP added). */
  cancel(trade: BotTrade, reason: string, rules: SymbolRules | undefined): Promise<TradePatch>
  /** Detect fills and exits. */
  sync(trade: BotTrade, bar: Bar | null, rules: SymbolRules | undefined): Promise<TradePatch | null>
}

const side = (t: BotTrade, entry: boolean): 'BUY' | 'SELL' => ((t.direction === 'bullish') === entry ? 'BUY' : 'SELL')

/** PnL of a closed paper trade incl. maker entry, maker TP or taker SL + slippage. */
export function paperPnl(t: Pick<BotTrade, 'direction' | 'entry' | 'qty'>, exit: number, viaStop: boolean): number {
  const dir = t.direction === 'bullish' ? 1 : -1
  const fill = viaStop ? exit * (1 - dir * (FEES.slippagePct / 100)) : exit
  const fees = t.qty * t.entry * (FEES.makerPct / 100) + t.qty * fill * ((viaStop ? FEES.takerPct : FEES.makerPct) / 100)
  return dir * (fill - t.entry) * t.qty - fees
}

/**
 * Simulated account on live prices. Within one bar the worse outcome counts first: TP before a
 * fill → missed (handled by the service), fill + SL in the same bar → loss.
 */
export class PaperBroker implements Broker {
  readonly mode = 'paper' as const
  constructor(private readonly getEquity: () => number) {}

  async equity(): Promise<number> {
    return this.getEquity()
  }

  async open(): Promise<TradePatch> {
    return {}
  }

  async cancel(_t: BotTrade, reason: string): Promise<TradePatch> {
    return { status: 'cancelled', reason, closedAt: Date.now() }
  }

  async sync(t: BotTrade, bar: Bar | null): Promise<TradePatch | null> {
    if (!bar) return null
    const bull = t.direction === 'bullish'
    const now = Date.now()
    let patch: TradePatch | null = null
    if (t.status === 'pending') {
      if (!(bull ? bar.low <= t.entry : bar.high >= t.entry)) return null
      patch = { status: 'open', filledAt: now, filledQty: t.qty }
    }
    if (bull ? bar.low <= t.sl : bar.high >= t.sl)
      return { ...patch, status: 'closed', reason: 'sl', closedAt: now, exitPrice: t.sl, pnl: paperPnl(t, t.sl, true) }
    // a TP in the same bar as the fill is not counted (order inside the bar is unknown)
    if (!patch && (bull ? bar.high >= t.tp : bar.low <= t.tp))
      return { status: 'closed', reason: 'tp', closedAt: now, exitPrice: t.tp, pnl: paperPnl(t, t.tp, false) }
    return patch
  }
}

/** Real orders on Binance USDT-M (one-way mode, isolated margin). */
export class LiveBroker implements Broker {
  readonly mode = 'live' as const
  private prepared = new Map<string, number>()

  constructor(private readonly client: BinanceTradeClient) {}

  async equity(): Promise<number> {
    return this.client.equity()
  }

  async open(t: BotTrade, plan: OrderPlan, rules: SymbolRules): Promise<TradePatch> {
    if (this.prepared.get(t.symbol) !== plan.leverage) {
      await this.client.setIsolated(t.symbol)
      await this.client.setLeverage(t.symbol, plan.leverage)
      this.prepared.set(t.symbol, plan.leverage)
    }
    const entryId = `smc-${t.id}-e`
    const slId = `smc-${t.id}-s`
    const o = await this.client.limitEntry({
      symbol: t.symbol,
      side: side(t, true),
      qty: fmtStep(plan.qty, rules.stepSize),
      price: fmtStep(plan.entry, rules.tickSize),
      clientId: entryId
    })
    if (o.status === 'EXPIRED' || o.status === 'REJECTED' || o.status === 'EXPIRED_IN_MATCH')
      throw new Error('limit post-only ditolak (harga sudah melewati entry)')
    try {
      await this.client.stopLoss({ symbol: t.symbol, side: side(t, false), triggerPrice: fmtStep(plan.sl, rules.tickSize), clientId: slId })
    } catch (err) {
      // never leave an entry without its stop
      const c = await this.client.cancelOrder(t.symbol, entryId).catch(() => null)
      if (c && Number(c.executedQty) > 0) await this.flatten(t)
      throw new Error(`SL gagal dipasang, entry dibatalkan: ${(err as Error).message}`)
    }
    return { entryOrderId: entryId, slOrderId: slId }
  }

  /** Emergency: close whatever filled with a reduce-only market order (cancelAll first). */
  private async flatten(t: BotTrade): Promise<void> {
    await this.client.cancelAll(t.symbol)
    const p = await this.client.position(t.symbol)
    if (!p) return
    await this.client.marketClose(t.symbol, Number(p.positionAmt))
  }

  private async placeTp(t: BotTrade, qty: number, rules: SymbolRules | undefined): Promise<string> {
    const id = `smc-${t.id}-t`
    if (!rules) throw new Error(`aturan order ${t.symbol} belum dimuat, TP belum dipasang (SL tetap aktif)`)
    const q = roundStep(qty, rules.stepSize, 'floor')
    await this.client.limitTakeProfit({ symbol: t.symbol, side: side(t, false), qty: fmtStep(q, rules.stepSize), price: fmtStep(t.tp, rules.tickSize), clientId: id })
    return id
  }

  async cancel(t: BotTrade, reason: string, rules: SymbolRules | undefined): Promise<TradePatch> {
    const c = await this.client.cancelOrder(t.symbol, t.entryOrderId!)
    const o = c ?? (await this.client.getOrder(t.symbol, t.entryOrderId!))
    const filled = o ? Number(o.executedQty) : 0
    if (filled > 0) {
      const tpOrderId = await this.placeTp(t, filled, rules)
      return { status: 'open', filledAt: t.filledAt ?? o!.updateTime, filledQty: filled, tpOrderId }
    }
    await this.client.cancelAll(t.symbol) // removes the SL algo order
    return { status: 'cancelled', reason, closedAt: Date.now() }
  }

  async sync(t: BotTrade, _bar: Bar | null, rules: SymbolRules | undefined): Promise<TradePatch | null> {
    if (t.status === 'pending') {
      const o = await this.client.getOrder(t.symbol, t.entryOrderId!)
      if (!o) return { status: 'cancelled', reason: 'external', closedAt: Date.now() }
      if (o.status === 'FILLED') {
        const tpOrderId = await this.placeTp(t, Number(o.executedQty), rules)
        return { status: 'open', filledAt: o.updateTime, filledQty: Number(o.executedQty), tpOrderId }
      }
      if (o.status === 'CANCELED' || o.status === 'EXPIRED' || o.status === 'REJECTED' || o.status === 'EXPIRED_IN_MATCH') {
        if (Number(o.executedQty) > 0) {
          const tpOrderId = await this.placeTp(t, Number(o.executedQty), rules)
          return { status: 'open', filledAt: o.updateTime, filledQty: Number(o.executedQty), tpOrderId }
        }
        await this.client.cancelAll(t.symbol)
        return { status: 'cancelled', reason: 'external', closedAt: Date.now() }
      }
      return null
    }
    if (t.status === 'open') {
      const p = await this.client.position(t.symbol)
      if (p) return null
      // flat: SL or TP done (or closed by hand) → clean up the other leg and book the result
      await this.client.cancelAll(t.symbol)
      const r = await this.client.realised(t.symbol, (t.filledAt ?? t.createdAt) - 60_000)
      const exit = r.lastPrice
      const bull = t.direction === 'bullish'
      // stop fills slip past the SL, so classify by which side of the entry the exit was
      const reason = exit === null ? 'external' : (bull ? exit > t.entry : exit < t.entry) ? 'tp' : 'sl'
      return { status: 'closed', reason, closedAt: r.lastTime ?? Date.now(), exitPrice: exit, pnl: r.pnl }
    }
    return null
  }
}
