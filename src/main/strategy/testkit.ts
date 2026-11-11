import type { Candle } from '@shared/candles'
import { smcConfigSchema, type SmcConfig } from '@shared/config'

export const T0 = Date.UTC(2026, 0, 5) // Monday
export const STEP = 15 * 60_000 // fixtures are analysed as 15m candles

/** Candles from [o, h, l, c] tuples, one 15m candle apart. */
export function bars(rows: [number, number, number, number][], start = T0): Candle[] {
  return rows.map(([o, h, l, c], i) => ({ t: start + i * STEP, o, h, l, c, v: 1 }))
}

/** Candles following a close-to-close path (each candle opens at the previous close). */
export function path(closes: number[], wick = 0.1, start = T0): Candle[] {
  const out: Candle[] = []
  for (let i = 1; i < closes.length; i++) {
    const o = closes[i - 1]!
    const c = closes[i]!
    out.push({ t: start + (i - 1) * STEP, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1 })
  }
  return out
}

export const cfg = (p: Partial<SmcConfig> = {}): SmcConfig => smcConfigSchema.parse({ pivot: 2, ...p })
export const at = (i: number): number => T0 + i * STEP
