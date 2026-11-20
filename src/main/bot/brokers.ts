import type { BotTrade } from '@shared/bot'
import { BinanceApiError, type BinanceTradeClient } from './binanceTrade'
import { fmtStep, roundStep, type LeverageBracket, type OrderPlan, type SymbolRules } from './sizing'

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
  /** Leverage brackets of a symbol (paper: none → config cap + 1 % maintenance margin assumed). */
  leverageBrackets(symbol: string): Promise<LeverageBracket[]>
  /** Place the limit entry (live: SL follows as soon as it fills, see LiveBroker.protect). */
  open(trade: BotTrade, plan: OrderPlan, rules: SymbolRules): Promise<TradePatch>
  /** Cancel a pending entry. A partial fill turns into an open trade (SL stays, TP added). */
  cancel(trade: BotTrade, reason: string, rules: SymbolRules | undefined): Promise<TradePatch>
  /** Detect fills and exits. */
  sync(trade: BotTrade, bar: Bar | null, rules: SymbolRules | undefined): Promise<TradePatch | null>
  /** Move the stop of an open position (tiered exit / order flow). Never leaves it unprotected. */
  moveStop(trade: BotTrade, sl: number, rules: SymbolRules): Promise<TradePatch>
  /** Manual: cancel what is still working and close whatever is filled at market (`last` = paper fill). */
  closeNow(trade: BotTrade, last: number | null): Promise<TradePatch>
  /** Close part of an open position (ladder partial) at about `price`. */
  partialClose(trade: BotTrade, qty: number, price: number, rules: SymbolRules): Promise<TradePatch>
}

const side = (t: BotTrade, entry: boolean): 'BUY' | 'SELL' => ((t.direction === 'bullish') === entry ? 'BUY' : 'SELL')

/** PnL of `qty` (default: the whole trade) closed at `exit`, incl. maker entry, maker TP or taker SL + slippage. */
export function paperPnl(t: Pick<BotTrade, 'direction' | 'entry' | 'qty'>, exit: number, viaStop: boolean, qty = t.qty): number {
  const dir = t.direction === 'bullish' ? 1 : -1
  const fill = viaStop ? exit * (1 - dir * (FEES.slippagePct / 100)) : exit
  const fees = qty * t.entry * (FEES.makerPct / 100) + qty * fill * ((viaStop ? FEES.takerPct : FEES.makerPct) / 100)
  return dir * (fill - t.entry) * qty - fees
}

/** Quantity still open after ladder partials. */
export const openQty = (t: Pick<BotTrade, 'qty' | 'filledQty' | 'closedQty'>): number => (t.filledQty ?? t.qty) - (t.closedQty ?? 0)

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

  async leverageBrackets(): Promise<LeverageBracket[]> {
    return []
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
    const rest = openQty({ ...t, ...patch })
    const booked = t.realized ?? 0
    // stop exits at a loss are 'sl'; a stop that was moved into profit (BE / trail / order flow) is 'trail'
    if (bull ? bar.low <= t.sl : bar.high >= t.sl) {
      const pnl = booked + paperPnl(t, t.sl, true, rest)
      const reason = (bull ? t.sl > t.entry : t.sl < t.entry) ? 'trail' : 'sl'
      return { ...patch, status: 'closed', reason, closedAt: now, exitPrice: t.sl, pnl }
    }
    // a TP in the same bar as the fill is not counted (order inside the bar is unknown)
    if (!patch && t.tp !== null && (bull ? bar.high >= t.tp : bar.low <= t.tp))
      return { status: 'closed', reason: 'tp', closedAt: now, exitPrice: t.tp, pnl: booked + paperPnl(t, t.tp, false, rest) }
    return patch
  }

  async moveStop(_t: BotTrade, sl: number): Promise<TradePatch> {
    return { sl }
  }

  async closeNow(t: BotTrade, last: number | null): Promise<TradePatch> {
    if (t.status === 'pending') return { status: 'cancelled', reason: 'manual', closedAt: Date.now() }
    if (last === null) throw new Error('harga terakhir belum ada, coba lagi sebentar')
    // market exit: taker fee + slippage, like a stop
    return { status: 'closed', reason: 'manual-close', closedAt: Date.now(), exitPrice: last, pnl: (t.realized ?? 0) + paperPnl(t, last, true, openQty(t)) }
  }

  async partialClose(t: BotTrade, qty: number, price: number): Promise<TradePatch> {
    // ladder partials are limit-like fills at the step level (maker)
    return { closedQty: (t.closedQty ?? 0) + qty, realized: (t.realized ?? 0) + paperPnl(t, price, false, qty), partials: (t.partials ?? 0) + 1 }
  }
}

/** Real orders on Binance USDT-M (one-way mode, isolated margin). */
export class LiveBroker implements Broker {
  readonly mode = 'live' as const
  private prepared = new Map<string, number>()
  private brackets = new Map<string, { at: number; v: LeverageBracket[] }>()

  constructor(private readonly client: BinanceTradeClient) {}

  async equity(): Promise<number> {
    return this.client.equity()
  }

  async leverageBrackets(symbol: string): Promise<LeverageBracket[]> {
    const c = this.brackets.get(symbol)
    if (c && Date.now() - c.at < 3_600_000) return c.v
    const v = await this.client.leverageBrackets(symbol)
    this.brackets.set(symbol, { at: Date.now(), v })
    return v
  }

  /**
   * Places only the limit entry. Binance refuses a closePosition stop while there is no position
   * (-4509, TIF GTE needs an open position), so the SL goes on as soon as a fill is seen (`protect`).
   */
  async open(t: BotTrade, plan: OrderPlan, rules: SymbolRules): Promise<TradePatch> {
    if (this.prepared.get(t.symbol) !== plan.leverage) {
      await this.client.setIsolated(t.symbol)
      await this.client.setLeverage(t.symbol, plan.leverage)
      this.prepared.set(t.symbol, plan.leverage)
    }
    const entryId = `smc-${t.id}-e`
    const o = await this.client.limitEntry({
      symbol: t.symbol,
      side: side(t, true),
      qty: fmtStep(plan.qty, rules.stepSize),
      price: fmtStep(plan.entry, rules.tickSize),
      clientId: entryId
    })
    if (o.status === 'EXPIRED' || o.status === 'REJECTED' || o.status === 'EXPIRED_IN_MATCH')
      throw new Error('limit post-only ditolak (harga sudah melewati entry)')
    const patch: TradePatch = { entryOrderId: entryId, slOrderId: null }
    // filled right away (can happen between placing and this check): protect immediately
    if (Number(o.executedQty) > 0) Object.assign(patch, await this.protect({ ...t, ...patch }, rules))
    return patch
  }

  /**
   * Put the closePosition SL on a (partly) filled entry. If the stop can't be placed (price already
   * beyond it, or any other refusal) the position is closed at market and the trade is booked as
   * closed — never left without a stop.
   */
  private async protect(t: BotTrade, rules: SymbolRules | undefined): Promise<TradePatch> {
    if (t.slOrderId) return {}
    const id = `smc-${t.id}-s`
    try {
      if (!rules) throw new Error(`aturan order ${t.symbol} belum dimuat`)
      await this.client.stopLoss({ symbol: t.symbol, side: side(t, false), triggerPrice: fmtStep(t.sl, rules.tickSize), clientId: id })
      return { slOrderId: id }
    } catch (err) {
      // -4116 duplicate client id: this exact stop is already on the exchange (placed by an earlier call)
      if (err instanceof BinanceApiError && err.code === -4116) return { slOrderId: id }
      await this.client.cancelOrder(t.symbol, t.entryOrderId!).catch(() => null)
      await this.flatten(t)
      const r = await this.client.realised(t.symbol, (t.filledAt ?? t.createdAt) - 60_000).catch(() => null)
      return {
        status: 'closed',
        reason: `sl-gagal: ${(err as Error).message}`.slice(0, 200),
        closedAt: r?.lastTime ?? Date.now(),
        exitPrice: r?.lastPrice ?? null,
        pnl: r?.pnl ?? 0
      }
    }
  }

  /** Emergency: close whatever filled with a reduce-only market order (cancelAll first). */
  private async flatten(t: BotTrade): Promise<void> {
    await this.client.cancelAll(t.symbol)
    const p = await this.client.position(t.symbol)
    if (!p) return
    await this.client.marketClose(t.symbol, Number(p.positionAmt))
  }

  /** Reduce-only TP for `qty` (null when the plan has no TP). New client id per placement. */
  private async placeTp(t: BotTrade, qty: number, rules: SymbolRules | undefined): Promise<string | null> {
    if (t.tp === null) return null
    const id = `smc-${t.id}-t${t.partials ?? 0}`
    if (!rules) throw new Error(`aturan order ${t.symbol} belum dimuat, TP belum dipasang (SL tetap aktif)`)
    const q = roundStep(qty, rules.stepSize, 'floor')
    await this.client.limitTakeProfit({ symbol: t.symbol, side: side(t, false), qty: fmtStep(q, rules.stepSize), price: fmtStep(t.tp, rules.tickSize), clientId: id })
    return id
  }

  /**
   * Binance docs: untriggered conditional (algo) orders cannot be modified, so a stop move is
   * cancel + place. The docs don't say whether two closePosition stops may coexist, so:
   *  1. place the new stop first (never unprotected); if that works, cancel the old one — if the
   *     cancel fails the old, wider stop just stays as a spare (cancelAll removes it when flat);
   *  2. -4142 (stop would trigger immediately: price is already beyond the new level) → close at
   *     market, which is what that stop would do;
   *  3. any other refusal (e.g. a closePosition stop already exists, -4045 max stop orders):
   *     cancel the old stop, place the new one;
   *  4. if even that fails, close the position at market rather than leave it without a stop.
   */
  async moveStop(t: BotTrade, sl: number, rules: SymbolRules): Promise<TradePatch> {
    const seq = (t.slSeq ?? 0) + 1
    const id = `smc-${t.id}-s${seq}`
    const place = (): Promise<unknown> => this.client.stopLoss({ symbol: t.symbol, side: side(t, false), triggerPrice: fmtStep(sl, rules.tickSize), clientId: id })
    let refused: unknown = null
    try {
      await place()
    } catch (err) {
      refused = err
    }
    // -4116: the stop with this id is already placed (an earlier call got through) → treat as moved
    if (!refused || (refused instanceof BinanceApiError && refused.code === -4116)) {
      if (t.slOrderId) await this.client.cancelAlgo(t.symbol, t.slOrderId).catch(() => undefined)
      return { sl, slOrderId: id, slSeq: seq }
    }
    if (refused instanceof BinanceApiError && refused.code === -4142) {
      await this.flatten(t)
      throw new Error(`harga sudah lewat SL baru ${sl} (-4142), posisi ditutup market`)
    }
    if (t.slOrderId) await this.client.cancelAlgo(t.symbol, t.slOrderId)
    try {
      await place()
    } catch (err) {
      await this.flatten(t)
      throw new Error(`SL baru gagal dipasang, posisi ditutup market: ${(err as Error).message}`)
    }
    return { sl, slOrderId: id, slSeq: seq }
  }

  /**
   * Ladder partial. The TP (regular reduce-only LIMIT) is shrunk first via Modify Order so the
   * reduce-only orders never exceed the position (-2022), then the partial goes out as a
   * reduce-only market order. If the modify is refused, the TP is cancelled and re-placed.
   */
  async partialClose(t: BotTrade, qty: number, _price: number, rules: SymbolRules): Promise<TradePatch> {
    const q = roundStep(qty, rules.stepSize, 'floor')
    if (q <= 0) return {}
    const next = { ...t, closedQty: (t.closedQty ?? 0) + q, partials: (t.partials ?? 0) + 1 }
    const rest = roundStep(openQty(next), rules.stepSize, 'floor')
    let tpOrderId = t.tpOrderId
    if (t.tpOrderId && t.tp !== null) {
      try {
        await this.client.modifyOrder({ symbol: t.symbol, side: side(t, false), clientId: t.tpOrderId, qty: fmtStep(rest, rules.stepSize), price: fmtStep(t.tp, rules.tickSize) })
      } catch {
        await this.client.cancelOrder(t.symbol, t.tpOrderId)
        tpOrderId = null
      }
    }
    await this.client.marketClose(t.symbol, t.direction === 'bullish' ? q : -q)
    if (t.tpOrderId && tpOrderId === null) tpOrderId = await this.placeTp(next, rest, rules)
    return { closedQty: next.closedQty, partials: next.partials, tpOrderId }
  }


  /**
   * Manual close. Order matters: the remaining entry is cancelled, then the position is closed with a
   * reduce-only market order while its SL is still in place, and only then are the SL/TP removed.
   */
  async closeNow(t: BotTrade): Promise<TradePatch> {
    if (t.entryOrderId && t.status === 'pending') await this.client.cancelOrder(t.symbol, t.entryOrderId).catch(() => null)
    const p = await this.client.position(t.symbol)
    if (p) await this.client.marketClose(t.symbol, Number(p.positionAmt))
    await this.client.cancelAll(t.symbol)
    if (!p && t.status === 'pending') return { status: 'cancelled', reason: 'manual', closedAt: Date.now() }
    const r = await this.client.realised(t.symbol, (t.filledAt ?? t.createdAt) - 60_000)
    return { status: 'closed', reason: 'manual-close', closedAt: r.lastTime ?? Date.now(), exitPrice: r.lastPrice, pnl: r.pnl }
  }

  async cancel(t: BotTrade, reason: string, rules: SymbolRules | undefined): Promise<TradePatch> {
    const c = await this.client.cancelOrder(t.symbol, t.entryOrderId!)
    const o = c ?? (await this.client.getOrder(t.symbol, t.entryOrderId!))
    const filled = o ? Number(o.executedQty) : 0
    if (filled > 0) {
      const sl = await this.protect(t, rules)
      if (sl.status === 'closed') return sl
      const tpOrderId = await this.placeTp(t, filled, rules)
      return { ...sl, status: 'open', filledAt: t.filledAt ?? o!.updateTime, filledQty: filled, tpOrderId }
    }
    await this.client.cancelAll(t.symbol) // removes the SL algo order
    return { status: 'cancelled', reason, closedAt: Date.now() }
  }

  async sync(t: BotTrade, _bar: Bar | null, rules: SymbolRules | undefined): Promise<TradePatch | null> {
    if (t.status === 'pending') {
      const o = await this.client.getOrder(t.symbol, t.entryOrderId!)
      if (!o) return { status: 'cancelled', reason: 'external', closedAt: Date.now() }
      if (o.status === 'FILLED') {
        const sl = await this.protect(t, rules)
        if (sl.status === 'closed') return sl
        const tpOrderId = await this.placeTp(t, Number(o.executedQty), rules)
        return { ...sl, status: 'open', filledAt: o.updateTime, filledQty: Number(o.executedQty), tpOrderId }
      }
      if (o.status === 'CANCELED' || o.status === 'EXPIRED' || o.status === 'REJECTED' || o.status === 'EXPIRED_IN_MATCH') {
        if (Number(o.executedQty) > 0) {
          const sl = await this.protect(t, rules)
          if (sl.status === 'closed') return sl
          const tpOrderId = await this.placeTp(t, Number(o.executedQty), rules)
          return { ...sl, status: 'open', filledAt: o.updateTime, filledQty: Number(o.executedQty), tpOrderId }
        }
        await this.client.cancelAll(t.symbol)
        return { status: 'cancelled', reason: 'external', closedAt: Date.now() }
      }
      // partly filled and still working: the filled part needs its stop now (closePosition covers later fills too)
      if (Number(o.executedQty) > 0 && !t.slOrderId) return this.protect(t, rules)
      return null
    }
    if (t.status === 'open') {
      const p = await this.client.position(t.symbol)
      // open without a stop (e.g. crash between fill and SL): place it now
      if (p && !t.slOrderId) return this.protect(t, rules)
      if (p) return null
      // flat: SL or TP done (or closed by hand) → clean up the other leg and book the result
      await this.client.cancelAll(t.symbol)
      const r = await this.client.realised(t.symbol, (t.filledAt ?? t.createdAt) - 60_000)
      const exit = r.lastPrice
      const bull = t.direction === 'bullish'
      // stop fills slip past the SL, so classify by which side of the entry the exit was
      // a stop already moved to BE / into profit that fills nearer the stop than the TP is 'trail', not 'tp'
      const stopMoved = bull ? t.sl >= t.entry : t.sl <= t.entry
      const reason =
        exit === null
          ? 'external'
          : stopMoved && (t.tp === null || Math.abs(exit - t.sl) < Math.abs(exit - t.tp))
            ? 'trail'
            : (bull ? exit > t.entry : exit < t.entry)
              ? 'tp'
              : 'sl'
      return { status: 'closed', reason, closedAt: r.lastTime ?? Date.now(), exitPrice: exit, pnl: r.pnl }
    }
    return null
  }
}
