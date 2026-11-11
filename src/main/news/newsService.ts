import { EventEmitter } from 'node:events'
import { z } from 'zod'
import type { NewsConfig, SmcConfig } from '@shared/config'
import type { EconomicEvent, NewsCandidate, NewsState } from '@shared/news'
import type { Dir } from '@shared/smc'
import { TF_MS } from '@shared/timeframes'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { symbolByName } from '../db/symbolsRepo'
import { logger } from '../logger'
import { SmcService } from '../strategy/service'
import { computeActual } from './actuals'
import { findRule } from './interpret'
import { activeWindow, nextEvent } from './newsWindow'
import { formatLike } from './parse'
import { NewsRepo } from './repo'
import { BlsSource } from './sources/bls'
import { FfFeedSource } from './sources/ffFeed'
import { FredSource } from './sources/fred'
import type { CalendarSource, SeriesSource } from './sources/types'

const log = logger('news')
const MIN = 60_000
const DAY = 86_400_000
/** Minutes after release at which we poll for the official actual (then give up). */
const ACTUAL_POLL_OFFSETS_MIN = [1, 3, 6, 10, 20, 30, 60, 120, 240, 480, 720, 1440, 2160]
const BLS_DAILY_LIMIT_NO_KEY = 25
const BLS_DAILY_LIMIT_KEY = 500
const quotaSchema = z.object({ day: z.string(), calls: z.number() })

export interface NewsDeps {
  getConfig: () => NewsConfig
  getSmc: () => SmcConfig
  getWatchlist: () => readonly string[]
  getBlsKey: () => string | null
}

/**
 * Runs inside the data worker. Fetches the calendar, polls official actuals after releases,
 * interprets them, records price reactions and builds trade-on-news candidates.
 */
export class NewsService extends EventEmitter<{ state: [NewsState]; changed: []; candidate: [NewsCandidate] }> {
  private readonly repo: NewsRepo
  private readonly candles: CandleRepo
  private readonly smc: SmcService
  private readonly calendar: CalendarSource = new FfFeedSource()
  private readonly series: Record<'bls' | 'fred', SeriesSource>
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private attempts = new Map<string, number>()
  private feedRetryAt = 0
  private state: NewsState = { lastFetchAt: null, lastError: null, nextEvent: null, window: null, blsCallsToday: 0 }

  constructor(
    private readonly db: Db,
    private readonly deps: NewsDeps
  ) {
    super()
    this.repo = new NewsRepo(db)
    this.candles = new CandleRepo(db)
    this.smc = new SmcService(db)
    this.series = { bls: new BlsSource(deps.getBlsKey), fred: new FredSource() }
  }

  start(): void {
    this.state.blsCallsToday = this.blsQuota().calls
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 30_000)
  }

  getState(): NewsState {
    return this.state
  }

  async refreshNow(): Promise<void> {
    this.feedRetryAt = 0
    this.state.lastFetchAt = null
    await this.tick()
  }

  /** Manual actual from the UI (fallback for events without an official free source). */
  setManualActual(id: string, value: number | null): EconomicEvent | null {
    const e = this.repo.get(id)
    if (!e) return null
    const cfg = this.deps.getConfig()
    const rule = findRule(e.title, cfg.rules)
    const raw = value === null ? null : formatLike(value, e.forecastRaw ?? e.previousRaw, decimalsOf(e.forecastRaw ?? e.previousRaw))
    const updated = this.repo.setActual(id, value, raw, 'manual', rule, cfg.cryptoBiasMode)
    if (updated) {
      log.info({ id, title: e.title, value, usdBias: updated.usdBias }, 'manual actual set')
      this.buildCandidates(updated)
      this.emit('changed')
    }
    return updated
  }

  private async tick(): Promise<void> {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled || this.busy) return this.updateState()
    this.busy = true
    try {
      const now = Date.now()
      const due = this.state.lastFetchAt === null || now - this.state.lastFetchAt >= cfg.feedRefreshMinutes * MIN
      if (due && now >= this.feedRetryAt) await this.fetchFeed(cfg)
      await this.pollActuals(cfg)
      this.computeReactions(cfg)
    } catch (err) {
      log.error({ err: (err as Error).message }, 'news tick failed')
    } finally {
      this.busy = false
      this.updateState()
    }
  }

  private async fetchFeed(cfg: NewsConfig): Promise<void> {
    try {
      const items = await this.calendar.fetchEvents()
      const n = this.repo.upsertFeed(this.calendar.id, items, cfg)
      this.state.lastFetchAt = Date.now()
      this.state.lastError = null
      log.info({ events: n }, 'calendar feed updated')
      this.emit('changed')
    } catch (err) {
      this.feedRetryAt = Date.now() + 15 * MIN // be gentle with the feed on errors
      this.state.lastError = `Kalender: ${(err as Error).message}`
      log.warn({ err: (err as Error).message }, 'calendar feed failed')
    }
  }

  /** Poll BLS/FRED for released events whose rule has an official source. Batched per provider. */
  private async pollActuals(cfg: NewsConfig): Promise<void> {
    const now = Date.now()
    const waiting = this.repo
      .list(now - 2 * DAY, now)
      .filter((e) => e.actual === null && cfg.currencies.includes(e.currency))
      .map((e) => ({ e, rule: findRule(e.title, cfg.rules) }))
      .filter((x): x is { e: EconomicEvent; rule: NonNullable<typeof x.rule> & { source: NonNullable<typeof x.rule>['source'] } } => !!x.rule?.source)
      .filter(({ e }) => {
        const k = this.attempts.get(e.id) ?? 0
        const offset = ACTUAL_POLL_OFFSETS_MIN[k]
        return offset !== undefined && now >= e.time + offset * MIN
      })
    if (!waiting.length) return

    for (const provider of ['bls', 'fred'] as const) {
      const group = waiting.filter((w) => w.rule.source!.provider === provider)
      if (!group.length) continue
      if (provider === 'bls' && !this.takeBlsCall()) {
        this.state.lastError = 'Kuota harian BLS habis — isi actual manual atau tambahkan BLS API key di Settings.'
        continue
      }
      for (const w of group) this.attempts.set(w.e.id, (this.attempts.get(w.e.id) ?? 0) + 1)
      try {
        const ids = [...new Set(group.map((w) => w.rule.source!.series))]
        const data = await this.series[provider].fetchSeries(ids)
        for (const { e, rule } of group) {
          const value = computeActual(data.get(rule.source!.series) ?? [], rule.source!, e.time)
          if (value === null) continue // not released yet; retry at the next offset
          const raw = formatLike(value, e.forecastRaw ?? e.previousRaw, rule.source!.decimals)
          const updated = this.repo.setActual(e.id, value, raw, provider, rule, cfg.cryptoBiasMode)
          if (!updated) continue
          log.info({ title: e.title, actual: value, forecast: e.forecast, usdBias: updated.usdBias, provider }, 'actual received')
          this.buildCandidates(updated)
          this.emit('changed')
        }
      } catch (err) {
        log.warn({ provider, err: (err as Error).message }, 'actual poll failed')
        this.state.lastError = `${provider.toUpperCase()}: ${(err as Error).message}`
      }
    }
  }

  private blsQuota(): { day: string; calls: number } {
    const today = new Date().toISOString().slice(0, 10)
    const q = readSetting(this.db, 'bls_quota', quotaSchema)
    return q && q.day === today ? q : { day: today, calls: 0 }
  }

  private takeBlsCall(): boolean {
    const q = this.blsQuota()
    const limit = this.deps.getBlsKey() ? BLS_DAILY_LIMIT_KEY : BLS_DAILY_LIMIT_NO_KEY
    if (q.calls >= limit - 1) return false // keep one spare for manual retries
    q.calls++
    writeSetting(this.db, 'bls_quota', q)
    this.state.blsCallsToday = q.calls
    return true
  }

  private symbols(cfg: NewsConfig): string[] {
    return [...new Set([...cfg.candidateSymbols, ...this.deps.getWatchlist()])]
  }

  /** Price change from the release minute to +N minutes, from stored 1m candles. */
  private computeReactions(cfg: NewsConfig): void {
    const now = Date.now()
    const events = this.repo
      .list(now - 2 * DAY, now)
      .filter((e) => cfg.currencies.includes(e.currency) && (cfg.impacts as string[]).includes(e.impact))
    let added = 0
    for (const e of events) {
      const start = Math.floor(e.time / MIN) * MIN
      for (const symbol of this.symbols(cfg)) {
        const sym = symbolByName(this.db, symbol)
        if (!sym) continue
        for (const h of cfg.reactionHorizonsMin) {
          if (now < start + (h + 1) * MIN || this.repo.hasReaction(e.id, symbol, h)) continue
          const rows = this.candles.range('1m', sym.id, start, start + h * MIN)
          const first = rows[0]
          const last = rows[rows.length - 1]
          if (!first || !last || first.t !== start || last.t !== start + (h - 1) * MIN) continue // data not there yet
          this.repo.addReaction({
            eventId: e.id,
            symbol,
            horizonMin: h,
            priceBefore: first.o,
            priceAfter: last.c,
            changePct: ((last.c - first.o) / first.o) * 100
          })
          added++
        }
      }
    }
    if (added) {
      log.info({ added }, 'price reactions recorded')
      this.emit('changed')
    }
  }

  /** USD bias + SMC context → candidates for BTC/ETH/watchlist (never orders). */
  private buildCandidates(e: EconomicEvent): void {
    const cfg = this.deps.getConfig()
    if (!e.cryptoBias || e.cryptoBias === 'neutral') return
    const dir: Dir = e.cryptoBias
    for (const symbol of this.symbols(cfg)) {
      if (this.repo.hasCandidate(e.id, symbol) || this.repo.hasCandidateForRelease(symbol, e.time, dir)) continue
      try {
        const ctx = this.smc.context(symbol, this.deps.getSmc())
        if (!ctx) continue
        const bull = dir === 'bullish'
        const poi = ctx.pois
          .filter((p) => p.direction === dir && (bull ? p.level <= ctx.price : p.level >= ctx.price))
          .sort((a, b) => Math.abs(a.level - ctx.price) - Math.abs(b.level - ctx.price))[0]
        const target = ctx.liquidity
          .filter((l) => (bull ? l.side === 'buy' && l.top > ctx.price : l.side === 'sell' && l.bottom < ctx.price))
          .map((l) => (bull ? l.top : l.bottom))
          .sort((a, b) => Math.abs(a - ctx.price) - Math.abs(b - ctx.price))[0]
        const setup = ctx.setups.find(
          (s) => s.direction === dir && (s.status === 'pending' || s.status === 'triggered') && s.createdT >= e.time - 4 * TF_MS['1h']
        )
        const aligned = ctx.trend['1h'] === dir || ctx.trend['15m'] === dir
        const reasons = [
          `${e.title}: ${e.biasReason ?? ''}`.trim(),
          `trend 4h ${ctx.trend['4h'] ?? '—'}, 1h ${ctx.trend['1h'] ?? '—'}, 15m ${ctx.trend['15m'] ?? '—'}${aligned ? ' (searah)' : ' (berlawanan → hati-hati)'}`,
          poi ? `POI terdekat: ${poi.kind} ${poi.timeframe} @ ${poi.level}` : 'tidak ada POI searah di dekat harga',
          target !== undefined ? `target liquidity: ${target}` : 'tidak ada target liquidity searah',
          setup ? `ada setup OB valid ${setup.direction} (RR ${setup.rr}, skor ${setup.score})` : 'belum ada OB valid — tunggu konfirmasi (Materi 3)'
        ]
        const c: NewsCandidate = {
          id: `${e.id}-${symbol}`,
          eventId: e.id,
          eventTitle: e.title,
          symbol,
          direction: dir,
          createdAt: Date.now(),
          price: ctx.price,
          trend: ctx.trend,
          poi: poi ? { kind: poi.kind, timeframe: poi.timeframe, level: poi.level } : null,
          target: target ?? null,
          setupId: setup?.id ?? null,
          aligned,
          reasons
        }
        this.repo.addCandidate(c)
        log.info({ symbol, event: e.title, direction: dir, aligned, setup: !!setup }, 'trade-on-news candidate')
        this.emit('candidate', c)
      } catch (err) {
        log.warn({ symbol, err: (err as Error).message }, 'candidate build failed')
      }
    }
  }

  private updateState(): void {
    const cfg = this.deps.getConfig()
    const now = Date.now()
    const events = this.repo.list(now - DAY, now + 8 * DAY)
    const next: NewsState = {
      ...this.state,
      nextEvent: nextEvent(events, cfg, now),
      window: cfg.enabled ? activeWindow(events, cfg, now) : null
    }
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next
      this.emit('state', next)
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
  }
}

function decimalsOf(raw: string | null): number {
  const m = raw?.match(/\.(\d+)/)
  return m ? m[1]!.length : 0
}
