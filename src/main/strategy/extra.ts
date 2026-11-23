import type { Candle } from '@shared/candles'
import type { Dir } from '@shared/smc'

/**
 * More ICT / crypto "philosophy" as numbers, for testing before they become tags (user 2026-11-23, internet research):
 * OTE depth, Power of 3 / Judas swing (Asian range), position vs the daily / weekly open, CVD divergence at the POI.
 * Pure and causal: only entry-TF candles closed by `known`. `c` = entry-TF candles (15m), with taker buy volume (bv)
 * where available.
 */
export interface ExtraFeatures {
  /** Entry depth in the impulse leg that made the parent POI (0 = at the leg's end, 1 = back at its origin extreme); null = unknown. */
  oteDepth: number | null
  /** 1 = setup known before the Asian range closed (00–07 UTC), the Judas flags are then 0. */
  inAsia: number
  /** Power of 3: after the Asian range closed, the side AGAINST the trade was swept first (long: Asian low taken). */
  judas: number
  /** The side IN the trade direction of the Asian range was taken (long: Asian high taken: chasing). */
  asiaWith: number
  /** (open − entry) / entry × 100, signed so positive = entry on the cheap side (long below the open, short above). */
  dayOpenPos: number | null
  weekOpenPos: number | null
  /** Last 8 vs previous 8 candles: price made a new extreme against the trade but cumulative delta did not. */
  cvdDiv: number
  /** Net taker delta of the last 8 candles ÷ their volume, signed with the trade (+ = flow already with the trade). */
  cvdBias: number | null
  /** UTC weekday of `known` (0 = Sunday). */
  dow: number
}

const M15 = 15 * 60_000
const DAY = 86_400_000
const ASIA_END = 7 * 3_600_000

function lastClosed(c: readonly Candle[], known: number, tfMs: number): number {
  let lo = 0
  let hi = c.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (c[m]!.t + tfMs <= known) lo = m + 1
    else hi = m
  }
  return lo - 1
}

function firstAtOrAfter(c: readonly Candle[], t: number): number {
  let lo = 0
  let hi = c.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (c[m]!.t < t) lo = m + 1
    else hi = m
  }
  return lo
}

export function extraFeatures(o: {
  c: readonly Candle[]
  dir: Dir
  entry: number
  known: number
  /** Parent POI's origin extreme and the open time of its origin candle (the impulse leg starts there). */
  poiExtreme?: number
  originT?: number
  tfMs?: number
}): ExtraFeatures {
  const { c, dir, entry, known } = o
  const tfMs = o.tfMs ?? M15
  const bull = dir === 'bullish'
  const k = lastClosed(c, known, tfMs)
  const out: ExtraFeatures = { oteDepth: null, inAsia: 0, judas: 0, asiaWith: 0, dayOpenPos: null, weekOpenPos: null, cvdDiv: 0, cvdBias: null, dow: new Date(known).getUTCDay() }
  if (k < 0) return out

  // OTE: depth of the entry in the leg from the POI's origin extreme to the leg's best price since then
  if (o.poiExtreme !== undefined && o.originT !== undefined) {
    const a = firstAtOrAfter(c, o.originT)
    if (a <= k) {
      let far = bull ? -Infinity : Infinity
      for (let m = a; m <= k; m++) far = bull ? Math.max(far, c[m]!.h) : Math.min(far, c[m]!.l)
      const range = Math.abs(far - o.poiExtreme)
      if (range > 0) out.oteDepth = (bull ? far - entry : entry - far) / range
    }
  }

  // Power of 3: Asian range (00–07 UTC) of the day of `known`
  const day = Math.floor(known / DAY) * DAY
  if (known < day + ASIA_END) out.inAsia = 1
  else {
    const a = firstAtOrAfter(c, day)
    const b = firstAtOrAfter(c, day + ASIA_END)
    if (b > a) {
      let hi = -Infinity
      let lo = Infinity
      for (let m = a; m < b; m++) {
        hi = Math.max(hi, c[m]!.h)
        lo = Math.min(lo, c[m]!.l)
      }
      let tookHi = false
      let tookLo = false
      for (let m = b; m <= k; m++) {
        if (c[m]!.h > hi) tookHi = true
        if (c[m]!.l < lo) tookLo = true
      }
      out.judas = (bull ? tookLo : tookHi) ? 1 : 0
      out.asiaWith = (bull ? tookHi : tookLo) ? 1 : 0
    }
  }

  // daily / weekly open (UTC; week = Monday 00:00)
  const sign = bull ? 1 : -1
  const dOpen = c[firstAtOrAfter(c, day)]
  if (dOpen && dOpen.t === day) out.dayOpenPos = (sign * (dOpen.o - entry) / entry) * 100
  const week = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY
  const wOpen = c[firstAtOrAfter(c, week)]
  if (wOpen && wOpen.t === week) out.weekOpenPos = (sign * (wOpen.o - entry) / entry) * 100

  // CVD divergence: last 8 vs previous 8 closed candles (delta = taker buy − taker sell = 2·bv − v)
  if (k >= 15) {
    let cum = 0
    let ok = true
    const cv: number[] = []
    for (let m = k - 15; m <= k; m++) {
      const bv = c[m]!.bv
      if (bv === undefined || bv === null) {
        ok = false
        break
      }
      cum += 2 * bv - c[m]!.v
      cv.push(cum)
    }
    if (ok) {
      const px = (from: number, to: number, f: 'l' | 'h'): number => {
        let v = f === 'l' ? Infinity : -Infinity
        for (let m = k - 15 + from; m <= k - 15 + to; m++) v = f === 'l' ? Math.min(v, c[m]!.l) : Math.max(v, c[m]!.h)
        return v
      }
      const cvExt = (from: number, to: number, min: boolean): number => (min ? Math.min(...cv.slice(from, to + 1)) : Math.max(...cv.slice(from, to + 1)))
      if (bull) out.cvdDiv = px(8, 15, 'l') < px(0, 7, 'l') && cvExt(8, 15, true) > cvExt(0, 7, true) ? 1 : 0
      else out.cvdDiv = px(8, 15, 'h') > px(0, 7, 'h') && cvExt(8, 15, false) < cvExt(0, 7, false) ? 1 : 0
      let d = 0
      let v = 0
      for (let m = k - 7; m <= k; m++) {
        d += 2 * (c[m]!.bv as number) - c[m]!.v
        v += c[m]!.v
      }
      out.cvdBias = v > 0 ? (sign * d) / v : null
    }
  }
  return out
}
