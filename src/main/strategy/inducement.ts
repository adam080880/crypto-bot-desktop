import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { SmcAnalysisFull } from './analyze'
import type { Poi } from './setups'

/**
 * Inducement (docs/smc-rules.md §11, own research 2026-11-23, outside the course material).
 *
 *  - bait (user's definition): a same-direction POI WITHOUT origin (no sweep, no HTF tap) sitting in front of a POI B
 *    (price meets it first), touched on the way within `baitDays` before → B, the POI behind it, is the real one.
 *  - strict IDM: the first internal pullback (ltfPivot swing) of the leg that left B, on B's own timeframe, swept
 *    before the decision time. A POI touched without such a pullback is itself the first pullback (= the inducement).
 *  - extreme POI: no other active same-direction POI (≥ 1h) behind B within `windowAtr` ATR (the last line of the leg).
 *  - decisional POI: a strict IDM exists and no active same-direction POI (≥ 1h) sits between B and the IDM.
 */
export interface InducementCfg {
  baitDays: number
  /** Window in front of / behind B, in ATR of B's timeframe. */
  windowAtr: number
}

export interface PoiInducement {
  /** Time (ms) the latest bait touch became known (candle close), null = no bait. */
  baitT: number | null
  idm: boolean
  extreme: boolean
  decisional: boolean
}

const RANK: Record<Timeframe, number> = { '1m': 0, '5m': 1, '15m': 2, '1h': 3, '4h': 4, '1d': 5, '1w': 6 }
const closeTime = (t: number, tf: Timeframe): number => t + TF_MS[tf]

function lowerBound(c: readonly { t: number }[], t: number): number {
  let lo = 0
  let hi = c.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (c[m]!.t < t) lo = m + 1
    else hi = m
  }
  return lo
}

/**
 * Per-symbol helper (one detectSetups call): first touch of every POI on the entry candles (lazy, cached) and the
 * POIs by direction sorted by level, so the window around a POI is a binary search.
 */
export class InducementIndex {
  private readonly touchIdx = new Map<Poi, number>()
  private readonly byDir: Record<'bullish' | 'bearish', Poi[]> = { bullish: [], bearish: [] }
  private readonly levels: Record<'bullish' | 'bearish', { t: number }[]> = { bullish: [], bearish: [] }

  constructor(
    private readonly entry: SmcAnalysisFull,
    private readonly all: readonly SmcAnalysisFull[],
    pois: readonly Poi[],
    private readonly cfg: InducementCfg
  ) {
    for (const p of pois) this.byDir[p.direction].push(p)
    for (const k of ['bullish', 'bearish'] as const) {
      this.byDir[k].sort((a, b) => a.level - b.level)
      this.levels[k] = this.byDir[k].map((x) => ({ t: x.level }))
    }
  }

  /** Index of the first entry candle touching the POI line while it is valid (−1 = none). */
  touch(p: Poi): number {
    const hit = this.touchIdx.get(p)
    if (hit !== undefined) return hit
    const c = this.entry.candles
    const bull = p.direction === 'bullish'
    let out = -1
    for (let m = lowerBound(c, p.activeFrom); m < c.length; m++) {
      if (p.invalidT !== null && c[m]!.t >= closeTime(p.invalidT, p.timeframe)) break
      if (bull ? c[m]!.l <= p.level : c[m]!.h >= p.level) {
        out = m
        break
      }
    }
    this.touchIdx.set(p, out)
    return out
  }

  /** ATR of B's timeframe at time `at` (last closed candle), NaN when unknown. */
  atrAt(b: Poi, at: number): number {
    const a = this.all.find((x) => x.timeframe === b.timeframe)
    if (!a) return NaN
    const k = lowerBound(a.candles, at - TF_MS[b.timeframe] + 1) - 1
    return k >= 0 ? (a.atr[k] ?? NaN) : NaN
  }

  /** Same-direction POIs with the level within [lo, hi]. */
  private window(dir: 'bullish' | 'bearish', lo: number, hi: number): Poi[] {
    const list = this.byDir[dir]
    const out: Poi[] = []
    for (let q = lowerBound(this.levels[dir], lo); q < list.length && list[q]!.level <= hi; q++) out.push(list[q]!)
    return out
  }

  /** Bait touches (close times of the touching entry candle) in front of B, sorted. Ignores the time window. */
  baitTouches(b: Poi): number[] {
    const bull = b.direction === 'bullish'
    const A = this.atrAt(b, b.activeFrom)
    if (!(A > 0)) return []
    const w = this.cfg.windowAtr * A
    const out: number[] = []
    for (const a of this.window(b.direction, bull ? b.level : b.level - w, bull ? b.level + w : b.level)) {
      if (a === b || a.origin !== null || a.level === b.level) continue
      const i = this.touch(a)
      if (i < 0) continue
      const t = this.entry.candles[i]!.t
      if (t < b.activeFrom || a.activeFrom > t) continue
      out.push(closeTime(t, this.entry.timeframe))
    }
    return out.sort((x, y) => x - y)
  }

  /** Inducement context of POI B at decision time `at` (only what is known by then). */
  at(b: Poi, at: number): PoiInducement {
    const bull = b.direction === 'bullish'
    const days = this.cfg.baitDays * 86_400_000
    let baitT: number | null = null
    for (const t of this.baitTouches(b)) if (t <= at && t >= at - days) baitT = t

    // strict IDM: first ltfPivot swing of B's TF after B, beyond B's line, known and swept by `at`
    let idmPrice: number | null = null
    const a = this.all.find((x) => x.timeframe === b.timeframe)
    if (a) {
      const ca = a.candles
      for (const pv of a.ltfPivots) {
        if (pv.kind !== (bull ? 'low' : 'high') || ca[pv.i]!.t <= b.t) continue
        const knownT = closeTime(ca[pv.confirmedAt]!.t, b.timeframe)
        if (knownT > at) break
        if (bull ? pv.price > b.level : pv.price < b.level) {
          // swept: an entry candle traded through it after it was known, closed by `at`
          const c = this.entry.candles
          for (let m = lowerBound(c, knownT); m < c.length && closeTime(c[m]!.t, this.entry.timeframe) <= at; m++)
            if (bull ? c[m]!.l < pv.price : c[m]!.h > pv.price) {
              idmPrice = pv.price
              break
            }
          break
        }
      }
    }

    // extreme / decisional among active same-direction POIs ≥ 1h
    const A = this.atrAt(b, at)
    let extreme = false
    let decisional = false
    if (A > 0) {
      const w = this.cfg.windowAtr * A
      const active = (o: Poi): boolean =>
        o !== b && RANK[o.timeframe] >= RANK['1h'] && o.activeFrom <= at && (o.invalidT === null || closeTime(o.invalidT, o.timeframe) > at)
      extreme = !this.window(b.direction, bull ? b.level - w : b.level, bull ? b.level : b.level + w).some((o) => active(o) && o.level !== b.level)
      if (idmPrice !== null) {
        const lo = bull ? b.level : idmPrice
        const hi = bull ? idmPrice : b.level
        decisional = !this.window(b.direction, lo, hi).some((o) => active(o) && o.level !== b.level && o.level !== idmPrice)
      }
    }
    return { baitT, idm: idmPrice !== null, extreme, decisional }
  }

  /** The POI object behind a setup's POI reference (null for models whose POI is not a collected POI). */
  find(ref: { kind: string; timeframe: Timeframe; t: number; level: number }, dir: 'bullish' | 'bearish'): Poi | null {
    for (const p of this.window(dir, ref.level, ref.level)) if (p.kind === ref.kind && p.timeframe === ref.timeframe && p.t === ref.t) return p
    return null
  }
}
