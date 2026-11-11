import type { ActualSourceConfig } from '@shared/config'

export interface Observation {
  /** Period start (ms UTC), e.g. 2026-10-01 for October. */
  date: number
  value: number
}

const DAY = 86_400_000

/** Earliest acceptable observation date for an event (see ActualSourceConfig.refLag). */
export function minReferenceDate(eventTime: number, lag: ActualSourceConfig['refLag']): number {
  const d = new Date(eventTime)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  switch (lag.unit) {
    case 'day':
      return Date.UTC(y, m, d.getUTCDate()) - lag.n * DAY
    case 'week':
      return eventTime - lag.n * 7 * DAY
    case 'month':
      return Date.UTC(y, m - lag.n, 1)
    case 'quarter': {
      const q = Math.floor(m / 3) * 3
      return Date.UTC(y, q - 3 * lag.n, 1)
    }
  }
}

/**
 * Compute the event's actual from an official series, or null if the release isn't out yet
 * (latest observation older than the reference period) or data is missing.
 */
export function computeActual(obs: readonly Observation[], src: ActualSourceConfig, eventTime: number): number | null {
  const sorted = [...obs].filter((o) => Number.isFinite(o.value)).sort((a, b) => a.date - b.date)
  const last = sorted[sorted.length - 1]
  if (!last || last.date < minReferenceDate(eventTime, src.refLag)) return null
  const back = (n: number): Observation | undefined => sorted[sorted.length - 1 - n]
  let v: number
  switch (src.transform) {
    case 'level':
      v = last.value
      break
    case 'diff': {
      const p = back(1)
      if (!p) return null
      v = last.value - p.value
      break
    }
    case 'pct_mom': {
      const p = back(1)
      if (!p || p.value === 0) return null
      v = (last.value / p.value - 1) * 100
      break
    }
    case 'pct_yoy': {
      // 12 periods back by date, not by index (series can have gaps)
      const target = new Date(last.date)
      const yAgo = Date.UTC(target.getUTCFullYear() - 1, target.getUTCMonth(), 1)
      const p = sorted.find((o) => o.date === yAgo)
      if (!p || p.value === 0) return null
      v = (last.value / p.value - 1) * 100
      break
    }
  }
  const f = 10 ** src.decimals
  return Math.round(v * src.scale * f) / f
}
