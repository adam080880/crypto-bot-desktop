import type { Impact } from '@shared/news'
import type { Observation } from '../actuals'

/** One event as delivered by a calendar provider (already validated + cleaned). */
export interface RawCalendarEvent {
  title: string
  currency: string
  impact: Impact
  time: number
  forecastRaw: string | null
  previousRaw: string | null
  actualRaw: string | null
}

/**
 * Calendar provider. Implementations must use public/permitted endpoints only.
 * (investing.com and forexfactory.com pages answer 403 to automated clients — not used.)
 */
export interface CalendarSource {
  readonly id: 'ff'
  fetchEvents(signal?: AbortSignal): Promise<RawCalendarEvent[]>
}

/** Official statistics provider for actual values. */
export interface SeriesSource {
  readonly id: 'bls' | 'fred'
  fetchSeries(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, Observation[]>>
}
