/** Pump radar alert (docs/entry-v2.md §12). Notify only, the bot never trades it. */
export interface RadarHit {
  symbol: string
  /** Open time of the 1h candle that triggered (closed). */
  t: number
  /** vol = 24h volume ≥ volMult × 30-day median · funding = negative funding + volume ≥ fundingVolMult. */
  reasons: ('vol' | 'funding')[]
  /** 24h quote volume ÷ median of the previous 30 daily windows. */
  volRatio: number
  /** Last funding rate (fraction per settlement), null when not synced. */
  funding: number | null
  /** Close change over the last 24h (fraction). */
  ret24: number
  price: number
}

export interface RadarState {
  lastRunAt: number | null
  scanned: number
  /** Recent hits, newest first (kept ~7 days). */
  hits: RadarHit[]
}
