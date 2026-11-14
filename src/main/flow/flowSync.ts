import { Cron } from 'croner'
import type { DataConfig } from '@shared/config'
import { isSymbolAllowed } from '@shared/config'
import { BinanceFuturesClient } from '../exchange/binanceFutures'
import type { Db } from '../db/client'
import type { SymbolRow } from '../db/symbolsRepo'
import { logger } from '../logger'
import { FUNDING_WINDOW } from '../strategy/flow'
import { FlowRepo } from './flowRepo'

const log = logger('flow-sync')
const HOUR = 3_600_000

/**
 * Keeps open interest (hourly) and funding of the tracked symbols current for the screener / bot
 * (docs/entry-v2.md §10). Runs in the data worker: 2 minutes after start, then every hour at :00:40,
 * so the screener scan at :01 already sees the snapshot of the hour (the backtest uses it at the
 * same moment); a snapshot published later is picked up by the next scan. Public endpoints, no key.
 * Limits: openInterestHist 1000 / 5 min / IP, fundingRate 500 / 5 min / IP → one call each per
 * symbol per hour, 4 at a time. Old rows are pruned (OI 3 days, funding 35 days).
 */
export class FlowSync {
  private job: Cron | null = null
  private startTimer: NodeJS.Timeout | null = null
  private running = false
  private readonly repo: FlowRepo
  private readonly client = new BinanceFuturesClient()
  lastRun: { at: number; symbols: number; errors: number; firstError: string | null } | null = null

  constructor(
    db: Db,
    private readonly deps: {
      symbols: () => SymbolRow[]
      getData: () => DataConfig
      /** Return false to skip (e.g. a manual backfill owns the network). */
      canRun: () => boolean
    }
  ) {
    this.repo = new FlowRepo(db)
  }

  start(): void {
    this.job = new Cron('40 0 * * * *', { timezone: 'UTC', protect: true }, () => void this.run())
    this.startTimer = setTimeout(() => void this.run(), 120_000)
  }

  async run(): Promise<void> {
    if (this.running || !this.deps.canRun()) return
    this.running = true
    const data = this.deps.getData()
    const list = this.deps.symbols().filter((s) => isSymbolAllowed(s.symbol, data))
    let errors = 0
    let firstError: string | null = null
    const now = Date.now()
    try {
      const queue = [...list]
      const worker = async (): Promise<void> => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          try {
            await this.syncOne(s, now)
          } catch (err) {
            errors++
            firstError ??= `${s.symbol}: ${(err as Error).message}`
          }
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker))
      const pruned = this.repo.prune(now)
      this.lastRun = { at: Date.now(), symbols: list.length, errors, firstError }
      log.info({ symbols: list.length, errors, firstError, pruned, ms: Date.now() - now }, 'flow sync done')
    } finally {
      this.running = false
    }
  }

  private async syncOne(s: SymbolRow, now: number): Promise<void> {
    // OI: what is missing since the last stored snapshot, at least the 28h the features look back
    const last = this.repo.lastOiT(s.id)
    const missing = last === null ? 30 : Math.ceil((now - last) / HOUR) + 1
    const oi = await this.client.openInterestHist(s.symbol, '1h', Math.min(30, Math.max(2, missing)))
    this.repo.saveOi(s.id, oi)
    // funding: full window once, then just the latest settlements
    const have = this.repo.fundingCount(s.id)
    const funding = await this.client.fundingRates(s.symbol, have >= FUNDING_WINDOW ? 3 : 100)
    this.repo.saveFunding(s.id, funding)
  }

  dispose(): void {
    this.job?.stop()
    if (this.startTimer) clearTimeout(this.startTimer)
  }
}
