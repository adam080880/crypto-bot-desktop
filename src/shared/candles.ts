/** Compact OHLCV candle. `t` = open time (ms, UTC). */
export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
  /** Taker buy volume (base asset). null = not downloaded yet (rows stored before migration 0007). */
  bv?: number | null
  /** Number of trades. null = not downloaded yet. */
  nt?: number | null
}

/** Derived (resampled) candle; `n` = number of source 1m candles it was built from. */
export interface DerivedCandle extends Candle {
  n: number
}
