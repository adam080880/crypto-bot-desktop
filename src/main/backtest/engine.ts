import type {
  BacktestParams,
  BreakdownKey,
  EquitySim,
  GroupRow,
  PeriodKey,
  ReactionRow,
  SetupFunnel,
  TradeStats
} from '@shared/backtest'
import type { Candle } from '@shared/candles'
import type { Setup } from '@shared/smc'
import { indexAtOrAfter, type Poi } from '../strategy/setups'

export const RACE_PCTS = [0.5, 1, 2] as const

type Fees = Pick<BacktestParams, 'makerFeePct' | 'takerFeePct' | 'slippagePct'>

/** A filled setup that reached SL or TP, with its net result in R. */
export interface Trade {
  setup: Setup
  filledT: number
  exitT: number
  /** Net R after fees and slippage (risk = |entry − SL|). */
  r: number
  /** |entry − SL| as a fraction of entry (for position sizing). */
  slDist: number
}

/**
 * Net R of a closed setup. Entry and TP are limit orders (maker); the SL is a stop-market order
 * (taker) that also slips `slippagePct` against us.
 */
export function netR(s: Setup, fees: Fees): number {
  const risk = Math.abs(s.entry - s.sl)
  const maker = fees.makerFeePct / 100
  const entryFee = maker * s.entry
  if (s.status === 'win') return (Math.abs(s.tp - s.entry) - entryFee - maker * s.tp) / risk
  return -(risk + (fees.slippagePct / 100) * s.sl + entryFee + (fees.takerFeePct / 100) * s.sl) / risk
}

export function toTrades(setups: readonly Setup[], fees: Fees): Trade[] {
  return setups
    .filter((s) => (s.status === 'win' || s.status === 'loss') && s.filledT !== null && s.statusT !== null)
    .map((s) => ({ setup: s, filledT: s.filledT!, exitT: s.statusT!, r: netR(s, fees), slDist: Math.abs(s.entry - s.sl) / s.entry }))
    .sort((a, b) => a.exitT - b.exitT || a.filledT - b.filledT)
}

export function tradeStats(trades: readonly Trade[]): TradeStats {
  let wins = 0
  let totalR = 0
  let grossWin = 0
  let grossLoss = 0
  let peak = 0
  let maxDdR = 0
  let rrSum = 0
  for (const t of [...trades].sort((a, b) => a.exitT - b.exitT)) {
    if (t.setup.status === 'win') wins++
    totalR += t.r
    if (t.r > 0) grossWin += t.r
    else grossLoss -= t.r
    peak = Math.max(peak, totalR)
    maxDdR = Math.max(maxDdR, peak - totalR)
    rrSum += t.setup.rr
  }
  const n = trades.length
  return {
    trades: n,
    wins,
    winrate: n ? wins / n : null,
    avgR: n ? totalR / n : null,
    totalR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDdR,
    avgRr: n ? rrSum / n : null
  }
}

export function funnel(setups: readonly Setup[]): SetupFunnel {
  const f: SetupFunnel = { setups: setups.length, win: 0, loss: 0, open: 0, pending: 0, missed: 0, invalid: 0, expired: 0 }
  for (const s of setups) {
    if (s.status === 'triggered') f.open++
    else f[s.status]++
  }
  return f
}

/** Period of a setup by the time it became known. */
export const periodOf = (createdT: number, splitT: number): Exclude<PeriodKey, 'all'> => (createdT < splitT ? 'is' : 'oos')

export function byPeriod<T>(items: readonly T[], time: (x: T) => number, splitT: number): Record<PeriodKey, T[]> {
  const out: Record<PeriodKey, T[]> = { all: [...items], is: [], oos: [] }
  for (const x of items) out[periodOf(time(x), splitT)].push(x)
  return out
}

const GROUPERS: Record<BreakdownKey, (s: Setup) => string> = {
  poiKind: (s) => s.poi.kind,
  poiTf: (s) => s.poi.timeframe,
  score: (s) => String(s.score),
  fvg: (s) => (s.obValid.hasFvg ? 'dengan FVG' : 'tanpa FVG'),
  direction: (s) => (s.direction === 'bullish' ? 'long' : 'short')
}

export function breakdown(trades: readonly Trade[], splitT: number): Record<BreakdownKey, GroupRow[]> {
  const out = {} as Record<BreakdownKey, GroupRow[]>
  for (const key of Object.keys(GROUPERS) as BreakdownKey[]) {
    const groups = new Map<string, Trade[]>()
    for (const t of trades) {
      const k = GROUPERS[key](t.setup)
      groups.set(k, [...(groups.get(k) ?? []), t])
    }
    out[key] = [...groups.entries()]
      .map(([k, list]) => {
        const p = byPeriod(list, (t) => t.setup.createdT, splitT)
        return { key: k, stats: { all: tradeStats(p.all), is: tradeStats(p.is), oos: tradeStats(p.oos) } }
      })
      .sort((a, b) => (key === 'score' ? Number(b.key) - Number(a.key) : b.stats.all.trades - a.stats.all.trades))
  }
  return out
}

/**
 * Bot-like equity run: risk `riskPct` of current equity per trade (size = risk ÷ SL distance),
 * notional capped at `maxLeverage` × equity, one open position per symbol, and no new entries for
 * the rest of the UTC day once realised loss that day reaches `maxDailyLossPct`.
 */
export function simulateEquity(
  trades: readonly Trade[],
  o: { startEquity: number; riskPct: number; maxLeverage: number; maxDailyLossPct: number }
): EquitySim {
  const byFill = [...trades].sort((a, b) => a.filledT - b.filledT || a.exitT - b.exitT)
  let equity = o.startEquity
  let peak = equity
  let maxDdPct = 0
  let openUntil = -Infinity
  let taken = 0
  let skippedOpen = 0
  let skippedHalt = 0
  let leverageCapped = 0
  let streak = 0
  let maxLosingStreak = 0
  // realised PnL per UTC day, against the equity at that day's first event
  const dayStart = new Map<number, number>()
  const dayPnl = new Map<number, number>()
  const curve: { t: number; equity: number }[] = [{ t: byFill[0]?.filledT ?? 0, equity }]
  const dayOf = (t: number): number => Math.floor(t / 86_400_000)

  for (const t of byFill) {
    // only one position on the symbol at a time; the next fill must come after the exit candle
    if (t.filledT <= openUntil) {
      skippedOpen++
      continue
    }
    const d = dayOf(t.filledT)
    if (!dayStart.has(d)) dayStart.set(d, equity)
    if ((dayPnl.get(d) ?? 0) <= -dayStart.get(d)! * (o.maxDailyLossPct / 100)) {
      skippedHalt++
      continue
    }
    const riskAmt = equity * (o.riskPct / 100)
    const notional = riskAmt / t.slDist
    let scale = 1
    if (notional > equity * o.maxLeverage) {
      scale = (equity * o.maxLeverage) / notional
      leverageCapped++
    }
    const pnl = riskAmt * scale * t.r
    const e = dayOf(t.exitT)
    if (!dayStart.has(e)) dayStart.set(e, equity)
    dayPnl.set(e, (dayPnl.get(e) ?? 0) + pnl)
    equity += pnl
    taken++
    openUntil = t.exitT
    streak = pnl < 0 ? streak + 1 : 0
    maxLosingStreak = Math.max(maxLosingStreak, streak)
    peak = Math.max(peak, equity)
    maxDdPct = Math.max(maxDdPct, ((peak - equity) / peak) * 100)
    curve.push({ t: t.exitT, equity })
  }
  return {
    startEquity: o.startEquity,
    endEquity: equity,
    returnPct: ((equity - o.startEquity) / o.startEquity) * 100,
    maxDdPct,
    riskPerTradePct: o.riskPct,
    taken,
    skippedOpen,
    skippedHalt,
    leverageCapped,
    maxLosingStreak,
    curve: downsample(curve, 600)
  }
}

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs
  const step = (xs.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => xs[Math.round(i * step)]!)
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export interface PoiTouch {
  poi: Poi
  touchT: number
  /** 'win' | 'loss' | 'timeout' per RACE_PCTS entry. */
  race: ('win' | 'loss' | 'timeout')[]
  invalidated: boolean
  mfePct: number
  maePct: number
}

/**
 * How price reacts at a POI, independent of the OB valid entry. From the first touch (on the
 * entry TF, while the POI is active) price races from the POI level: +X% in the POI direction vs
 * −X% through it. Within one candle the adverse side counts first (conservative), and the touch
 * candle can only lose (its favourable move may have come before the touch).
 */
export function poiTouch(poi: Poi, c: readonly Candle[], windowMs: number): PoiTouch | null {
  const bull = poi.direction === 'bullish'
  let i = indexAtOrAfter(c, poi.activeFrom)
  for (; i < c.length; i++) {
    if (poi.invalidT !== null && c[i]!.t >= poi.invalidT) return null
    if (bull ? c[i]!.l <= poi.level : c[i]!.h >= poi.level) break
  }
  if (i >= c.length) return null
  const touchT = c[i]!.t
  const end = touchT + windowMs
  const L = poi.level
  const adverse = (x: Candle): number => (bull ? (L - x.l) / L : (x.h - L) / L) * 100
  const favourable = (x: Candle): number => (bull ? (x.h - L) / L : (L - x.l) / L) * 100
  const race: PoiTouch['race'] = RACE_PCTS.map(() => 'timeout')
  let mae = Math.max(0, adverse(c[i]!))
  let mfe = 0
  RACE_PCTS.forEach((p, k) => {
    if (mae >= p) race[k] = 'loss'
  })
  for (let m = i + 1; m < c.length && c[m]!.t < end; m++) {
    const a = adverse(c[m]!)
    const f = favourable(c[m]!)
    RACE_PCTS.forEach((p, k) => {
      if (race[k] !== 'timeout') return
      if (a >= p) race[k] = 'loss'
      else if (f >= p) race[k] = 'win'
    })
    mae = Math.max(mae, a)
    mfe = Math.max(mfe, f)
  }
  const invalidated = poi.invalidT !== null && poi.invalidT < end
  return { poi, touchT, race, invalidated, mfePct: mfe, maePct: mae }
}

export function reactionRows(pois: readonly Poi[], touches: readonly PoiTouch[]): ReactionRow[] {
  const key = (p: Poi): string => `${p.kind}|${p.timeframe}`
  const rows = new Map<string, ReactionRow & { mfe: number[]; mae: number[] }>()
  const row = (p: Poi) => {
    let r = rows.get(key(p))
    if (!r) {
      r = {
        kind: p.kind,
        timeframe: p.timeframe,
        pois: 0,
        touches: 0,
        race: RACE_PCTS.map((pct) => ({ pct, win: 0, loss: 0, timeout: 0 })),
        invalidated: 0,
        medianMfePct: null,
        medianMaePct: null,
        mfe: [],
        mae: []
      }
      rows.set(key(p), r)
    }
    return r
  }
  for (const p of pois) row(p).pois++
  for (const t of touches) {
    const r = row(t.poi)
    r.touches++
    t.race.forEach((o, k) => r.race[k]![o]++)
    if (t.invalidated) r.invalidated++
    r.mfe.push(t.mfePct)
    r.mae.push(t.maePct)
  }
  const TF = { '1m': 0, '5m': 1, '15m': 2, '1h': 3, '4h': 4, '1d': 5, '1w': 6 }
  return [...rows.values()]
    .map(({ mfe, mae, ...r }) => ({ ...r, medianMfePct: median(mfe), medianMaePct: median(mae) }))
    .sort((a, b) => TF[b.timeframe] - TF[a.timeframe] || b.touches - a.touches)
}
