import type { Candle } from '@shared/candles'
import type { Dir, StructureBreak, Swing } from '@shared/smc'

export interface Pivot {
  i: number
  kind: 'high' | 'low'
  price: number
  /** Index of the candle on which the pivot is known (i + k). */
  confirmedAt: number
}

/**
 * Raw pivots (§1): candle i is a swing high if its high beats the k candles on its left (strictly)
 * and is not exceeded by the k candles on its right. Mirror for lows.
 */
export function findPivots(c: readonly Candle[], k: number): Pivot[] {
  const out: Pivot[] = []
  for (let i = k; i < c.length - k; i++) {
    let hi = true
    let lo = true
    for (let j = i - k; j <= i + k && (hi || lo); j++) {
      if (j === i) continue
      const left = j < i
      if (left ? c[j]!.h >= c[i]!.h : c[j]!.h > c[i]!.h) hi = false
      if (left ? c[j]!.l <= c[i]!.l : c[j]!.l < c[i]!.l) lo = false
    }
    if (hi) out.push({ i, kind: 'high', price: c[i]!.h, confirmedAt: i + k })
    if (lo) out.push({ i, kind: 'low', price: c[i]!.l, confirmedAt: i + k })
  }
  return out
}

/**
 * Keeps swings strictly alternating high/low. A new pivot of the same kind as the last one replaces
 * it only if more extreme. Applied incrementally in confirmation order, so it never looks ahead.
 */
export class AlternatingSwings {
  readonly list: Pivot[] = []

  push(p: Pivot): void {
    const last = this.list[this.list.length - 1]
    if (last && last.kind === p.kind) {
      const better = p.kind === 'high' ? p.price > last.price : p.price < last.price
      if (better) this.list[this.list.length - 1] = p
      return
    }
    this.list.push(p)
  }

  lastOf(kind: 'high' | 'low'): Pivot | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.kind === kind) return this.list[i]
    return undefined
  }
}

export interface StructureResult {
  swings: Swing[]
  alternating: Pivot[]
  breaks: StructureBreak[]
  trend: Dir | null
  /** Trend per candle index (null before the first structure break). */
  trendAt: (Dir | null)[]
  trendChanges: { t: number; trend: Dir }[]
}

/**
 * §1–§2. Walks candles in order. A close above the latest swing high makes the trend bullish
 * (a reversal from bearish = BOS bullish); a close below the latest swing low makes it bearish.
 * Breaks need a close (Q2) and do not require an LH/HL first (Q3). Each swing breaks once.
 */
export function analyzeStructure(c: readonly Candle[], pivots: readonly Pivot[]): StructureResult {
  const byConfirm = new Map<number, Pivot[]>()
  for (const p of pivots) {
    const arr = byConfirm.get(p.confirmedAt) ?? []
    arr.push(p)
    byConfirm.set(p.confirmedAt, arr)
  }
  const alt = new AlternatingSwings()
  const broken = new Set<number>()
  const breaks: StructureBreak[] = []
  const trendAt: (Dir | null)[] = new Array(c.length).fill(null)
  const trendChanges: { t: number; trend: Dir }[] = []
  let trend: Dir | null = null

  for (let j = 0; j < c.length; j++) {
    for (const p of byConfirm.get(j) ?? []) alt.push(p)
    const close = c[j]!.c
    const hi = alt.lastOf('high')
    if (hi && !broken.has(hi.i) && close > hi.price) {
      broken.add(hi.i)
      if (trend === 'bearish') breaks.push({ t: c[j]!.t, direction: 'bullish', level: hi.price, swingT: c[hi.i]!.t })
      if (trend !== 'bullish') trendChanges.push({ t: c[j]!.t, trend: 'bullish' })
      trend = 'bullish'
    }
    const lo = alt.lastOf('low')
    if (lo && !broken.has(lo.i) && close < lo.price) {
      broken.add(lo.i)
      if (trend === 'bullish') breaks.push({ t: c[j]!.t, direction: 'bearish', level: lo.price, swingT: c[lo.i]!.t })
      if (trend !== 'bearish') trendChanges.push({ t: c[j]!.t, trend: 'bearish' })
      trend = 'bearish'
    }
    trendAt[j] = trend
  }

  // Label each alternating swing against the previous swing of the same kind.
  const swings: Swing[] = []
  let prevHigh: number | null = null
  let prevLow: number | null = null
  for (const p of alt.list) {
    let label: Swing['label'] = null
    if (p.kind === 'high') {
      if (prevHigh !== null) label = p.price > prevHigh ? 'HH' : 'LH'
      prevHigh = p.price
    } else {
      if (prevLow !== null) label = p.price > prevLow ? 'HL' : 'LL'
      prevLow = p.price
    }
    swings.push({ t: c[p.i]!.t, kind: p.kind, price: p.price, label, confirmedT: c[p.confirmedAt]!.t })
  }
  return { swings, alternating: alt.list, breaks, trend, trendAt, trendChanges }
}
