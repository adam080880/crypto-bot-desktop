import type { Candle } from '@shared/candles'
import type { SmcConfig } from '@shared/config'
import type { OrderBlock } from '@shared/smc'
import { bodyHi, bodyLo, bodyRatio, isGreen, isRed, loWick, upWick } from './candle'
import type { FvgIdx } from './fvg'
import type { Pivot } from './swings'

export interface OrderBlockIdx extends OrderBlock {
  i: number
  confirmedAt: number
}

type ObCfg = Pick<SmcConfig, 'obMoveCandles' | 'minBodyRatio' | 'fvgMaxOffset'>

/**
 * §3 Order Block, from the candle's shape:
 *  bullish = swing-low candle, GREEN, lower wick longer than the previous candle's lower wick AND
 *            reaching lower than it, followed within `obMoveCandles` by a close above its high.
 *  bearish = mirror (swing-high, RED, longer/higher upper wick, close below its low).
 * Entry line at the body edge; the wick beyond it is leftover liquidity.
 */
export function detectOrderBlocks(
  c: readonly Candle[],
  pivots: readonly Pivot[],
  fvgs: readonly FvgIdx[],
  cfg: ObCfg
): OrderBlockIdx[] {
  const out: OrderBlockIdx[] = []
  for (const p of pivots) {
    const i = p.i
    if (i < 1) continue
    const k = c[i]!
    const prev = c[i - 1]!
    if (bodyRatio(k) < cfg.minBodyRatio) continue
    const bullish = p.kind === 'low'
    const shapeOk = bullish
      ? isGreen(k) && loWick(k) > loWick(prev) && k.l < prev.l
      : isRed(k) && upWick(k) > upWick(prev) && k.h > prev.h
    if (!shapeOk) continue

    let moveAt = -1
    for (let m = i + 1; m <= i + cfg.obMoveCandles && m < c.length; m++) {
      if (bullish ? c[m]!.c > k.h : c[m]!.c < k.l) {
        moveAt = m
        break
      }
    }
    if (moveAt < 0) continue
    const confirmedAt = Math.max(p.confirmedAt, moveAt)
    if (confirmedAt >= c.length) continue

    const dir = bullish ? 'bullish' : 'bearish'
    const ob: OrderBlockIdx = {
      i,
      t: k.t,
      direction: dir,
      line: bullish ? bodyLo(k) : bodyHi(k),
      wickEnd: bullish ? k.l : k.h,
      bodyFar: bullish ? bodyHi(k) : bodyLo(k),
      hasFvg: fvgs.some((f) => f.direction === dir && f.i >= i && f.i <= i + cfg.fvgMaxOffset),
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
