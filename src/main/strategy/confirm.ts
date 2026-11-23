import type { Candle } from '@shared/candles'
import type { Dir } from '@shared/smc'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { FvgIdx } from './fvg'

/**
 * Confirmation tags from own research (docs/smc-rules.md §11, user 2026-11-23: CISD, SMT, IFVG). Pure, no repaint:
 * every event carries the close time of the candle that made it known.
 */

const closeT = (t: number, tf: Timeframe): number => t + TF_MS[tf]

/** Close times of the events per new direction, ascending. */
interface Events {
  bullish: number[]
  bearish: number[]
}

const anyIn = (ts: readonly number[], from: number, to: number): boolean => {
  let lo = 0
  let hi = ts.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (ts[m]! <= from) lo = m + 1
    else hi = m
  }
  return lo < ts.length && ts[lo]! <= to
}

const cisdCache = new WeakMap<readonly Candle[], Events>()

/**
 * CISD (change in state of delivery): a close beyond the open of the first candle of the last run of opposite candles.
 * Bullish = close above the open of the first candle of the latest bearish run (the run that delivered price down);
 * bearish mirrored. Each run counts once.
 */
export function cisdEvents(c: readonly Candle[], tf: Timeframe): Events {
  const hit = cisdCache.get(c)
  if (hit) return hit
  const ev: Events = { bullish: [], bearish: [] }
  let bearOpen: number | null = null // open of the first candle of the latest bearish run
  let bullOpen: number | null = null
  for (let k = 0; k < c.length; k++) {
    const x = c[k]!
    const prev = k > 0 ? c[k - 1]! : null
    if (x.c < x.o) {
      if (!prev || !(prev.c < prev.o)) bearOpen = x.o
    } else if (x.c > x.o) {
      if (!prev || !(prev.c > prev.o)) bullOpen = x.o
    }
    if (bearOpen !== null && x.c > bearOpen && !(x.c < x.o)) {
      ev.bullish.push(closeT(x.t, tf))
      bearOpen = null
    }
    if (bullOpen !== null && x.c < bullOpen && !(x.c > x.o)) {
      ev.bearish.push(closeT(x.t, tf))
      bullOpen = null
    }
  }
  cisdCache.set(c, ev)
  return ev
}

const ifvgCache = new WeakMap<readonly FvgIdx[], Events>()
const IFVG_MAX_AGE = 96

/**
 * Inverse FVG: an FVG closed through (body close beyond its far side) flips. A bearish FVG closed above = bullish IFVG,
 * a bullish FVG closed below = bearish IFVG. Checked up to IFVG_MAX_AGE candles after the FVG formed.
 */
export function ifvgEvents(c: readonly Candle[], fvgs: readonly FvgIdx[], tf: Timeframe): Events {
  const hit = ifvgCache.get(fvgs)
  if (hit) return hit
  const ev: Events = { bullish: [], bearish: [] }
  for (const f of fvgs) {
    for (let m = f.i + 3; m < c.length && m <= f.i + 2 + IFVG_MAX_AGE; m++) {
      const x = c[m]!
      if (f.direction === 'bearish' ? x.c > f.top : x.c < f.bottom) {
        ;(f.direction === 'bearish' ? ev.bullish : ev.bearish).push(closeT(x.t, tf))
        break
      }
    }
  }
  ev.bullish.sort((a, b) => a - b)
  ev.bearish.sort((a, b) => a - b)
  ifvgCache.set(fvgs, ev)
  return ev
}

/** A same-direction CISD / IFVG closed within (from, to]. */
export const cisdIn = (c: readonly Candle[], tf: Timeframe, dir: Dir, from: number, to: number): boolean => anyIn(cisdEvents(c, tf)[dir], from, to)
export const ifvgIn = (c: readonly Candle[], fvgs: readonly FvgIdx[], tf: Timeframe, dir: Dir, from: number, to: number): boolean =>
  anyIn(ifvgEvents(c, fvgs, tf)[dir], from, to)

/** First index with t ≥ x. */
function atOrAfter(c: readonly Candle[], x: number): number {
  let lo = 0
  let hi = c.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (c[m]!.t < x) lo = m + 1
    else hi = m
  }
  return lo
}

/**
 * SMT divergence at `at` between the coin and a correlated reference (BTC for alts, ETH for BTC), both on the same TF:
 * in the last `win` closed candles exactly one of the two took out the extreme of the `range` candles before
 * (bullish: lows, bearish: highs). Either way round counts (one swept, the other held).
 */
export function smtAt(coin: readonly Candle[], ref: readonly Candle[], tf: Timeframe, dir: Dir, at: number, win: number, range: number): boolean {
  const k = atOrAfter(coin, at - TF_MS[tf] + 1) - 1 // last coin candle closed by `at`
  if (k < win + range - 1) return false
  const t0 = coin[k - win - range + 1]!.t
  const tw = coin[k - win + 1]!.t
  const tEnd = coin[k]!.t
  const swept = (c: readonly Candle[]): boolean | null => {
    const a = atOrAfter(c, t0)
    const b = atOrAfter(c, tw)
    const e = atOrAfter(c, tEnd + 1)
    if (b - a < range * 0.8 || e - b < win * 0.8) return null // gaps in the data → no verdict
    let p = dir === 'bullish' ? Infinity : -Infinity
    for (let i = a; i < b; i++) p = dir === 'bullish' ? Math.min(p, c[i]!.l) : Math.max(p, c[i]!.h)
    for (let i = b; i < e; i++) if (dir === 'bullish' ? c[i]!.l < p : c[i]!.h > p) return true
    return false
  }
  const sc = swept(coin)
  const sr = swept(ref)
  return sc !== null && sr !== null && sc !== sr
}
