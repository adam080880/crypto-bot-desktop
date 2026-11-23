import type { DataConfig } from '@shared/config'
import type { BackfillEstimate, BackfillSummary, TableSize } from '@shared/sync'
import { TIMEFRAMES, TF_MS, type Timeframe } from '@shared/timeframes'
import { z } from 'zod'
import type { Db } from '../db/client'
import { readSetting } from '../db/settingsRepo'
import { activeSymbols } from '../db/symbolsRepo'
import { klinesWeight } from '../exchange/binanceFutures'
import { oneMinuteStart } from './backfill'

const DAY = TF_MS['1d']
const FALLBACK_BYTES_PER_ROW = 55

export function tableSizes(db: Db): TableSize[] {
  const sizes = new Map(
    (db.$client.prepare(`SELECT name, sum(pgsize) AS bytes FROM dbstat WHERE name LIKE 'candles_%' GROUP BY name`).all() as {
      name: string
      bytes: number
    }[]).map((r) => [r.name, r.bytes])
  )
  return TIMEFRAMES.map((tf) => {
    const rows = db.$client.prepare(`SELECT count(*) FROM candles_${tf}`).pluck().get() as number
    const bytes = sizes.get(`candles_${tf}`) ?? 0
    return { timeframe: tf, rows, bytes, bytesPerRow: rows > 500 ? bytes / rows : null }
  })
}

export function dbFileBytes(db: Db): number {
  const pageSize = db.$client.pragma('page_size', { simple: true }) as number
  const pages = db.$client.pragma('page_count', { simple: true }) as number
  return pageSize * pages
}

/**
 * Project full-backfill DB size, download volume and duration for all active symbols,
 * using bytes/row and throughput measured by the last (test) run.
 */
export function estimateFullBackfill(db: Db, data: DataConfig, concurrency: number, now = Date.now()): BackfillEstimate {
  const symbols = activeSymbols(db)
  const start1m = oneMinuteStart(now, data)
  const longStart = now - data.longHistoryDays * DAY
  const derivedStart = now - data.derivedRetentionDays * DAY

  let minutes = 0
  let days = 0
  let derivedMinutes = 0
  let restWeight = 0
  for (const s of symbols) {
    const m = Math.max(0, (now - Math.max(start1m, s.onboardDate)) / TF_MS['1m'])
    const d = Math.max(0, (now - Math.max(longStart, s.onboardDate)) / DAY)
    minutes += m
    days += d
    // derived history can't predate 1m history on a fresh backfill
    derivedMinutes += Math.max(0, (now - Math.max(start1m, derivedStart, s.onboardDate)) / TF_MS['1m'])
    restWeight += Math.ceil(d / 1000) * klinesWeight(1000) + klinesWeight(1000) // 1d + 1w
    restWeight += 2 * klinesWeight(1000) // ~1 day of 1m gap fill via REST
  }
  const projectedRows: Record<Timeframe, number> = {
    '1m': minutes,
    '3m': derivedMinutes / 3,
    '5m': derivedMinutes / 5,
    '10m': derivedMinutes / 10,
    '15m': derivedMinutes / 15,
    '45m': derivedMinutes / 45,
    '1h': derivedMinutes / 60,
    '2h': derivedMinutes / 120,
    '3h': derivedMinutes / 180,
    '4h': derivedMinutes / 240,
    '1d': days,
    '1w': days / 7
  }

  const sizes = tableSizes(db)
  const tables = sizes.map((t) => {
    const rows = Math.round(projectedRows[t.timeframe])
    return { ...t, projectedRows: rows, projectedBytes: Math.round(rows * (t.bytesPerRow ?? FALLBACK_BYTES_PER_ROW)) }
  })
  const projectedDbBytes = tables.reduce((a, t) => a + t.projectedBytes, 0)

  const last = readSetting(db, 'backfill_last_run', z.custom<BackfillSummary>((v) => typeof v === 'object' && v !== null))
  const notes: string[] = []
  let measuredOn: BackfillEstimate['measuredOn'] = null
  let projectedDownloadBytes: number | null = null
  let projectedSeconds: number | null = null
  if (last && last.rows['1m'] > 10_000) {
    const seconds = (last.finishedAt - last.startedAt) / 1000
    measuredOn = { symbols: last.symbols, rows1m: last.rows['1m'], seconds, concurrency }
    projectedDownloadBytes = Math.round((last.bytesDownloaded / last.rows['1m']) * minutes)
    projectedSeconds = Math.round((seconds / last.rows['1m']) * minutes)
    if (last.symbols < concurrency) {
      // test ran with fewer parallel symbols than the full run will use
      projectedSeconds = Math.round((projectedSeconds * last.symbols) / concurrency)
      notes.push(`Tes memakai ${last.symbols} simbol paralel; estimasi waktu diskalakan ke concurrency ${concurrency}.`)
    }
  } else {
    notes.push('Belum ada run tes untuk mengukur throughput; jalankan --test dulu.')
  }
  const restWeightMinutes = restWeight / 1800
  if (projectedSeconds !== null) projectedSeconds = Math.max(projectedSeconds, Math.round(restWeightMinutes * 60))
  notes.push('Selama backfill, file -wal bisa sementara membesar; sisakan ruang disk ~20% di atas estimasi.')

  return {
    activeSymbols: symbols.length,
    measuredOn,
    tables,
    projectedDbBytes,
    projectedDownloadBytes,
    projectedSeconds,
    restWeightMinutes,
    notes
  }
}
