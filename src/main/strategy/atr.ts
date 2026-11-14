import type { Candle } from '@shared/candles'

/**
 * Wilder ATR. `out[i]` uses candles 0..i only (no look-ahead). Before `period` candles exist it is
 * the running mean of the true ranges so far.
 */
export function atrSeries(c: readonly Candle[], period: number): number[] {
  const out = new Array<number>(c.length)
  let atr = 0
  for (let i = 0; i < c.length; i++) {
    const k = c[i]!
    const prevC = i > 0 ? c[i - 1]!.c : k.c
    const tr = Math.max(k.h - k.l, Math.abs(k.h - prevC), Math.abs(k.l - prevC))
    atr = i < period ? (atr * i + tr) / (i + 1) : (atr * (period - 1) + tr) / period
    out[i] = atr
  }
  return out
}

/** EMA of the closes (seeded with the first close). `out[i]` uses candles 0..i only. */
export function emaSeries(c: readonly Candle[], period: number): number[] {
  const out = new Array<number>(c.length)
  const k = 2 / (period + 1)
  for (let i = 0; i < c.length; i++) out[i] = i ? out[i - 1]! + k * (c[i]!.c - out[i - 1]!) : c[i]!.c
  return out
}
