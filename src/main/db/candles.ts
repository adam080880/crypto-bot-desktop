import type { Statement } from 'better-sqlite3'
import type { Candle, DerivedCandle } from '@shared/candles'
import { TIMEFRAMES, TF_MS, isDerived, weekStartUtc, type Timeframe } from '@shared/timeframes'
import type { Db } from './client'

const table = (tf: Timeframe): string => {
  if (!TIMEFRAMES.includes(tf)) throw new Error(`unknown timeframe ${tf}`)
  return `candles_${tf}`
}

/**
 * Raw better-sqlite3 access for candle tables (hot path: millions of rows).
 * Statements are prepared once per timeframe and reused.
 */
export class CandleRepo {
  private readonly cache = new Map<string, Statement>()

  constructor(private readonly db: Db) {}

  private stmt(key: string, sql: () => string): Statement {
    let s = this.cache.get(key)
    if (!s) {
      s = this.db.$client.prepare(sql())
      this.cache.set(key, s)
    }
    return s
  }

  /**
   * Insert closed native candles; existing rows are kept (idempotent re-runs), except that a row still
   * missing taker buy volume / trades (stored before migration 0007) gets them filled in.
   * Returns rows inserted or filled.
   */
  insertNative(tf: '1m' | '1d' | '1w', symbolId: number, rows: readonly Candle[]): number {
    const s = this.stmt(`ins:${tf}`, () =>
      `INSERT INTO ${table(tf)} (symbol_id, open_time, open, high, low, close, volume, buy_volume, trades)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol_id, open_time) DO UPDATE SET buy_volume = excluded.buy_volume, trades = excluded.trades
       WHERE buy_volume IS NULL AND excluded.buy_volume IS NOT NULL`
    )
    let n = 0
    for (const r of rows) n += s.run(symbolId, r.t, r.o, r.h, r.l, r.c, r.v, r.bv ?? null, r.nt ?? null).changes
    return n
  }

  /** Open-time span of `tf` rows that still lack taker buy volume (null = none). */
  missingFlow(tf: Timeframe, symbolId: number, from = 0): { first: number; last: number; count: number } | null {
    const s = this.stmt(`mfl:${tf}`, () =>
      `SELECT min(open_time) AS first, max(open_time) AS last, count(*) AS count
       FROM ${table(tf)} WHERE symbol_id = ? AND open_time >= ? AND buy_volume IS NULL`
    )
    const r = s.get(symbolId, from) as { first: number | null; last: number | null; count: number }
    return r.count ? { first: r.first!, last: r.last!, count: r.count } : null
  }

  /** Upsert derived candles (they're recomputed when source data changes). */
  upsertDerived(tf: Timeframe, symbolId: number, rows: readonly DerivedCandle[]): void {
    if (!isDerived(tf)) throw new Error(`${tf} is not a derived timeframe`)
    const s = this.stmt(`ups:${tf}`, () =>
      `INSERT INTO ${table(tf)} (symbol_id, open_time, open, high, low, close, volume, n, buy_volume, trades)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol_id, open_time) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume, n = excluded.n,
         buy_volume = excluded.buy_volume, trades = excluded.trades`
    )
    for (const r of rows) s.run(symbolId, r.t, r.o, r.h, r.l, r.c, r.v, r.n, r.bv ?? null, r.nt ?? null)
  }

  /** Candles with open_time in [from, to), ascending. */
  range(tf: Timeframe, symbolId: number, from: number, to: number): Candle[] | DerivedCandle[] {
    const cols = isDerived(tf) ? ', n' : ''
    const s = this.stmt(`rng:${tf}`, () =>
      `SELECT open_time AS t, open AS o, high AS h, low AS l, close AS c, volume AS v${cols}
       FROM ${table(tf)} WHERE symbol_id = ? AND open_time >= ? AND open_time < ?
       ORDER BY open_time`
    )
    return s.all(symbolId, from, to) as Candle[]
  }

  /**
   * Like `range`, plus taker buy volume (`bv`) and trade count (`nt`), null for rows stored before
   * migration 0007. Kept separate so the hot SMC/backtest reads stay lean.
   */
  rangeFlow(tf: Timeframe, symbolId: number, from: number, to: number): Candle[] | DerivedCandle[] {
    const cols = isDerived(tf) ? ', n' : ''
    const s = this.stmt(`rngf:${tf}`, () =>
      `SELECT open_time AS t, open AS o, high AS h, low AS l, close AS c, volume AS v${cols}, buy_volume AS bv, trades AS nt
       FROM ${table(tf)} WHERE symbol_id = ? AND open_time >= ? AND open_time < ?
       ORDER BY open_time`
    )
    return s.all(symbolId, from, to) as Candle[]
  }

  /** Newest `limit` candles at or before `before`, returned ascending. */
  latest(tf: Timeframe, symbolId: number, limit: number, before = Number.MAX_SAFE_INTEGER): Candle[] {
    const cols = isDerived(tf) ? ', n' : ''
    const s = this.stmt(`lat:${tf}`, () =>
      `SELECT open_time AS t, open AS o, high AS h, low AS l, close AS c, volume AS v${cols}
       FROM ${table(tf)} WHERE symbol_id = ? AND open_time <= ?
       ORDER BY open_time DESC LIMIT ?`
    )
    return (s.all(symbolId, before, limit) as Candle[]).reverse()
  }

  bounds(tf: Timeframe, symbolId: number): { first: number | null; last: number | null; count: number } {
    const s = this.stmt(`bnd:${tf}`, () =>
      `SELECT min(open_time) AS first, max(open_time) AS last, count(*) AS count
       FROM ${table(tf)} WHERE symbol_id = ?`
    )
    return s.get(symbolId) as { first: number | null; last: number | null; count: number }
  }

  /** Delete rows older than `cutoff` (all symbols), in chunks to keep transactions short. */
  pruneOlderThan(tf: Timeframe, cutoff: number, symbolsPerTx = 4): number {
    // WITHOUT ROWID: delete per symbol so each DELETE is a PK range scan.
    const del = this.stmt(`prn2:${tf}`, () =>
      `DELETE FROM ${table(tf)} WHERE symbol_id = ? AND open_time < ?`
    )
    const ids = this.db.$client.prepare(`SELECT id FROM symbols`).pluck().all() as number[]
    let total = 0
    const tx = this.db.$client.transaction((batch: number[]) => {
      for (const id of batch) total += del.run(id, cutoff).changes
    })
    for (let i = 0; i < ids.length; i += symbolsPerTx) tx(ids.slice(i, i + symbolsPerTx))
    return total
  }

  count(tf: Timeframe): number {
    return this.db.$client.prepare(`SELECT count(*) FROM ${table(tf)}`).pluck().get() as number
  }

  // ---- weekly lookup helpers -------------------------------------------------------------

  /** All `tf` candles of the week (Mon 00:00 UTC → next Mon) that contains `anyTimeInWeek`. */
  week(tf: Timeframe, symbolId: number, anyTimeInWeek: number): Candle[] {
    const start = weekStartUtc(anyTimeInWeek)
    return this.range(tf, symbolId, start, start + TF_MS['1w'])
  }

  /** Multi-timeframe snapshot of one week, e.g. for weekly SMC analysis. */
  weekBundle(
    symbolId: number,
    anyTimeInWeek: number,
    tfs: readonly Timeframe[] = ['1w', '1d', '4h', '1h']
  ): { weekStart: number; weekEnd: number; candles: Partial<Record<Timeframe, Candle[]>> } {
    const weekStart = weekStartUtc(anyTimeInWeek)
    const candles: Partial<Record<Timeframe, Candle[]>> = {}
    for (const tf of tfs) candles[tf] = this.week(tf, symbolId, weekStart)
    return { weekStart, weekEnd: weekStart + TF_MS['1w'], candles }
  }

  /** Week starts for which `tf` data exists (newest first). */
  weeksAvailable(symbolId: number, limit = 104): number[] {
    return (
      this.db.$client
        .prepare(`SELECT open_time FROM candles_1w WHERE symbol_id = ? ORDER BY open_time DESC LIMIT ?`)
        .pluck()
        .all(symbolId, limit) as number[]
    )
  }
}
