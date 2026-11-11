import type { Candle } from '@shared/candles'

export const bodyHi = (k: Candle): number => Math.max(k.o, k.c)
export const bodyLo = (k: Candle): number => Math.min(k.o, k.c)
export const upWick = (k: Candle): number => k.h - bodyHi(k)
export const loWick = (k: Candle): number => bodyLo(k) - k.l
export const isGreen = (k: Candle): boolean => k.c > k.o
export const isRed = (k: Candle): boolean => k.c < k.o
export const range = (k: Candle): number => k.h - k.l
/** Body as share of the full range (0 for a zero-range candle). */
export const bodyRatio = (k: Candle): number => (range(k) > 0 ? Math.abs(k.c - k.o) / range(k) : 0)
