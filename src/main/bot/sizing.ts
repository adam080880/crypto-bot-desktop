import type { Dir } from '@shared/smc'

/** Exchange filters of one symbol (Binance PRICE_FILTER / LOT_SIZE / MIN_NOTIONAL). */
export interface SymbolRules {
  tickSize: number
  stepSize: number
  minQty: number
  minNotional: number
}

export interface OrderPlan {
  entry: number
  sl: number
  tp: number
  qty: number
  notional: number
  /** Loss at the SL incl. estimated fees (USDT). */
  riskUsd: number
  /** Leverage to set so the margin fits (≤ maxLeverage). */
  leverage: number
}

/** Plain decimal string for the API (never exponent notation like 1e-7). */
export const fmtStep = (x: number, step: number): string => x.toFixed(decimals(step))

const decimals = (step: number): number => {
  const s = step.toString()
  if (s.includes('e-')) return Number(s.split('e-')[1])
  return s.includes('.') ? s.split('.')[1]!.length : 0
}
/** Round to a multiple of `step` (floor/ceil/nearest) without float noise. */
export function roundStep(x: number, step: number, mode: 'floor' | 'ceil' | 'round'): number {
  const n = x / step
  const k = mode === 'floor' ? Math.floor(n + 1e-9) : mode === 'ceil' ? Math.ceil(n - 1e-9) : Math.round(n)
  return Number((k * step).toFixed(decimals(step)))
}

/**
 * Risk-based position size. Prices are rounded to the tick conservatively (SL further away, TP
 * closer), qty is rounded down. Notional is capped at equity × maxLeverage. Returns a reason
 * string instead of a plan when the order can't be placed within the rules.
 */
export function planOrder(p: {
  direction: Dir
  entry: number
  sl: number
  tp: number
  equity: number
  riskPct: number
  maxLeverage: number
  rules: SymbolRules
  /** Fees for the planned loss: maker entry + taker stop + slippage, % of notional. */
  feePct: number
}): OrderPlan | string {
  const bull = p.direction === 'bullish'
  const r = p.rules
  const entry = roundStep(p.entry, r.tickSize, 'round')
  const sl = roundStep(p.sl, r.tickSize, bull ? 'floor' : 'ceil')
  const tp = roundStep(p.tp, r.tickSize, bull ? 'floor' : 'ceil')
  if (bull ? !(sl < entry && entry < tp) : !(tp < entry && entry < sl)) return 'level SL/entry/TP tidak valid setelah dibulatkan ke tick'
  if (!(p.equity > 0)) return 'equity 0'
  const dist = Math.abs(entry - sl)
  const budget = p.equity * (p.riskPct / 100)
  // loss per unit at the SL including fees on both legs
  const lossPerUnit = dist + (entry + sl) * (p.feePct / 100)
  let qty = budget / lossPerUnit
  const maxNotional = p.equity * p.maxLeverage
  if (qty * entry > maxNotional) qty = maxNotional / entry
  qty = roundStep(qty, r.stepSize, 'floor')
  const notional = qty * entry
  if (qty < r.minQty || notional < r.minNotional) {
    const need = Math.max(r.minNotional / entry, r.minQty)
    const needRisk = (need * lossPerUnit) / p.equity
    return `ukuran ${notional.toFixed(2)} USDT di bawah minimal order ${r.minNotional} USDT (butuh risk ≈ ${(needRisk * 100).toFixed(2)}% atau modal lebih besar)`
  }
  const leverage = Math.min(p.maxLeverage, Math.max(1, Math.ceil(notional / p.equity)))
  return { entry, sl, tp, qty, notional, riskUsd: qty * lossPerUnit, leverage }
}
