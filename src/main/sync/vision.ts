import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import type { Candle } from '@shared/candles'
import { HttpError, timeoutSignal, withRetry } from '../exchange/http'
import { logger } from '../logger'

const log = logger('vision')
export const VISION_BASE = 'https://data.binance.vision/data/futures/um'

export type VisionPeriod = { kind: 'monthly'; year: number; month: number } | { kind: 'daily'; year: number; month: number; day: number }

const pad = (n: number): string => String(n).padStart(2, '0')

export function visionUrl(symbol: string, interval: string, p: VisionPeriod): string {
  const date = p.kind === 'monthly' ? `${p.year}-${pad(p.month)}` : `${p.year}-${pad(p.month)}-${pad(p.day)}`
  return `${VISION_BASE}/${p.kind}/klines/${symbol}/${interval}/${symbol}-${interval}-${date}.zip`
}

/**
 * Parse a Binance kline CSV. Handles files with and without a header row and
 * microsecond timestamps (Binance switched some datasets to µs in 2025).
 */
export function parseKlineCsv(text: string): Candle[] {
  const out: Candle[] = []
  let start = 0
  const len = text.length
  while (start < len) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = len
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end)
    start = end + 1
    if (!line) continue
    const c0 = line.charCodeAt(0)
    if (c0 < 48 || c0 > 57) continue // header or junk
    // open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,...
    const f = line.split(',', 10)
    if (f.length < 6) continue
    let t = Number(f[0])
    if (t > 1e14) t = Math.floor(t / 1000) // µs → ms
    const c: Candle = { t, o: Number(f[1]), h: Number(f[2]), l: Number(f[3]), c: Number(f[4]), v: Number(f[5]) }
    if (f.length >= 10) {
      c.nt = Number(f[8])
      c.bv = Number(f[9])
    }
    out.push(c)
  }
  return out
}

export interface VisionFile {
  candles: Candle[]
  bytes: number
}

/**
 * Download one zip, verify its SHA-256 against the published .CHECKSUM, unzip, return the CSV text.
 * Returns null when the file doesn't exist (404: not listed yet / not published yet).
 */
export async function fetchVisionCsv(url: string, signal?: AbortSignal): Promise<{ text: string; bytes: number } | null> {
  return withRetry(
    async () => {
      const res = await fetch(url, { signal: timeoutSignal(120_000, signal) })
      if (res.status === 404 || res.status === 403) return null // S3 answers 403/404 for missing keys
      if (!res.ok) throw new HttpError(res.status, url, null, await res.text())
      const zip = new Uint8Array(await res.arrayBuffer())

      const sumRes = await fetch(`${url}.CHECKSUM`, { signal: timeoutSignal(30_000, signal) })
      if (sumRes.ok) {
        const expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase()
        const actual = createHash('sha256').update(zip).digest('hex')
        if (expected && expected !== actual) throw new Error(`checksum mismatch for ${url}`)
      } else {
        log.warn({ url, status: sumRes.status }, 'checksum file missing; continuing unverified')
      }

      const files = unzipSync(zip)
      const csvName = Object.keys(files).find((n) => n.endsWith('.csv'))
      if (!csvName) throw new Error(`no csv inside ${url}`)
      return { text: new TextDecoder().decode(files[csvName]), bytes: zip.byteLength }
    },
    {
      signal,
      retries: 4,
      onRetry: (attempt, err, delay) => log.warn({ url, attempt, delay, err: (err as Error).message }, 'retry vision')
    }
  )
}

/** Download + verify + parse one kline zip (null when it doesn't exist). */
export async function fetchVisionKlines(symbol: string, interval: string, period: VisionPeriod, signal?: AbortSignal): Promise<VisionFile | null> {
  const r = await fetchVisionCsv(visionUrl(symbol, interval, period), signal)
  return r ? { candles: parseKlineCsv(r.text), bytes: r.bytes } : null
}
