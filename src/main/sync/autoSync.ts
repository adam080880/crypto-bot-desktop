import { Cron } from 'croner'
import type { DataConfig } from '@shared/config'
import type { AutoSyncState } from '@shared/sync'
import { TF_MS } from '@shared/timeframes'
import type { Db } from '../db/client'
import { logger } from '../logger'
import type { Backfiller } from './backfill'

const log = logger('auto-sync')
const MIN = TF_MS['1m']

/**
 * Keeps tracked symbols current: a catch-up run at start (e.g. after the PC was off),
 * then REST catch-ups every `restPollMinutes` for symbols that aren't streamed live
 * (live ones only refresh 1d/1w), plus a daily retention prune.
 */
export class AutoSync {
  private job: Cron | null = null
  private pruneJob: Cron | null = null
  private ctrl: AbortController | null = null
  private state: AutoSyncState = {
    enabled: false,
    running: false,
    upToDate: 0,
    total: 0,
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    reachable: null,
    fullBackfillDone: false
  }

  constructor(
    private readonly db: Db,
    private readonly backfiller: Backfiller,
    private readonly getData: () => DataConfig,
    private readonly getExtraSymbols: () => readonly string[],
    private readonly getLiveSymbols: () => ReadonlySet<string>,
    private readonly onState: (s: AutoSyncState) => void,
    /** Return false to skip a tick (e.g. a manual backfill is running). */
    private readonly canRun: () => boolean
  ) {}

  start(): void {
    this.configure()
    void this.tick('startup')
  }

  /** (Re)apply schedule from config. */
  configure(): void {
    const data = this.getData()
    this.job?.stop()
    this.pruneJob?.stop()
    this.job = null
    this.pruneJob = null
    this.state.enabled = data.autoSync
    if (data.autoSync) {
      // second 7 to land after the minute's candle has closed on Binance's side
      this.job = new Cron(`7 */${data.restPollMinutes} * * * *`, { timezone: 'UTC', protect: true }, () => this.tick('schedule'))
      this.pruneJob = new Cron('0 20 0 * * *', { timezone: 'UTC', protect: true }, () => {
        this.backfiller.pruneRetention(this.getData())
      })
    }
    this.state.nextRunAt = this.job?.nextRun()?.getTime() ?? null
    this.refreshCounts()
  }

  /** Abort an in-flight catch-up (it's resumable). */
  abort(): void {
    this.ctrl?.abort(new Error('preempted'))
  }

  async tick(reason: 'startup' | 'schedule' | 'manual'): Promise<void> {
    const data = this.getData()
    if (!data.autoSync && reason !== 'manual') return
    if (this.state.running || !this.canRun()) return
    const tracked = this.backfiller.trackedSymbols(this.getExtraSymbols())
    if (!tracked.length) {
      this.refreshCounts()
      return
    }
    this.ctrl = new AbortController()
    this.patch({ running: true, lastError: null })
    try {
      const live = this.getLiveSymbols()
      const summary = await this.backfiller.run({
        kind: 'catchup',
        symbols: tracked.map((s) => s.symbol),
        sourcesFor: (s) => (live.has(s) ? ['1d', '1w'] : ['1m', '1d', '1w']),
        data,
        signal: this.ctrl.signal
      })
      const failedAll = summary.symbols > 0 && summary.errors.length === summary.symbols
      this.patch({
        lastRunAt: Date.now(),
        reachable: !failedAll,
        lastError: summary.errors[0] ? `${summary.errors.length} simbol gagal: ${summary.errors[0].error}` : null
      })
      log.info({ reason, symbols: summary.symbols, errors: summary.errors.length }, 'catch-up done')
    } catch (err) {
      log.error({ err: (err as Error).message }, 'catch-up failed')
      this.patch({ lastRunAt: Date.now(), reachable: false, lastError: (err as Error).message })
    } finally {
      this.ctrl = null
      this.state.nextRunAt = this.job?.nextRun()?.getTime() ?? null
      this.patch({ running: false })
      this.refreshCounts()
    }
  }

  /** Count tracked symbols whose 1m data is current (within one poll interval). */
  refreshCounts(): void {
    const data = this.getData()
    const tracked = this.backfiller.trackedSymbols(this.getExtraSymbols())
    const ids = new Set(tracked.map((s) => s.id))
    const fresh = Math.floor(Date.now() / MIN) * MIN - (data.restPollMinutes + 2) * MIN
    const rows = this.db.$client
      .prepare(`SELECT symbol_id AS id, last_open_time AS last FROM sync_state WHERE timeframe = '1m'`)
      .all() as { id: number; last: number | null }[]
    const upToDate = rows.filter((r) => ids.has(r.id) && (r.last ?? 0) >= fresh).length
    this.patch({ upToDate, total: tracked.length, fullBackfillDone: this.backfiller.isFullBackfillDone() })
  }

  getState(): AutoSyncState {
    return this.state
  }

  private patch(p: Partial<AutoSyncState>): void {
    this.state = { ...this.state, ...p }
    this.onState(this.state)
  }

  dispose(): void {
    this.abort()
    this.job?.stop()
    this.pruneJob?.stop()
  }
}
