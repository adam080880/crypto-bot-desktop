import type { RotationConfig, RotationPosition, RotationRankRow, RotationRebalance, RotationState } from '@shared/rotation'

const DAY = 86_400_000

/** Daily closes of one coin keyed by UTC day index (open time ÷ 1 day). */
export interface CoinDaily {
  symbol: string
  /** First day with data (listing). */
  firstDay: number
  close: ReadonlyMap<number, number>
  /** Quote volume per day (USDT). */
  qv: ReadonlyMap<number, number>
}

/**
 * Point-in-time ranking (no survivorship look-ahead): among coins listed ≥ minAgeDays before `day`
 * with a close on `day`, take the `universe` most traded over the 30 days before it, then sort by
 * the return over lookbackDays. `day` = the last CLOSED daily candle (index).
 */
export function rankUniverse(coins: readonly CoinDaily[], day: number, cfg: Pick<RotationConfig, 'lookbackDays' | 'universe' | 'minAgeDays'>): RotationRankRow[] {
  const cand: RotationRankRow[] = []
  for (const c of coins) {
    if (c.firstDay > day - cfg.minAgeDays) continue
    const now = c.close.get(day)
    const then = c.close.get(day - cfg.lookbackDays)
    if (now === undefined || then === undefined || !(then > 0)) continue
    let volume = 0
    for (let d = day - 30; d < day; d++) volume += c.qv.get(d) ?? 0
    cand.push({ symbol: c.symbol, ret: now / then - 1, volume })
  }
  return cand
    .sort((a, b) => b.volume - a.volume)
    .slice(0, cfg.universe)
    .sort((a, b) => b.ret - a.ret)
}

/** Targets from a ranking: equal weight, half the equity per side when long/short. */
export function targets(rows: readonly RotationRankRow[], cfg: Pick<RotationConfig, 'perSide' | 'longShort'>): Map<string, number> {
  const w = new Map<string, number>()
  const n = Math.min(cfg.perSide, Math.floor(rows.length / (cfg.longShort ? 2 : 1)))
  if (n <= 0) return w
  const each = cfg.longShort ? 1 / (2 * n) : 1 / n
  for (const r of rows.slice(0, n)) w.set(r.symbol, each)
  if (cfg.longShort) for (const r of rows.slice(-n)) w.set(r.symbol, -each)
  return w
}

export const emptyState = (config: RotationState['config']): RotationState => ({
  config,
  running: false,
  startedAt: null,
  equity: config.startEquity,
  peak: config.startEquity,
  maxDdPct: 0,
  positions: [],
  curve: [],
  rebalances: [],
  ranking: null,
  lastDay: null,
  nextRebalanceAt: null,
  lastError: null
})

/**
 * Mark open positions to `price` (close of the day just processed) and book funding settlements
 * (long pays a positive rate, short receives it). Returns the new state (pure).
 */
export function mark(s: RotationState, day: number, price: (symbol: string) => number | undefined, funding: (symbol: string) => number, btc: number | null): RotationState {
  let equity = s.equity
  const positions: RotationPosition[] = s.positions.map((p) => {
    const px = price(p.symbol) ?? p.lastPrice // no new close (e.g. delisted): keep the last one
    // funding: sum of rates since the last mark × notional; qty > 0 (long) pays a positive rate
    const fee = -funding(p.symbol) * p.qty * p.lastPrice
    equity += p.qty * (px - p.lastPrice) + fee
    return { ...p, lastPrice: px, funding: p.funding + fee }
  })
  const peak = Math.max(s.peak, equity)
  const t = day * DAY
  return {
    ...s,
    equity,
    peak,
    maxDdPct: Math.max(s.maxDdPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0),
    positions,
    curve: [...s.curve.filter((x) => x.t !== t), { t, equity, btc }],
    lastDay: day
  }
}

/** Rebalance to `w` at `price` (same close as the mark). Costs on the traded notional (pure). */
export function rebalance(s: RotationState, day: number, w: ReadonlyMap<string, number>, price: (symbol: string) => number | undefined): RotationState {
  const cur = new Map(s.positions.map((p) => [p.symbol, p.qty * p.lastPrice]))
  const want = new Map<string, number>()
  for (const [sym, x] of w) if (price(sym)) want.set(sym, x * s.equity)
  let traded = 0
  for (const sym of new Set([...cur.keys(), ...want.keys()])) traded += Math.abs((want.get(sym) ?? 0) - (cur.get(sym) ?? 0))
  const cost = traded * (s.config.costPct / 100)
  const old = new Map(s.positions.map((p) => [p.symbol, p]))
  const positions: RotationPosition[] = [...want].map(([symbol, notional]) => {
    const px = price(symbol)!
    const prev = old.get(symbol)
    const same = prev && Math.sign(prev.qty) === Math.sign(notional)
    return {
      symbol,
      side: notional > 0 ? 'long' : 'short',
      qty: notional / px,
      entryPrice: same ? prev.entryPrice : px,
      lastPrice: px,
      funding: same ? prev.funding : 0
    }
  })
  const equity = s.equity - cost
  const reb: RotationRebalance = {
    t: day * DAY,
    equity,
    longs: positions.filter((p) => p.qty > 0).map((p) => p.symbol),
    shorts: positions.filter((p) => p.qty < 0).map((p) => p.symbol),
    turnover: s.equity > 0 ? traded / s.equity : 0,
    cost
  }
  return { ...s, equity, positions, rebalances: [...s.rebalances, reb].slice(-200) }
}

/** Next rebalance moment (00:30 UTC on the configured weekday) after `now`. */
export function nextRebalanceAt(now: number, weekday: number): number {
  const d = new Date(now)
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 30)
  for (let k = 0; k < 8; k++) {
    const t = base + k * DAY
    if (t > now && new Date(t).getUTCDay() === weekday) return t
  }
  return base + 7 * DAY
}
