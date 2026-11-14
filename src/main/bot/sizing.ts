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
  tp: number | null
  qty: number
  notional: number
  /** Loss at the SL incl. estimated fees (USDT). */
  riskUsd: number
  /** Leverage to set so the margin fits (≤ maxLeverage). */
  leverage: number
}

/** One Binance leverage bracket (GET /fapi/v1/leverageBracket). */
export interface LeverageBracket {
  initialLeverage: number
  notionalFloor: number
  notionalCap: number
  maintMarginRatio: number
}

/** Liquidation must sit at least this many SL distances away from the entry. */
export const LIQ_BUFFER = 1.5

/**
 * Highest leverage that is still safe: capped by the config (`cap`) and the symbol's bracket for this
 * notional, and low enough that the isolated liquidation price stays beyond the SL.
 * Isolated liquidation ≈ entry × (1 ∓ (1/L − mmr)), so we need 1/L − mmr ≥ LIQ_BUFFER × SL distance
 * (+ fees). Margin = notional ÷ L; the loss at the SL does not depend on L (risk sizing).
 * Returns a reason string when even the minimum leverage needed for the margin isn't safe.
 */
export function pickLeverage(p: {
  entry: number
  sl: number
  notional: number
  equity: number
  cap: number
  brackets: LeverageBracket[]
  feePct: number
}): { leverage: number; liqDistPct: number; marginUsd: number } | string {
  const b = p.brackets.find((x) => p.notional >= x.notionalFloor && p.notional < x.notionalCap) ?? p.brackets[0]
  const bracketMax = b?.initialLeverage ?? p.cap
  const mmr = b?.maintMarginRatio ?? 0.01
  const d = Math.abs(p.entry - p.sl) / p.entry
  const safe = Math.floor(1 / (mmr + LIQ_BUFFER * d + p.feePct / 100))
  const lev = Math.max(1, Math.min(p.cap, bracketMax, safe))
  // margin must fit in the equity
  const need = Math.max(1, Math.ceil(p.notional / p.equity))
  if (lev < need) return `leverage aman maks ${lev}× (likuidasi harus lewat SL), tapi margin butuh ≥ ${need}×`
  return { leverage: lev, liqDistPct: (1 / lev - mmr) * 100, marginUsd: p.notional / lev }
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
  /** null = no TP order (trailing only). */
  tp: number | null
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
  const tp = p.tp === null ? null : roundStep(p.tp, r.tickSize, bull ? 'floor' : 'ceil')
  const far = tp ?? (bull ? Infinity : -Infinity)
  if (bull ? !(sl < entry && entry < far) : !(far < entry && entry < sl)) return 'level SL/entry/TP tidak valid setelah dibulatkan ke tick'
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
