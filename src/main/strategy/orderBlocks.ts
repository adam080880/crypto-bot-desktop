import type { Candle } from '@shared/candles'
import type { SmcConfig } from '@shared/config'
import type { OrderBlock } from '@shared/smc'
import { bodyHi, bodyLo, bodyRatio, isGreen, isRed, loWick, upWick } from './candle'
import type { FvgIdx } from './fvg'
import type { Pivot } from './swings'

export interface OrderBlockIdx extends OrderBlock {
  i: number
  confirmedAt: number
  /** Index of the candle whose close completes the OB's FVG (null = none). `hasFvg` is only known from here on. */
  fvgKnownAt: number | null
}

type ObCfg = Pick<SmcConfig, 'obMoveCandles' | 'minBodyRatio' | 'fvgMaxOffset' | 'pivot'> & Partial<Pick<SmcConfig, 'obConfirm' | 'obSwingLength'>>

/** Does the OB already have its FVG at candle index `idx` (no look-ahead)? */
export function obFvgAt(ob: OrderBlockIdx, idx: number): boolean {
  return ob.fvgKnownAt !== null && ob.fvgKnownAt <= idx
}

/** Candle i's low (bull) / high (bear) is strictly beyond the k candles on its left (left half of a pivot). */
function leftExtreme(c: readonly Candle[], i: number, k: number, bull: boolean): boolean {
  if (i < k) return false
  for (let j = i - k; j < i; j++) if (bull ? c[j]!.l <= c[i]!.l : c[j]!.h >= c[i]!.h) return false
  return true
}

/**
 * LuxAlgo ICT Concepts OB candidates. swings(len): bar k = t-len is a swing high when its high beats the len candles after it
 * (highs/lows alternate). The first close above the latest swing high → the candle with the lowest body bottom between the
 * swing and the break (oldest on ties) is a bullish OB, known at the break candle's close. Bearish mirrored.
 */
function luxCandidates(c: readonly Candle[], len: number): { i: number; bullish: boolean; confirmedAt: number }[] {
  const out: { i: number; bullish: boolean; confirmedAt: number }[] = []
  let os = 0
  let top: { y: number; x: number; crossed: boolean } | null = null
  let btm: { y: number; x: number; crossed: boolean } | null = null
  for (let t = 0; t < c.length; t++) {
    if (t >= len) {
      const k = t - len
      let upper = -Infinity, lower = Infinity
      for (let j = k + 1; j <= t; j++) { upper = Math.max(upper, c[j]!.h); lower = Math.min(lower, c[j]!.l) }
      const prev = os
      os = c[k]!.h > upper ? 0 : c[k]!.l < lower ? 1 : os
      if (os === 0 && prev !== 0) top = { y: c[k]!.h, x: k, crossed: false }
      if (os === 1 && prev !== 1) btm = { y: c[k]!.l, x: k, crossed: false }
    }
    const cl = c[t]!.c
    if (top && !top.crossed && cl > top.y) {
      top.crossed = true
      let j = t - 1
      for (let m = t - 1; m > top.x; m--) if (bodyLo(c[m]!) <= bodyLo(c[j]!)) j = m
      out.push({ i: j, bullish: true, confirmedAt: t })
    }
    if (btm && !btm.crossed && cl < btm.y) {
      btm.crossed = true
      let j = t - 1
      for (let m = t - 1; m > btm.x; m--) if (bodyHi(c[m]!) >= bodyHi(c[j]!)) j = m
      out.push({ i: j, bullish: false, confirmedAt: t })
    }
  }
  return out
}

/**
 * §3 Order Block, from the candle's shape:
 *  bullish = GREEN candle whose lower wick is longer than the previous candle's lower wick AND reaches lower than it,
 *            and whose low is the lowest of the `pivot` candles on its left.
 *  bearish = mirror (RED, longer/higher upper wick, highest high on the left).
 * obConfirm 'move' (default): full swing pivot (right side too) + a close beyond its extreme within `obMoveCandles`.
 * obConfirm 'close' (tried 2026-11-25, reverted): fresh as soon as the candle closes.
 * obConfirm 'lux': LuxAlgo structure rule, see `detectLuxOrderBlocks`.
 * Entry line at the body edge; the wick beyond it is leftover liquidity.
 */
export function detectOrderBlocks(
  c: readonly Candle[],
  pivots: readonly Pivot[],
  fvgs: readonly FvgIdx[],
  cfg: ObCfg
): OrderBlockIdx[] {
  const out: OrderBlockIdx[] = []
  if (cfg.obConfirm === 'lux') return detectLuxOrderBlocks(c, fvgs, cfg)
  const atClose = (cfg.obConfirm ?? 'close') === 'close'
  const cands: { i: number; bullish: boolean; pivotAt: number }[] = []
  if (atClose) {
    for (let i = 1; i < c.length; i++) {
      if (leftExtreme(c, i, cfg.pivot, true)) cands.push({ i, bullish: true, pivotAt: i })
      if (leftExtreme(c, i, cfg.pivot, false)) cands.push({ i, bullish: false, pivotAt: i })
    }
  } else {
    for (const p of pivots) cands.push({ i: p.i, bullish: p.kind === 'low', pivotAt: p.confirmedAt })
  }
  for (const { i, bullish, pivotAt } of cands) {
    if (i < 1) continue
    const k = c[i]!
    const prev = c[i - 1]!
    if (bodyRatio(k) < cfg.minBodyRatio) continue
    const shapeOk = bullish
      ? isGreen(k) && loWick(k) > loWick(prev) && k.l < prev.l
      : isRed(k) && upWick(k) > upWick(prev) && k.h > prev.h
    if (!shapeOk) continue

    let confirmedAt = i
    if (!atClose) {
      let moveAt = -1
      for (let m = i + 1; m <= i + cfg.obMoveCandles && m < c.length; m++) {
        if (bullish ? c[m]!.c > k.h : c[m]!.c < k.l) {
          moveAt = m
          break
        }
      }
      if (moveAt < 0) continue
      confirmedAt = Math.max(pivotAt, moveAt)
      if (confirmedAt >= c.length) continue
    }

    const dir = bullish ? 'bullish' : 'bearish'
    // FVG = candles f.i, f.i+1, f.i+2 → complete at the close of f.i+2
    const fvg = fvgs.find((f) => f.direction === dir && f.i >= i && f.i <= i + cfg.fvgMaxOffset)
    const ob: OrderBlockIdx = {
      i,
      t: k.t,
      direction: dir,
      line: bullish ? bodyLo(k) : bodyHi(k),
      wickEnd: bullish ? k.l : k.h,
      bodyFar: bullish ? bodyHi(k) : bodyLo(k),
      hasFvg: !!fvg,
      fvgKnownAt: fvg ? fvg.i + 2 : null,
      prevOpposite: bullish ? isRed(prev) : isGreen(prev),
      confirmedAt,
      confirmedT: c[confirmedAt]!.t,
      hitT: null,
      invalidT: null,
      sweptT: null
    }
    for (let m = confirmedAt + 1; m < c.length; m++) {
      const x = c[m]!
      if (bullish) {
        if (ob.hitT === null && x.l <= ob.line) ob.hitT = x.t
        if (ob.sweptT === null && x.l < ob.wickEnd) ob.sweptT = x.t
        if (x.c < ob.wickEnd) {
          ob.invalidT = x.t
          break
        }
      } else {
        if (ob.hitT === null && x.h >= ob.line) ob.hitT = x.t
        if (ob.sweptT === null && x.h > ob.wickEnd) ob.sweptT = x.t
        if (x.c > ob.wickEnd) {
          ob.invalidT = x.t
          break
        }
      }
    }
    out.push(ob)
  }
  return out
}

/** obConfirm 'lux': box = OB candle body; line = body top (bull) / bottom (bear); SL side keeps the wick; breaker = body beyond the box. */
function detectLuxOrderBlocks(c: readonly Candle[], fvgs: readonly FvgIdx[], cfg: ObCfg): OrderBlockIdx[] {
  const out: OrderBlockIdx[] = []
  for (const { i, bullish, confirmedAt } of luxCandidates(c, cfg.obSwingLength ?? 10)) {
    if (i < 1) continue
    const k = c[i]!
    const prev = c[i - 1]!
    const dir = bullish ? 'bullish' : 'bearish'
    const fvg = fvgs.find((f) => f.direction === dir && f.i >= i && f.i <= i + cfg.fvgMaxOffset)
    const ob: OrderBlockIdx = {
      i,
      t: k.t,
      direction: dir,
      line: bullish ? bodyHi(k) : bodyLo(k),
      wickEnd: bullish ? k.l : k.h,
      bodyFar: bullish ? bodyLo(k) : bodyHi(k),
      hasFvg: !!fvg,
      fvgKnownAt: fvg ? fvg.i + 2 : null,
      prevOpposite: bullish ? isRed(prev) : isGreen(prev),
      confirmedAt,
      confirmedT: c[confirmedAt]!.t,
      hitT: null,
      invalidT: null,
      sweptT: null
    }
    for (let m = confirmedAt + 1; m < c.length; m++) {
      const x = c[m]!
      if (bullish) {
        if (ob.hitT === null && x.l <= ob.line) ob.hitT = x.t
        if (ob.sweptT === null && x.l < ob.wickEnd) ob.sweptT = x.t
        if (bodyLo(x) < ob.bodyFar) { ob.invalidT = x.t; break }
      } else {
        if (ob.hitT === null && x.h >= ob.line) ob.hitT = x.t
        if (ob.sweptT === null && x.h > ob.wickEnd) ob.sweptT = x.t
        if (bodyHi(x) > ob.bodyFar) { ob.invalidT = x.t; break }
      }
    }
    out.push(ob)
  }
  return out
}
