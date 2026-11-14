import { EventEmitter } from 'node:events'
import type { DataConfig } from '@shared/config'
import type { LiveCandleEvent, LiveState, LiveStatus } from '@shared/live'
import { bucketOpen } from '@shared/timeframes'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { activeSymbols } from '../db/symbolsRepo'
import { logger } from '../logger'
import type { Backfiller } from '../sync/backfill'
import { FormingCandles } from './formingCandles'
import { KlineSocketPool, type KlineMessage } from './klineSocket'

const log = logger('live')
const UI_THROTTLE_MS = 250 // ≈ 4 updates/s to the renderer
const LATENCY_DELAYED_MS = 5_000

export interface LiveSources {
  chart: string | null
  watchlist: readonly string[]
  positions: readonly string[]
  /** Bot universe + symbols with bot orders (Fase 7). */
  bot: readonly string[]
}

/**
 * Streams 1m klines for the open chart, watchlist and open positions.
 * Closed candles go to the DB (via Backfiller.ingestClosed1m, which fills holes first);
 * the chart symbol additionally gets throttled forming 1m…4h candles for the UI.
 */
export class LiveService extends EventEmitter<{
  candle: [LiveCandleEvent]
  /** Every 1m kline message (forming or closed) of every streamed symbol. */
  kline: [KlineMessage]
  state: [LiveState]
  synced: [string]
}> {
  private sources: LiveSources = { chart: null, watchlist: [], positions: [], bot: [] }
  private readonly pool: KlineSocketPool
  private readonly repo: CandleRepo
  private forming: FormingCandles | null = null
  private formingSymbol: string | null = null
  private lastSent = 0
  private pending: LiveCandleEvent | null = null
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private lastState: LiveState = { status: 'off', streams: 0, connections: 0, latencyMs: null }
  private live = new Set<string>()

  constructor(
    private readonly db: Db,
    private readonly backfiller: Backfiller,
    private readonly getData: () => DataConfig
  ) {
    super()
    this.repo = new CandleRepo(db)
    this.pool = new KlineSocketPool({
      kline: (k) => this.onKline(k),
      reconnected: (symbols) => void this.onReconnected(symbols),
      state: () => this.publishState()
    })
  }

  /** Symbols currently streamed (REST polling can skip their 1m). */
  liveSymbols(): ReadonlySet<string> {
    return this.live
  }

  setSources(patch: Partial<LiveSources>): void {
    const prevChart = this.sources.chart
    this.sources = { ...this.sources, ...patch }
    const allowed = new Set(activeSymbols(this.db).map((s) => s.symbol))
    const wanted = [...new Set([this.sources.chart, ...this.sources.watchlist, ...this.sources.positions, ...this.sources.bot])].filter(
      (s): s is string => !!s && allowed.has(s)
    )
    this.live = new Set(wanted)
    this.pool.setSymbols([...this.live], this.getData().streamsPerConnection)
    if (this.sources.chart !== prevChart) void this.prepareChart(this.sources.chart)
    // make sure every streamed symbol has history (no-op when already up to date)
    for (const s of this.live) if (s !== this.sources.chart) void this.ensureSynced(s)
  }

  private async ensureSynced(symbol: string): Promise<void> {
    try {
      await this.backfiller.catchUp1m(symbol, this.getData())
    } catch (err) {
      log.warn({ symbol, err: (err as Error).message }, 'catch-up failed')
    }
  }

  /** Catch the chart symbol up, then seed forming candles from the current 4h bucket. */
  private async prepareChart(symbol: string | null): Promise<void> {
    this.forming = null
    this.formingSymbol = symbol
    if (!symbol) return
    await this.ensureSynced(symbol)
    if (this.formingSymbol !== symbol) return // user switched meanwhile
    const sym = this.db.$client.prepare(`SELECT id FROM symbols WHERE symbol = ?`).get(symbol) as { id: number } | undefined
    const f = new FormingCandles()
    if (sym) {
      const now = Date.now()
      f.seed(this.repo.range('1m', sym.id, bucketOpen(now, '4h'), now))
    }
    this.forming = f
    this.emit('synced', symbol)
  }

  private onKline(k: KlineMessage): void {
    this.emit('kline', k)
    if (k.closed) {
      this.backfiller
        .ingestClosed1m(k.symbol, k.candle, this.getData())
        .then((r) => {
          if (r === 'gap-filled') log.info({ symbol: k.symbol }, 'filled gap before live candle')
        })
        .catch((err) => log.error({ symbol: k.symbol, err: (err as Error).message }, 'ingest failed'))
    }
    if (k.symbol !== this.formingSymbol || !this.forming) return
    const candles = this.forming.update(k.candle, k.closed)
    const event: LiveCandleEvent = { symbol: k.symbol, eventTime: k.eventTime, closed: k.closed, candles }
    if (k.closed) return this.flush(event) // never drop a close
    this.pending = event
    const wait = UI_THROTTLE_MS - (Date.now() - this.lastSent)
    if (wait <= 0) this.flush()
    else this.sendTimer ??= setTimeout(() => this.flush(), wait)
  }

  private flush(event = this.pending): void {
    if (this.sendTimer) clearTimeout(this.sendTimer)
    this.sendTimer = null
    this.pending = null
    if (!event) return
    this.lastSent = Date.now()
    this.emit('candle', event)
  }

  /** After a reconnect: fill the hole via REST before trusting the stream again. */
  private async onReconnected(symbols: string[]): Promise<void> {
    log.info({ count: symbols.length }, 'reconnected; filling gaps via REST')
    for (const s of symbols) await this.ensureSynced(s)
    if (this.formingSymbol && symbols.includes(this.formingSymbol)) void this.prepareChart(this.formingSymbol)
  }

  private publishState(): void {
    const snap = this.pool.snapshot()
    let status: LiveStatus
    if (!snap.streams) status = 'off'
    else if (snap.states.includes('reconnecting')) status = 'reconnecting'
    else if (snap.states.includes('connecting')) status = 'connecting'
    else if (snap.silentMs > this.pool.delayedThresholdMs || snap.latencyMs > LATENCY_DELAYED_MS) status = 'delayed'
    else status = 'connected'
    const next: LiveState = {
      status,
      streams: snap.streams,
      connections: snap.connections,
      latencyMs: snap.connections ? Math.round(snap.latencyMs) : null
    }
    const prev = this.lastState
    const latencyJump = Math.abs((next.latencyMs ?? 0) - (prev.latencyMs ?? 0)) > 250
    if (prev.status !== next.status || prev.streams !== next.streams || prev.connections !== next.connections || latencyJump) {
      this.lastState = next
      this.emit('state', next)
    }
  }

  getState(): LiveState {
    return this.lastState
  }

  dispose(): void {
    this.pool.dispose()
    if (this.sendTimer) clearTimeout(this.sendTimer)
  }
}
