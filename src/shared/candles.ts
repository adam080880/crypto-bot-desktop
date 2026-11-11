/** Compact OHLCV candle. `t` = open time (ms, UTC). */
export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** Derived (resampled) candle; `n` = number of source 1m candles it was built from. */
export interface DerivedCandle extends Candle {
  n: number
}
