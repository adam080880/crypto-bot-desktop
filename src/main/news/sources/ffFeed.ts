import { z } from 'zod'
import { HttpError, timeoutSignal } from '../../exchange/http'
import { cleanText } from '../parse'
import type { CalendarSource, RawCalendarEvent } from './types'

/** ForexFactory's public weekly calendar export (JSON). Refreshed hourly upstream; poll gently. */
export const FF_FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'

const itemSchema = z.object({
  title: z.string(),
  country: z.string(),
  date: z.string(),
  impact: z.string(),
  forecast: z.string().optional().nullable(),
  previous: z.string().optional().nullable(),
  actual: z.string().optional().nullable()
})
const IMPACTS = new Set(['High', 'Medium', 'Low', 'Holiday', 'Non-Economic'])

export class FfFeedSource implements CalendarSource {
  readonly id = 'ff' as const

  constructor(private readonly url = FF_FEED_URL) {}

  async fetchEvents(signal?: AbortSignal): Promise<RawCalendarEvent[]> {
    const res = await fetch(this.url, { signal: timeoutSignal(30_000, signal) })
    if (!res.ok) throw new HttpError(res.status, this.url, null, await res.text())
    const json: unknown = await res.json()
    const items = z.array(z.unknown()).parse(json)
    const out: RawCalendarEvent[] = []
    for (const raw of items) {
      const p = itemSchema.safeParse(raw)
      if (!p.success) continue // malformed entries are skipped, never trusted
      const time = Date.parse(p.data.date)
      if (!Number.isFinite(time)) continue
      const impact = IMPACTS.has(p.data.impact) ? (p.data.impact as RawCalendarEvent['impact']) : 'Low'
      const opt = (s: string | null | undefined): string | null => (s ? cleanText(s, 32) || null : null)
      out.push({
        title: cleanText(p.data.title),
        currency: cleanText(p.data.country, 8).toUpperCase(),
        impact,
        time,
        forecastRaw: opt(p.data.forecast),
        previousRaw: opt(p.data.previous),
        actualRaw: opt(p.data.actual)
      })
    }
    return out
  }
}
