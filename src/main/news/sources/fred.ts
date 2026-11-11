import { HttpError, timeoutSignal } from '../../exchange/http'
import type { Observation } from '../actuals'
import type { SeriesSource } from './types'

/** FRED (St. Louis Fed) public CSV download — no API key needed. */
export class FredSource implements SeriesSource {
  readonly id = 'fred' as const

  async fetchSeries(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, Observation[]>> {
    const out = new Map<string, Observation[]>()
    for (const id of ids) {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`
      const res = await fetch(url, { signal: timeoutSignal(30_000, signal) })
      if (!res.ok) throw new HttpError(res.status, url, null, await res.text())
      out.set(id, parseFredCsv(await res.text()))
    }
    return out
  }
}

export function parseFredCsv(text: string): Observation[] {
  const obs: Observation[] = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [date, value] = line.split(',')
    if (!date || !value || value === '.') continue
    const t = Date.parse(`${date}T00:00:00Z`)
    const v = Number(value)
    if (Number.isFinite(t) && Number.isFinite(v)) obs.push({ date: t, value: v })
  }
  return obs
}
