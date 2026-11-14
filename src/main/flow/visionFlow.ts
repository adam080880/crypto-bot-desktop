import { BinanceFuturesClient } from '../exchange/binanceFutures'
import { logger } from '../logger'
import type { FlowData } from '../strategy/flow'
import { fetchVisionCsv, VISION_BASE } from '../sync/vision'

const log = logger('vision-flow')
const DAY = 86_400_000
const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (t: number): string => {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Daily metrics CSV → 5-minute OI snapshots (value in USDT). */
export function parseMetricsCsv(text: string): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = []
  for (const line of text.split('\n')) {
    const f = line.split(',')
    // create_time,symbol,sum_open_interest,sum_open_interest_value,...
    if (f.length < 4 || !/^\d{4}-/.test(f[0]!)) continue
    const t = Date.parse(`${f[0]!.replace(' ', 'T')}Z`)
    const v = Number(f[3])
    if (Number.isFinite(t) && Number.isFinite(v) && v > 0) out.push({ t, v })
  }
  // newer files list the rows out of order
  return out.sort((a, b) => a.t - b.t)
}

/** Monthly fundingRate CSV (calc_time,funding_interval_hours,last_funding_rate). */
export function parseFundingCsv(text: string): { t: number; r: number }[] {
  const out: { t: number; r: number }[] = []
  for (const line of text.split('\n')) {
    const f = line.split(',')
    if (f.length < 3 || !/^\d+$/.test(f[0]!.trim())) continue
    const t = Number(f[0])
    const r = Number(f[2])
    if (Number.isFinite(r)) out.push({ t, r })
  }
  return out
}

const dedupe = <T extends { t: number }>(rows: T[]): T[] => {
  const m = new Map<number, T>()
  for (const r of rows) m.set(r.t, r)
  return [...m.values()].sort((a, b) => a.t - b.t)
}

/**
 * Open interest + funding history for a backtest, downloaded on demand from data.binance.vision
 * (not stored: the DB keeps only a few days for live, user decision). Recent days that vision has
 * not published yet come from the REST endpoints. Missing files are skipped, never guessed.
 */
export async function downloadFlow(symbol: string, from: number, to: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<FlowData> {
  const jobs: (() => Promise<void>)[] = []
  const oi: { t: number; v: number }[] = []
  const funding: { t: number; r: number }[] = []
  for (let d = Math.floor(from / DAY) * DAY - DAY; d <= to; d += DAY) {
    const day = ymd(d)
    jobs.push(async () => {
      const r = await fetchVisionCsv(`${VISION_BASE}/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`, signal)
      if (r) oi.push(...parseMetricsCsv(r.text))
    })
  }
  // funding percentile looks back ~30 days before the first setup
  const start = new Date(from - 40 * DAY)
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1; Date.UTC(y, m - 1, 1) <= to; m === 12 ? (y++, (m = 1)) : m++) {
    const month = `${y}-${pad(m)}`
    jobs.push(async () => {
      const r = await fetchVisionCsv(`${VISION_BASE}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`, signal)
      if (r) funding.push(...parseFundingCsv(r.text))
    })
  }
  const rest = new BinanceFuturesClient()
  jobs.push(async () => {
    try {
      oi.push(...(await rest.openInterestHist(symbol, '5m', 500, signal)))
      funding.push(...(await rest.fundingRates(symbol, 1000, signal)))
    } catch (err) {
      log.warn({ symbol, err: (err as Error).message }, 'flow REST fill failed')
    }
  })

  let done = 0
  const queue = [...jobs]
  const worker = async (): Promise<void> => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      try {
        await j()
      } catch (err) {
        if (signal?.aborted) throw err
        log.warn({ symbol, err: (err as Error).message }, 'flow file failed')
      }
      onProgress?.(++done, jobs.length)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  // REST and vision stamp the same snapshot/settlement a few ms apart: key by minute
  const minute = (t: number): number => Math.round(t / 60_000) * 60_000
  return { oi: dedupe(oi.map((x) => ({ t: minute(x.t), v: x.v }))), funding: dedupe(funding.map((x) => ({ t: minute(x.t), r: x.r }))) }
}
