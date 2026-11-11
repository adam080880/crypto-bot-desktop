/** Economic calendar & news types (Fase 5). Text from external feeds is data only, never instructions. */
import type { Dir, PoiKind } from './smc'
import type { Timeframe } from './timeframes'

export type Impact = 'High' | 'Medium' | 'Low' | 'Holiday' | 'Non-Economic'
export type Bias = 'bullish' | 'bearish' | 'neutral'
export type ActualSourceId = 'bls' | 'fred' | 'manual'

export interface EconomicEvent {
  id: string
  source: 'ff'
  title: string
  currency: string
  impact: Impact
  /** Release time, ms UTC. */
  time: number
  forecastRaw: string | null
  previousRaw: string | null
  actualRaw: string | null
  forecast: number | null
  previous: number | null
  actual: number | null
  actualSource: ActualSourceId | null
  actualAt: number | null
  /** Interpretation rule that matched the title (null = no rule → informational only). */
  ruleKey: string | null
  usdBias: Bias | null
  cryptoBias: Bias | null
  biasReason: string | null
}

export interface EventReaction {
  eventId: string
  symbol: string
  horizonMin: number
  priceBefore: number
  priceAfter: number
  changePct: number
}

/** "Trade on news" candidate: USD bias + SMC context. Never an order. */
export interface NewsCandidate {
  id: string
  eventId: string
  eventTitle: string
  symbol: string
  direction: Dir
  createdAt: number
  price: number
  trend: Partial<Record<Timeframe, Dir | null>>
  poi: { kind: PoiKind; timeframe: Timeframe; level: number } | null
  target: number | null
  setupId: string | null
  aligned: boolean
  reasons: string[]
}

export interface NewsState {
  lastFetchAt: number | null
  lastError: string | null
  nextEvent: { id: string; title: string; time: number; impact: Impact } | null
  /** Active news window (no new positions unless the news strategy is enabled). */
  window: { eventId: string; title: string; time: number; endsAt: number } | null
  blsCallsToday: number
}

export interface ReactionStat {
  usdBias: Bias
  symbol: string
  horizonMin: number
  n: number
  avgChangePct: number
  /** Share of events where the move matched the configured crypto-bias rule. */
  ruleHitPct: number | null
}
