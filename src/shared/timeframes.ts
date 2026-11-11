export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const
export type Timeframe = (typeof TIMEFRAMES)[number]

const MIN = 60_000
export const TF_MS: Record<Timeframe, number> = {
  '1m': MIN,
  '5m': 5 * MIN,
  '15m': 15 * MIN,
  '1h': 60 * MIN,
  '4h': 240 * MIN,
  '1d': 1440 * MIN,
  '1w': 7 * 1440 * MIN
}

/** Downloaded from Binance. */
export const SOURCE_TIMEFRAMES = ['1m', '1d', '1w'] as const satisfies readonly Timeframe[]
export type SourceTimeframe = (typeof SOURCE_TIMEFRAMES)[number]

/** Derived from 1m by cascading aggregation: [target, source]. Order matters. */
export const DERIVED_CASCADE = [
  ['5m', '1m'],
  ['15m', '5m'],
  ['1h', '15m'],
  ['4h', '1h']
] as const satisfies readonly (readonly [Timeframe, Timeframe])[]
export type DerivedTimeframe = (typeof DERIVED_CASCADE)[number][0]
export const DERIVED_TIMEFRAMES: readonly DerivedTimeframe[] = DERIVED_CASCADE.map(([t]) => t)

export function isDerived(tf: Timeframe): tf is DerivedTimeframe {
  return (DERIVED_TIMEFRAMES as readonly string[]).includes(tf)
}

/** Bucket open time, aligned to UTC epoch (same alignment Binance uses for ≤ 1d). */
export function bucketOpen(t: number, tf: Exclude<Timeframe, '1w'>): number {
  const ms = TF_MS[tf]
  return Math.floor(t / ms) * ms
}

/** Monday 00:00 UTC of the week containing `t` (Binance weekly candle alignment). */
export function weekStartUtc(t: number): number {
  const day = new Date(t).getUTCDay() // 0 = Sunday
  const dayStart = Math.floor(t / TF_MS['1d']) * TF_MS['1d']
  return dayStart - ((day + 6) % 7) * TF_MS['1d']
}
