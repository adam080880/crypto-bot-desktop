import { z } from 'zod'
import { HttpError, timeoutSignal } from '../../exchange/http'
import type { Observation } from '../actuals'
import type { SeriesSource } from './types'

const BLS_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/'

const respSchema = z.object({
  status: z.string(),
  message: z.array(z.string()).optional(),
  Results: z
    .object({
      series: z.array(
        z.object({
          seriesID: z.string(),
          data: z.array(z.object({ year: z.string(), period: z.string(), value: z.string() }))
        })
      )
    })
    .optional()
})

/** US Bureau of Labor Statistics public API. Without a key: 25 requests/day, 25 series/request. */
export class BlsSource implements SeriesSource {
  readonly id = 'bls' as const

  constructor(private readonly apiKey: () => string | null) {}

  async fetchSeries(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, Observation[]>> {
    const year = new Date().getUTCFullYear()
    const body: Record<string, unknown> = { seriesid: ids.slice(0, 25), startyear: String(year - 1), endyear: String(year) }
    const key = this.apiKey()
    if (key) body.registrationkey = key
    const res = await fetch(BLS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(30_000, signal)
    })
    if (!res.ok) throw new HttpError(res.status, BLS_URL, null, await res.text())
    const parsed = respSchema.parse(await res.json())
    if (parsed.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS: ${parsed.status} ${parsed.message?.join('; ') ?? ''}`)
    const out = new Map<string, Observation[]>()
    for (const s of parsed.Results?.series ?? []) {
      const obs: Observation[] = []
      for (const d of s.data) {
        const m = d.period.match(/^M(0[1-9]|1[0-2])$/) // monthly only (M13 = annual average)
        const v = Number(d.value)
        if (!m || d.value === '-' || !Number.isFinite(v)) continue
        obs.push({ date: Date.UTC(Number(d.year), Number(m[1]) - 1, 1), value: v })
      }
      out.set(s.seriesID, obs)
    }
    return out
  }
}
