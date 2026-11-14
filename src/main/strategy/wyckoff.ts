import type { Candle } from '@shared/candles'
import type { Dir, WyckoffPhase, WyckoffRange } from '@shared/smc'
import { TF_MS, type Timeframe } from '@shared/timeframes'

export interface WyckoffCfg {
  /** Candles in the window that defines a trading range. */
  rangeCandles: number
  /** Range height ≤ rangeAtr × ATR measured just before the window. */
  rangeAtr: number
  /** A close outside the range that comes back inside within N candles = manipulation, not breakout. */
  reclaimCandles: number
}

/**
 * Wyckoff trading ranges (indicator; used for score only, docs/entry-v2.md §3).
 *  - Range: the last `rangeCandles` candles fit in `rangeAtr` × ATR (ATR from before the window).
 *    Kind from where price came from: above the range → accumulation, below → distribution.
 *  - Manipulation: spring = wick/close below the range that is reclaimed (close back inside within
 *    `reclaimCandles`); UTAD mirrors it above. Boundaries are NOT widened by manipulations.
 *  - Breakout: closes stay outside for more than `reclaimCandles` candles → range ends (markup/markdown).
 * Walks candles in order; every event time is the close of the candle that confirmed it.
 */
export function detectWyckoff(c: readonly Candle[], tf: Timeframe, atr: readonly number[], cfg: WyckoffCfg): WyckoffRange[] {
  const N = cfg.rangeCandles
  const close = (i: number): number => c[i]!.t + TF_MS[tf]
  const out: WyckoffRange[] = []
  let cur: WyckoffRange | null = null
  let out0: { dir: Dir; idx: number; extreme: number } | null = null

  for (let j = N; j < c.length; j++) {
    const x = c[j]!
    if (!cur) {
      let hi = -Infinity
      let lo = Infinity
      for (let m = j - N + 1; m <= j; m++) {
        hi = Math.max(hi, c[m]!.h)
        lo = Math.min(lo, c[m]!.l)
      }
      const ref = atr[j - N]!
      if (ref > 0 && hi - lo <= cfg.rangeAtr * ref) {
        const pre = c[Math.max(0, j - 2 * N)]!.c
        cur = {
          startT: c[j - N + 1]!.t,
          knownT: close(j),
          endT: null,
          top: hi,
          bottom: lo,
          kind: pre > hi ? 'accumulation' : pre < lo ? 'distribution' : 'range',
          manipulations: [],
          breakout: null
        }
        out.push(cur)
        out0 = null
      }
      continue
    }

    const above = x.c > cur.top
    const below = x.c < cur.bottom
    if (above || below) {
      const dir: Dir = above ? 'bullish' : 'bearish'
      if (!out0 || out0.dir !== dir) out0 = { dir, idx: j, extreme: above ? x.h : x.l }
      else out0.extreme = above ? Math.max(out0.extreme, x.h) : Math.min(out0.extreme, x.l)
      if (j - out0.idx >= cfg.reclaimCandles) {
        cur.breakout = { t: close(j), direction: dir }
        cur.endT = close(j)
        cur = null
        out0 = null
      }
      continue
    }
    // closed inside
    if (out0) {
      cur.manipulations.push({ t: close(j), kind: out0.dir === 'bearish' ? 'spring' : 'utad', price: out0.extreme })
      out0 = null
    } else if (x.l < cur.bottom) cur.manipulations.push({ t: close(j), kind: 'spring', price: x.l })
    else if (x.h > cur.top) cur.manipulations.push({ t: close(j), kind: 'utad', price: x.h })
  }
  return out
}

export interface WyckoffState {
  phase: WyckoffPhase
  /** Direction the phase favours (null = neutral range). */
  dir: Dir | null
  manipulation: 'spring' | 'utad' | null
}

/** Phase as known at time `t` (no look-ahead): the latest range known by then. */
export function wyckoffAt(ranges: readonly WyckoffRange[], t: number): WyckoffState | null {
  let r: WyckoffRange | null = null
  for (const x of ranges) {
    if (x.knownT > t) break
    r = x
  }
  if (!r) return null
  if (r.breakout && r.breakout.t <= t)
    return { phase: r.breakout.direction === 'bullish' ? 'markup' : 'markdown', dir: r.breakout.direction, manipulation: null }
  const m = r.manipulations.filter((x) => x.t <= t).at(-1)
  if (m) return { phase: 'manipulation', dir: m.kind === 'spring' ? 'bullish' : 'bearish', manipulation: m.kind }
  if (r.kind === 'accumulation') return { phase: 'accumulation', dir: 'bullish', manipulation: null }
  if (r.kind === 'distribution') return { phase: 'distribution', dir: 'bearish', manipulation: null }
  return { phase: 'range', dir: null, manipulation: null }
}
