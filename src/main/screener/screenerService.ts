import { EventEmitter } from 'node:events'
import { Cron } from 'croner'
import { z } from 'zod'
import { isSymbolAllowed, type DataConfig, type ExitConfig, type ScreenerConfig, type SmcConfig } from '@shared/config'
import type { ScreenerRow, ScreenerRun, ScreenerState, ScreenerTrigger } from '@shared/screener'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { logger } from '../logger'
import { SmcService } from '../strategy/service'
import { rankRows, screenSymbol } from './screen'

const log = logger('screener')
const SETTING = 'screener_last'
const STARTUP_DELAY_MS = 90_000 // let the startup catch-up refresh the data first
const PROGRESS_MS = 500

const persistedSchema = z.object({
  lastRun: z.custom<ScreenerRun>((v) => typeof v === 'object' && v !== null),
  rows: z.array(z.custom<ScreenerRow>((v) => typeof v === 'object' && v !== null))
})

/**
 * Scans every synced symbol with the same SMC detectors as the chart (`SmcService.context`).
 * Runs in the data worker and yields between symbols so live WebSocket ingest keeps flowing.
 */
export class ScreenerService extends EventEmitter<{ state: [ScreenerState] }> {
  private readonly smc: SmcService
  private job: Cron | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private state: ScreenerState

  constructor(
    private readonly db: Db,
    private readonly deps: {
      getConfig: () => ScreenerConfig
      getSmc: () => SmcConfig
      getExit?: () => ExitConfig
      getData: () => DataConfig
      /** Return false to skip automatic scans (e.g. a manual backfill is writing). */
      canAutoRun: () => boolean
    }
  ) {
    super()
    this.smc = new SmcService(db)
    const last = readSetting(db, SETTING, persistedSchema)
    this.state = { running: false, progress: null, lastRun: last?.lastRun ?? null, rows: last?.rows ?? [], lastError: null }
  }

  getState(): ScreenerState {
    return this.state
  }

  start(): void {
    this.configure()
    if (this.deps.getConfig().autoScan) this.startupTimer = setTimeout(() => void this.run('startup'), STARTUP_DELAY_MS)
  }

  configure(): void {
    this.job?.stop()
    this.job = null
    // one minute after each 15m close (entry timeframe of the setups)
    if (this.deps.getConfig().autoScan)
      this.job = new Cron('0 1,16,31,46 * * * *', { timezone: 'UTC', protect: true }, () => void this.run('auto'))
  }

  /** Symbols with local 1m history that pass the data filter. */
  private symbols(): string[] {
    const rows = this.db.$client
      .prepare(
        `SELECT s.symbol FROM symbols s JOIN sync_state ss ON ss.symbol_id = s.id AND ss.timeframe = '1m'
         WHERE s.is_active = 1 ORDER BY s.symbol`
      )
      .pluck()
      .all() as string[]
    const data = this.deps.getData()
    return rows.filter((s) => isSymbolAllowed(s, data))
  }

  private emitState(patch: Partial<ScreenerState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  async run(trigger: ScreenerTrigger): Promise<void> {
    if (this.state.running) return
    if (trigger !== 'manual' && !this.deps.canAutoRun()) {
      log.info({ trigger }, 'scan skipped: backfill running')
      return
    }
    const cfg = this.deps.getConfig()
    const smcCfg = this.deps.getSmc()
    const startedAt = Date.now()
    let list: string[]
    try {
      list = this.symbols()
    } catch (err) {
      this.emitState({ lastError: (err as Error).message })
      return
    }
    this.emitState({ running: true, progress: { done: 0, total: list.length }, lastError: null })

    const rows: ScreenerRow[] = []
    let stale = 0
    let errors = 0
    let lastProgress = 0
    for (let i = 0; i < list.length; i++) {
      const symbol = list[i]!
      try {
        const now = Date.now()
        const ctx = this.smc.context(symbol, smcCfg, now, this.deps.getExit?.())
        if (!ctx || now - ctx.priceT > cfg.maxDataAgeMin * 60_000) stale++
        else rows.push(...screenSymbol({ symbol, ...ctx }, cfg, now))
      } catch (err) {
        errors++
        log.warn({ symbol, err: (err as Error).message }, 'screen failed')
      }
      // yield so WebSocket messages and IPC are not starved during a long scan
      await new Promise((r) => setImmediate(r))
      if (Date.now() - lastProgress > PROGRESS_MS) {
        lastProgress = Date.now()
        this.emitState({ progress: { done: i + 1, total: list.length } })
      }
    }

    const lastRun: ScreenerRun = { trigger, startedAt, finishedAt: Date.now(), scanned: list.length, stale, errors }
    const ranked = rankRows(rows)
    try {
      writeSetting(this.db, SETTING, { lastRun, rows: ranked })
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not persist screener result')
    }
    log.info({ trigger, scanned: list.length, rows: ranked.length, stale, errors, ms: lastRun.finishedAt - startedAt }, 'scan done')
    this.emitState({ running: false, progress: null, lastRun, rows: ranked })
  }

  dispose(): void {
    this.job?.stop()
    if (this.startupTimer) clearTimeout(this.startupTimer)
  }
}
