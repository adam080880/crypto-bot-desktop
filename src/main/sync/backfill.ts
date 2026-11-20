import { EventEmitter } from 'node:events'
import { isSymbolAllowed, type DataConfig } from '@shared/config'
import type { Candle } from '@shared/candles'
import type { BackfillEvent, BackfillEventBody, BackfillKind, BackfillSummary } from '@shared/sync'
import { TF_MS, weekStartUtc, type SourceTimeframe } from '@shared/timeframes'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { activeSymbols, getSyncState, markSynced, symbolByName, upsertSymbols, type SymbolRow } from '../db/symbolsRepo'
import { BinanceFuturesClient } from '../exchange/binanceFutures'
import { logger } from '../logger'
import { KeyedMutex } from './keyedMutex'
import { rebuildDerived } from './resample'
import { z } from 'zod'
import { fetchVisionKlines, type VisionPeriod } from './vision'

const log = logger('backfill')
const MIN = TF_MS['1m']
const DAY = TF_MS['1d']

export interface BackfillParams {
  /** Restrict to these symbols (e.g. ['BTCUSDT']). Default: all active perpetuals. */
  symbols?: string[]
  /** Only the first N symbols of the selection. */
  limit?: number
  sources?: readonly SourceTimeframe[]
  /** Per-symbol override of `sources` (e.g. live-streamed symbols only need 1d/1w). */
  sourcesFor?: (symbol: string) => readonly SourceTimeframe[]
  /** 'backfill' records measurements for estimates; 'catchup' is the periodic auto-sync. */
  kind?: 'backfill' | 'catchup'
  data: DataConfig
  now?: number
  signal?: AbortSignal
}

const monthStart = (t: number): number => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
const nextMonth = (t: number): number => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}
const ymd = (t: number): { year: number; month: number; day: number } => {
  const d = new Date(t)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Earliest 1m candle we keep: retention window start, aligned to UTC midnight. */
export const oneMinuteStart = (now: number, data: DataConfig): number =>
  Math.floor((now - data.oneMinuteRetentionDays * DAY) / DAY) * DAY

const FULL_DONE_KEY = 'full_backfill_done'

export class Backfiller extends EventEmitter<{ event: [BackfillEvent] }> {
  private readonly repo: CandleRepo
  /** One writer per symbol at a time: backfill, REST catch-up and live ingest share it. */
  readonly locks = new KeyedMutex()

  constructor(
    private readonly db: Db,
    private readonly client = new BinanceFuturesClient()
  ) {
    super()
    this.repo = new CandleRepo(db)
  }

  private emitEvent(kind: BackfillKind, e: BackfillEventBody): void {
    this.emit('event', { ...e, kind } as BackfillEvent)
  }

  /** Refresh the symbol list; filtered-out symbols are stored as inactive. */
  async refreshSymbols(data: DataConfig, signal?: AbortSignal): Promise<{ total: number; added: string[] }> {
    const list = (await this.client.perpetualSymbols(signal)).filter((s) => isSymbolAllowed(s.symbol, data))
    const added = upsertSymbols(this.db, list).map((s) => s.symbol)
    if (added.length) log.info({ count: added.length, sample: added.slice(0, 20) }, 'new symbols detected')
    return { total: list.length, added }
  }

  async run(p: BackfillParams): Promise<BackfillSummary> {
    const started = Date.now()
    const now = p.now ?? Date.now()
    const kind = p.kind ?? 'backfill'
    const defaultSources = p.sources ?? ['1m', '1d', '1w']
    const sourcesOf = (symbol: string): readonly SourceTimeframe[] => p.sourcesFor?.(symbol) ?? defaultSources
    await this.refreshSymbols(p.data, p.signal)

    let targets: SymbolRow[] = activeSymbols(this.db)
    if (p.symbols?.length) {
      const want = new Set(p.symbols.map((s) => s.toUpperCase()))
      targets = targets.filter((s) => want.has(s.symbol))
      const missing = [...want].filter((w) => !targets.some((t) => t.symbol === w))
      if (missing.length) log.warn({ missing }, 'requested symbols are not active perpetuals')
    }
    if (p.limit) targets = targets.slice(0, p.limit)

    const total = targets.length
    const summary: BackfillSummary = { ...emptySummary(kind), startedAt: started, symbols: total }
    this.emitEvent(kind, { type: 'start', total, symbols: targets.map((t) => t.symbol) })

    // Progress weight per symbol ≈ minutes of 1m to fetch (+ fixed overhead for 1d/1w).
    const weightOf = (s: SymbolRow): number => {
      const start = Math.max(oneMinuteStart(now, p.data), s.onboardDate)
      const last = getSyncState(this.db, s.id, '1m')?.lastOpenTime
      const from = last != null ? Math.max(start, last + MIN) : start
      return Math.max(0, (now - from) / MIN) + 2000
    }
    const weights = new Map(targets.map((s) => [s.symbol, weightOf(s)]))
    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0) || 1
    let doneWeight = 0
    const partial = new Map<string, number>()

    const progress = (index: number, symbol: string, tf: string, step: string, frac: number): void => {
      partial.set(symbol, (weights.get(symbol) ?? 0) * Math.min(1, Math.max(0, frac)))
      const done = doneWeight + [...partial.values()].reduce((a, b) => a + b, 0)
      const fraction = done / totalWeight
      const elapsed = Date.now() - started
      this.emitEvent(kind, {
        type: 'progress',
        index,
        total,
        symbol,
        timeframe: tf,
        step,
        completed: summary.completed,
        fraction,
        etaMs: fraction > 0.01 ? Math.round((elapsed / fraction) * (1 - fraction)) : null,
        bytesDownloaded: summary.bytesDownloaded
      })
    }

    let next = 0
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        if (p.signal?.aborted) return
        const index = next++
        const sym = targets[index]!
        const t0 = Date.now()
        try {
          const sources = sourcesOf(sym.symbol)
          await this.locks.run(sym.symbol, async () => {
            if (sources.includes('1m')) await this.sync1m(sym, index, now, p, summary, progress)
            for (const tf of ['1d', '1w'] as const) {
              if (sources.includes(tf)) {
                progress(index, sym.symbol, tf, 'rest', 0.97)
                await this.syncLong(sym, tf, now, p, summary)
              }
            }
          })
          summary.completed++
          this.emitEvent(kind, { type: 'symbol-done', index, total, symbol: sym.symbol, ms: Date.now() - t0 })
        } catch (err) {
          if (p.signal?.aborted) return
          const msg = (err as Error).message
          summary.errors.push({ symbol: sym.symbol, error: msg })
          log.error({ symbol: sym.symbol, err: msg }, 'symbol backfill failed')
          this.emitEvent(kind, { type: 'symbol-error', index, total, symbol: sym.symbol, error: msg })
        } finally {
          partial.delete(sym.symbol)
          doneWeight += weights.get(sym.symbol) ?? 0
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(p.data.concurrency, total || 1) }, worker))

    summary.aborted = p.signal?.aborted ?? false
    summary.finishedAt = Date.now()
    if (kind === 'backfill') {
      if (!summary.aborted) this.pruneRetention(p.data, now)
      writeSetting(this.db, 'backfill_last_run', summary)
      if (!summary.aborted && !p.symbols?.length && !p.limit) writeSetting(this.db, FULL_DONE_KEY, true)
    }
    this.emitEvent(kind, { type: 'done', summary })
    log.info({ ...summary, errors: summary.errors.length }, `${kind} finished`)
    return summary
  }

  /** True once a full (all-symbol) backfill completed; from then on new listings auto-backfill. */
  isFullBackfillDone(): boolean {
    return readSetting(this.db, FULL_DONE_KEY, z.boolean()) ?? false
  }

  /**
   * Symbols auto-sync keeps up to date: everything already backfilled, plus `extra`
   * (watchlist/positions). After a full backfill, all active symbols (so new listings too).
   */
  trackedSymbols(extra: readonly string[] = []): SymbolRow[] {
    const active = activeSymbols(this.db)
    if (this.isFullBackfillDone()) return active
    const synced = new Set(
      this.db.$client.prepare(`SELECT symbol_id FROM sync_state WHERE timeframe = '1m'`).pluck().all() as number[]
    )
    const want = new Set(extra)
    return active.filter((s) => synced.has(s.id) || want.has(s.symbol))
  }

  /**
   * Store a closed 1m candle from the live stream. Only contiguous candles are written
   * directly; if there's a hole (disconnect, sleep) or the symbol was never synced, the gap is
   * filled via REST/zip first, so sync_state never jumps over missing data.
   */
  async ingestClosed1m(symbol: string, candle: Candle, data: DataConfig): Promise<'stored' | 'duplicate' | 'gap-filled'> {
    const sym = symbolByName(this.db, symbol)
    if (!sym) throw new Error(`unknown symbol ${symbol}`)
    return this.locks.run(symbol, async () => {
      const last = getSyncState(this.db, sym.id, '1m')?.lastOpenTime ?? null
      if (last !== null && candle.t <= last) return 'duplicate'
      if (last !== null && candle.t === last + MIN) {
        this.db.$client.transaction(() => {
          this.repo.insertNative('1m', sym.id, [candle])
          markSynced(this.db, sym.id, '1m', candle.t, candle.t)
          rebuildDerived(this.db, this.repo, sym.id, candle.t, candle.t + MIN)
        })()
        return 'stored'
      }
      // Hole or never synced: catch up everything up to now (includes this candle).
      const summary = emptySummary('catchup')
      await this.sync1m(sym, 0, Date.now(), { data }, summary, () => undefined)
      return 'gap-filled'
    })
  }

  /** Bring one symbol's 1m up to date now (used after a WebSocket reconnect). */
  async catchUp1m(symbol: string, data: DataConfig, signal?: AbortSignal): Promise<void> {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return
    await this.locks.run(symbol, () =>
      this.sync1m(sym, 0, Date.now(), { data, signal }, emptySummary('catchup'), () => undefined)
    )
  }

  /** Insert one batch of 1m candles inside a transaction and advance sync_state. */
  private store1m(sym: SymbolRow, rows: Candle[], from: number, until: number, summary: BackfillSummary): number | null {
    const fresh = rows.filter((r) => r.t >= from && r.t < until)
    if (!fresh.length) return null
    const first = fresh[0]!.t
    const last = fresh[fresh.length - 1]!.t
    this.db.$client.transaction(() => {
      summary.rows['1m'] += this.repo.insertNative('1m', sym.id, fresh)
      markSynced(this.db, sym.id, '1m', first, last)
    })()
    return last + MIN
  }

  private async sync1m(
    sym: SymbolRow,
    index: number,
    now: number,
    p: Pick<BackfillParams, 'data' | 'signal'>,
    summary: BackfillSummary,
    progress: (i: number, s: string, tf: string, step: string, frac: number) => void
  ): Promise<void> {
    const endClosed = Math.floor(now / MIN) * MIN // start of the forming candle
    const windowStart = Math.max(oneMinuteStart(now, p.data), Math.ceil(sym.onboardDate / MIN) * MIN)
    const last = getSyncState(this.db, sym.id, '1m')?.lastOpenTime
    let cursor = last != null ? Math.max(windowStart, last + MIN) : windowStart
    const touchedFrom = cursor
    const span = Math.max(1, endClosed - touchedFrom)
    const report = (step: string): void => progress(index, sym.symbol, '1m', step, ((cursor - touchedFrom) / span) * 0.9)
    report('start')

    const file = async (period: VisionPeriod): Promise<boolean> => {
      const f = await fetchVisionKlines(sym.symbol, '1m', period, p.signal)
      if (!f) return false
      summary.bytesDownloaded += f.bytes
      const nextCursor = this.store1m(sym, f.candles, cursor, endClosed, summary)
      if (nextCursor) cursor = nextCursor
      return true
    }

    const curMonth = monthStart(now)
    const today = Math.floor(now / DAY) * DAY

    // 1) Completed months: monthly zip, falling back to daily zips if not published yet.
    for (let m = monthStart(cursor); m < curMonth; m = nextMonth(m)) {
      if (cursor >= nextMonth(m)) continue
      report('vision-monthly')
      if (await file({ kind: 'monthly', ...ymd(m) })) continue
      for (let d = Math.max(m, Math.floor(cursor / DAY) * DAY); d < nextMonth(m); d += DAY) {
        report('vision-daily')
        if (!(await file({ kind: 'daily', ...ymd(d) }))) break
      }
    }
    // 2) Current month: daily zips up to yesterday (today's isn't published yet).
    for (let d = Math.max(curMonth, Math.floor(cursor / DAY) * DAY); d < today; d += DAY) {
      if (cursor >= d + DAY) continue
      report('vision-daily')
      if (!(await file({ kind: 'daily', ...ymd(d) }))) break
    }
    // 3) REST for whatever is left (latest hours / missing files).
    if (cursor < endClosed) {
      report('rest')
      for await (const rows of this.client.klines(sym.symbol, '1m', cursor, endClosed, p.signal)) {
        summary.restRequests++
        const nextCursor = this.store1m(sym, rows, cursor, endClosed, summary)
        if (nextCursor) cursor = nextCursor
        report('rest')
      }
    }
    summary.oneMinuteSpanMs += Math.max(0, cursor - touchedFrom)

    // 4) Resample everything touched (including the partially filled first bucket).
    if (cursor > touchedFrom) {
      progress(index, sym.symbol, '5m-4h', 'resample', 0.92)
      const written = rebuildDerived(this.db, this.repo, sym.id, touchedFrom, cursor)
      for (const [tf, n] of Object.entries(written)) summary.rows[tf as keyof typeof written] += n
    }
  }

  private async syncLong(sym: SymbolRow, tf: '1d' | '1w', now: number, p: Pick<BackfillParams, 'data' | 'signal'>, summary: BackfillSummary): Promise<void> {
    const step = TF_MS[tf]
    const align = (t: number): number => (tf === '1w' ? weekStartUtc(t) : Math.floor(t / DAY) * DAY)
    const endClosed = align(now)
    const windowStart = align(Math.max(now - p.data.longHistoryDays * DAY, sym.onboardDate))
    const last = getSyncState(this.db, sym.id, tf)?.lastOpenTime
    const cursor = last != null ? Math.max(windowStart, last + step) : windowStart
    if (cursor >= endClosed) return
    for await (const rows of this.client.klines(sym.symbol, tf, cursor, endClosed, p.signal)) {
      summary.restRequests++
      if (!rows.length) continue
      this.db.$client.transaction(() => {
        summary.rows[tf] += this.repo.insertNative(tf, sym.id, rows)
        markSynced(this.db, sym.id, tf, rows[0]!.t, rows[rows.length - 1]!.t)
      })()
    }
  }

  /**
   * Fill taker buy volume + trade count into rows stored before migration 0007 (`--flow`): re-download
   * the 1m zips (REST for the newest hours) over the span still missing them, upsert only those two
   * columns, then rebuild 5m–4h over that span. 1d/1w via REST. Does not move sync_state.
   */
  async enrichFlow(p: {
    symbols?: string[]
    limit?: number
    data: DataConfig
    signal?: AbortSignal
    now?: number
    onSymbol?: (e: { index: number; total: number; symbol: string; filled: number; bytes: number; ms: number; error?: string }) => void
  }): Promise<{ symbols: number; filled: number; bytes: number; errors: { symbol: string; error: string }[] }> {
    const now = p.now ?? Date.now()
    const synced = new Set(this.db.$client.prepare(`SELECT symbol_id FROM sync_state WHERE timeframe = '1m'`).pluck().all() as number[])
    let targets = activeSymbols(this.db).filter((s) => synced.has(s.id))
    if (p.symbols?.length) {
      const want = new Set(p.symbols.map((s) => s.toUpperCase()))
      targets = targets.filter((s) => want.has(s.symbol))
    }
    if (p.limit) targets = targets.slice(0, p.limit)
    const out = { symbols: targets.length, filled: 0, bytes: 0, errors: [] as { symbol: string; error: string }[] }
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < targets.length && !p.signal?.aborted) {
        const index = next++
        const sym = targets[index]!
        const t0 = Date.now()
        let filled = 0
        let bytes = 0
        try {
          const r = await this.enrichSymbol(sym, now, p.signal)
          filled = r.filled
          bytes = r.bytes
          out.filled += filled
          out.bytes += bytes
          p.onSymbol?.({ index, total: targets.length, symbol: sym.symbol, filled, bytes, ms: Date.now() - t0 })
        } catch (err) {
          if (p.signal?.aborted) return
          const error = (err as Error).message
          out.errors.push({ symbol: sym.symbol, error })
          log.error({ symbol: sym.symbol, err: error }, 'flow enrich failed')
          p.onSymbol?.({ index, total: targets.length, symbol: sym.symbol, filled, bytes, ms: Date.now() - t0, error })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(p.data.concurrency, targets.length || 1) }, worker))
    return out
  }

  private async enrichSymbol(sym: SymbolRow, now: number, signal?: AbortSignal): Promise<{ filled: number; bytes: number }> {
    let filled = 0
    let bytes = 0
    const write = (tf: '1m' | '1d' | '1w', rows: Candle[], from: number, to: number): Promise<void> =>
      retryBusy(() =>
        this.locks.run(sym.symbol, async () => {
          const keep = rows.filter((r) => r.t >= from && r.t <= to && r.bv != null)
          if (keep.length) this.db.$client.transaction(() => (filled += this.repo.insertNative(tf, sym.id, keep)))()
        }), signal)

    const gap = this.repo.missingFlow('1m', sym.id)
    if (gap) {
      const today = Math.floor(now / DAY) * DAY
      const curMonth = monthStart(now)
      const file = async (period: VisionPeriod): Promise<boolean> => {
        const f = await fetchVisionKlines(sym.symbol, '1m', period, signal)
        if (!f) return false
        bytes += f.bytes
        await write('1m', f.candles, gap.first, gap.last)
        return true
      }
      for (let m = monthStart(gap.first); m <= gap.last && m < curMonth; m = nextMonth(m)) {
        if (await file({ kind: 'monthly', ...ymd(m) })) continue
        for (let d = Math.max(m, Math.floor(gap.first / DAY) * DAY); d < nextMonth(m) && d <= gap.last; d += DAY) await file({ kind: 'daily', ...ymd(d) })
      }
      for (let d = Math.max(curMonth, Math.floor(gap.first / DAY) * DAY); d < today && d <= gap.last; d += DAY) await file({ kind: 'daily', ...ymd(d) })
      // whatever the zips didn't cover (today, unpublished days): REST
      const rest = this.repo.missingFlow('1m', sym.id)
      if (rest && rest.last >= now - 3 * DAY) {
        const from = Math.max(rest.first, Math.floor(now / DAY) * DAY - 2 * DAY)
        for await (const rows of this.client.klines(sym.symbol, '1m', from, rest.last + MIN, signal)) await write('1m', rows, from, rest.last)
      }
    }
    // 5m–4h over the refilled span, plus derived rows still empty although their 1m is filled (a previous
    // run whose resample failed). Only up to what's final in 1m; older derived rows have no 1m left.
    const first1m = this.repo.bounds('1m', sym.id).first
    const last1m = getSyncState(this.db, sym.id, '1m')?.lastOpenTime
    if (first1m != null && last1m != null) {
      let from = gap ? gap.first : Infinity
      let to = gap ? gap.last : -Infinity
      const d = this.repo.missingFlow('5m', sym.id, first1m)
      if (d && d.count > 2) {
        // a lone empty bucket at the edge of the 1m window can't be filled; don't rebuild 6 months for it
        from = Math.min(from, d.first)
        to = Math.max(to, d.last)
      }
      if (from <= to) await this.rebuildChunked(sym, Math.max(from, first1m), Math.min(to, last1m) + MIN, signal)
    }
    for (const tf of ['1d', '1w'] as const) {
      const g = this.repo.missingFlow(tf, sym.id)
      if (!g) continue
      for await (const rows of this.client.klines(sym.symbol, tf, g.first, g.last + TF_MS[tf], signal)) await write(tf, rows, g.first, g.last)
    }
    return { filled, bytes }
  }

  /**
   * rebuildDerived in weekly transactions (4h-aligned edges), so a long refill never holds the write lock
   * for long; retried when the app's writer has the DB busy.
   */
  private async rebuildChunked(sym: SymbolRow, from: number, until: number, signal?: AbortSignal): Promise<void> {
    const WEEK = 7 * DAY
    for (let a = Math.floor(from / (4 * 3600_000)) * 4 * 3600_000; a < until; a += WEEK) {
      const b = Math.min(a + WEEK, until)
      await retryBusy(() => this.locks.run(sym.symbol, async () => void rebuildDerived(this.db, this.repo, sym.id, a, b)), signal)
    }
  }

  /** Rolling retention: drop 1m beyond its window, derived beyond theirs. */
  pruneRetention(data: DataConfig, now = Date.now()): Record<string, number> {
    const removed: Record<string, number> = {}
    removed['1m'] = this.repo.pruneOlderThan('1m', oneMinuteStart(now, data))
    const derivedCutoff = Math.floor((now - data.derivedRetentionDays * DAY) / DAY) * DAY
    for (const tf of ['5m', '15m', '1h', '4h'] as const) removed[tf] = this.repo.pruneOlderThan(tf, derivedCutoff)
    // keep sync_state.first_open_time honest after pruning
    this.db.$client
      .prepare(
        `UPDATE sync_state SET first_open_time = max(first_open_time, ?) WHERE timeframe = '1m' AND first_open_time IS NOT NULL`
      )
      .run(oneMinuteStart(now, data))
    if (Object.values(removed).some((n) => n > 0)) log.info({ removed }, 'retention prune')
    return removed
  }
}

/** Retry a write while another process (the app's data worker) holds the SQLite write lock. */
async function retryBusy(fn: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return
    try {
      return await fn()
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || attempt >= 6) throw err
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

export function emptySummary(kind: 'backfill' | 'catchup'): BackfillSummary {
  return {
    kind,
    startedAt: Date.now(),
    finishedAt: 0,
    symbols: 0,
    completed: 0,
    rows: { '1m': 0, '1d': 0, '1w': 0, '5m': 0, '15m': 0, '1h': 0, '4h': 0 },
    bytesDownloaded: 0,
    restRequests: 0,
    errors: [],
    aborted: false,
    oneMinuteSpanMs: 0
  }
}
