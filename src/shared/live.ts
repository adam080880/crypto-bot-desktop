import type { Candle } from './candles'

export type LiveStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'delayed'

export interface LiveState {
  status: LiveStatus
  streams: number
  connections: number
  /** Worst observed event latency (exchange event time → received), ms. */
  latencyMs: number | null
}

/** Forming candles for one symbol, keyed by timeframe (1m…4h). */
export interface LiveCandleEvent {
  symbol: string
  /** Exchange event time. */
  eventTime: number
  /** True when the 1m candle just closed. */
  closed: boolean
  candles: Partial<Record<'1m' | '3m' | '5m' | '10m' | '15m' | '45m' | '1h' | '2h' | '3h' | '4h', Candle>>
}
