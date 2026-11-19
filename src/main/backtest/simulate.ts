import type { Candle } from '@shared/candles'
import { m6Exit, trendExit, type ExitConfig, type SmcConfig } from '@shared/config'
import type { Setup } from '@shared/smc'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import { ExitTracker, type ExitFees } from '../strategy/exit'
import { indexAtOrAfter } from '../strategy/setups'

/** One exit plan evaluated side by side in the backtest (docs/entry-v2.md §4). */
export interface ExitPlanDef extends Pick<ExitConfig, 'tpMode' | 'tpR' | 'ladder' | 'trailStepR' | 'trailGapR' | 'orderFlowHold' | 'orderFlowTf' | 'orderFlowSignals' | 'orderFlowWickRatio'>, Partial<Pick<ExitConfig, 'orderFlowMoveSl' | 'tightSlPct' | 'tightBeAtR' | 'tightBeLockR'>> {
  key: string
  label: string
}

const plain = (key: string, label: string, tpMode: ExitConfig['tpMode'], tpR: number): ExitPlanDef => ({
  key,
  label,
  tpMode,
  tpR,
  ladder: [],
  trailStepR: 0,
  trailGapR: 2,
  orderFlowHold: false,
  orderFlowTf: '15m',
  orderFlowSignals: ['fvg', 'wick'],
  orderFlowWickRatio: 0.5
})

/** Fixed-R targets, the old liquidity TP, and the user's tiered plan (with and without a final TP). */
export function defaultPlans(user: ExitConfig, smc?: Pick<SmcConfig, 'trendTrailGapR' | 'trendTrailStepR' | 'm6TrailGapR' | 'm6TrailStepR'>): ExitPlanDef[] {
  const tiered = { tpR: user.tpR, ladder: user.ladder, trailStepR: user.trailStepR, trailGapR: user.trailGapR, orderFlowTf: user.orderFlowTf, orderFlowSignals: user.orderFlowSignals, orderFlowWickRatio: user.orderFlowWickRatio, orderFlowMoveSl: user.orderFlowMoveSl, tightSlPct: user.tightSlPct, tightBeAtR: user.tightBeAtR, tightBeLockR: user.tightBeLockR }
  return [
    plain('r1', 'TP 1R', 'fixedR', 1),
    plain('r1.5', 'TP 1,5R', 'fixedR', 1.5),
    plain('r2', 'TP 2R', 'fixedR', 2),
    plain('r3', 'TP 3R', 'fixedR', 3),
    plain('liq', 'TP liquidity', 'liquidity', user.tpR),
    { ...tiered, key: 'ladder', label: 'Bertingkat + TP liquidity', tpMode: 'liquidity', orderFlowHold: false },
    { ...tiered, key: 'ladderOF', label: 'Bertingkat + order flow + TP liquidity', tpMode: 'liquidity', orderFlowHold: true },
    { ...tiered, key: 'ladderFvg', label: 'Bertingkat + order flow (FVG saja) + TP liquidity', tpMode: 'liquidity', orderFlowHold: true, orderFlowSignals: ['fvg'] },
    { ...tiered, key: 'ladderWick', label: 'Bertingkat + order flow (wick saja) + TP liquidity', tpMode: 'liquidity', orderFlowHold: true, orderFlowSignals: ['wick'] },
    { ...tiered, key: 'trail', label: 'Bertingkat, trailing tanpa TP', tpMode: 'trail', orderFlowHold: false },
    { ...tiered, key: 'trailOF', label: 'Bertingkat + order flow, tanpa TP', tpMode: 'trail', orderFlowHold: true },
    // M5's own exit (also run on the SMC models for comparison)
    ...(smc ? [{ ...trendExit(smc), key: 'trend', label: `Trailing trend (gap ${smc.trendTrailGapR}R, tanpa BE/TP)` }] : []),
    // M6's own exit (no TP: in the backtest the trailing stop is the only exit; by hand it may differ)
    ...(smc ? [{ ...plain('m6', '', 'trail', 50), ...m6Exit(smc), key: 'm6', label: `M6: trailing ${smc.m6TrailGapR}R, tanpa TP (TP manual)` }] : [])
  ]
}

export type SimStatus = 'win' | 'be' | 'loss' | 'open' | 'missed' | 'invalid' | 'expired' | 'pending'

export interface SimTrade {
  setup: Setup
  plan: string
  status: SimStatus
  filledT: number | null
  exitT: number | null
  /** Net R after fees (0 for no trade). */
  r: number
  mfeR: number
  /** |entry − SL| / entry. */
  slDist: number
}

/** |r| at or below this counts as break-even (the BE stop pays the fees, so ≈ 0). */
export const BE_R = 0.05

export interface SimInput {
  /** Entry-TF candles (the setup was detected on these). */
  entry: readonly Candle[]
  entryTf: Timeframe
  /** 1m candles for exact fill/exit order (sorted). Falls back to entry candles when absent. */
  minute?: readonly Candle[]
  fees: ExitFees
  /** Pending limits expire after N entry candles. */
  expiry: number
  /** Stop following an open trade after this long (it is then counted at the last close). */
  maxHoldMs?: number
  /** SL buffer for the order-flow stop, % of price. */
  slBufferPct?: number
}

/** Planned TP of a setup under a plan (null = no TP order). Pending limits are cancelled at it. */
export function planTp(s: Setup, p: ExitPlanDef): number | null {
  const risk = Math.abs(s.entry - s.sl)
  const bull = s.direction === 'bullish'
  const at = (r: number): number => (bull ? s.entry + r * risk : s.entry - r * risk)
  if (p.tpMode === 'fixedR') return at(p.tpR)
  if (p.tpMode === 'liquidity') return s.tpLiquidity ?? at(p.tpR)
  return null
}

/**
 * Follow one setup under one exit plan: pending limit on the entry TF (expiry, invalid close, cancel
 * when price reaches the TP — or the liquidity target for trail plans — before the fill), then the
 * fill and every exit on 1m bars through ExitTracker.
 */
export function simulateSetup(s: Setup, p: ExitPlanDef, o: SimInput): SimTrade {
  const bull = s.direction === 'bullish'
  const tp = planTp(s, p)
  const cancelAt = tp ?? s.tpLiquidity
  const base = { setup: s, plan: p.key, filledT: null, exitT: null, r: 0, mfeR: 0, slDist: Math.abs(s.entry - s.sl) / s.entry }
  const c = o.entry
  const tfMs = TF_MS[o.entryTf]
  const from = indexAtOrAfter(c, s.createdT)
  const reaches = (x: Candle, lvl: number | null): boolean => lvl !== null && (bull ? x.h >= lvl : x.l <= lvl)
  const touches = (x: Candle): boolean => (bull ? x.l <= s.entry : x.h >= s.entry)

  let fillBar = -1
  for (let m = from + 1; m < c.length; m++) {
    const x = c[m]!
    if (m - from > (s.expiryCandles ?? o.expiry)) return { ...base, status: 'expired', exitT: x.t }
    if (reaches(x, cancelAt) && !touches(x)) return { ...base, status: 'missed', exitT: x.t }
    if (touches(x)) {
      fillBar = m
      break
    }
    if (bull ? x.c < s.child.extreme : x.c > s.child.extreme) return { ...base, status: 'invalid', exitT: x.t }
  }
  if (fillBar < 0) return { ...base, status: 'pending' }

  // switch to 1m inside the fill candle
  const fine = o.minute && o.minute.length ? o.minute : null
  const bars = fine ?? c
  let i = fine ? indexAtOrAfter(fine, c[fillBar]!.t) : fillBar
  const fillEnd = c[fillBar]!.t + tfMs
  if (fine) {
    for (; i < fine.length && fine[i]!.t < fillEnd; i++) {
      const x = fine[i]!
      if (touches(x)) break
      if (reaches(x, cancelAt)) return { ...base, status: 'missed', exitT: x.t }
    }
    if (i >= fine.length || fine[i]!.t >= fillEnd) i = indexAtOrAfter(fine, c[fillBar]!.t) // gap in 1m data: fill at candle open
  }
  const filledT = bars[i]!.t
  const tr = new ExitTracker(s.direction, s.entry, s.sl, tp, p, o.fees, o.slBufferPct)
  tr.bar(bars[i]!, true)
  const stop = filledT + (o.maxHoldMs ?? 30 * 86_400_000)
  for (let m = i + 1; m < bars.length && !tr.done && bars[m]!.t < stop; m++) tr.bar(bars[m]!)
  const res = tr.result()
  if (!res.done) return { ...base, status: 'open', filledT, r: res.r, mfeR: res.mfeR }
  const status: SimStatus = res.r > BE_R ? 'win' : res.r < -BE_R ? 'loss' : 'be'
  return { ...base, status, filledT, exitT: res.exitT, r: res.r, mfeR: res.mfeR }
}

export interface PlanStats {
  trades: number
  wins: number
  be: number
  losses: number
  /** wins ÷ trades (BE counts as not a win). */
  winrate: number | null
  /** (wins + BE) ÷ trades: share of trades that did not lose. */
  noLossRate: number | null
  avgR: number | null
  totalR: number
  profitFactor: number | null
  maxDdR: number
}

export function planStats(trades: readonly SimTrade[]): PlanStats {
  const closed = trades.filter((t) => t.status === 'win' || t.status === 'loss' || t.status === 'be').sort((a, b) => a.exitT! - b.exitT!)
  let wins = 0
  let be = 0
  let total = 0
  let gw = 0
  let gl = 0
  let peak = 0
  let dd = 0
  for (const t of closed) {
    if (t.status === 'win') wins++
    else if (t.status === 'be') be++
    total += t.r
    if (t.r > 0) gw += t.r
    else gl -= t.r
    peak = Math.max(peak, total)
    dd = Math.max(dd, peak - total)
  }
  const n = closed.length
  return {
    trades: n,
    wins,
    be,
    losses: n - wins - be,
    winrate: n ? wins / n : null,
    noLossRate: n ? (wins + be) / n : null,
    avgR: n ? total / n : null,
    totalR: total,
    profitFactor: gl > 0 ? gw / gl : null,
    maxDdR: dd
  }
}
