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
const FIVE_MIN = 5 * 60_000
const HOUR = 3_600_000

/**
 * Keeps open interest (5-minute snapshots) and funding of the tracked symbols current for the
 * screener / bot (docs/entry-v2.md §10). Runs in the data worker: 2 minutes after start, then every
 * 15 minutes at :00:40 / :15:40 / :30:40 / :45:40, so each screener scan (:01 / :16 / …) already sees
 * the snapshot of its candle close, like the backtest; one published later is picked up next scan.
 * Public endpoints, no key. Limits: openInterestHist 1000 / 5 min / IP (one call per symbol per run),
 * fundingRate 500 / 5 min / IP (once an hour). 4 at a time. Pruned: OI after 3 days, funding after 35.
 */
export class FlowSync {
  private job: Cron | null = null
  private startTimer: NodeJS.Timeout | null = null
  private running = false
  private readonly repo: FlowRepo
  private readonly client = new BinanceFuturesClient()
  lastRun: { at: number; symbols: number; errors: number; firstError: string | null } | null = null
  private lastFundingAt = 0

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
    this.job = new Cron('40 0,15,30,45 * * * *', { timezone: 'UTC', protect: true }, () => void this.run())
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
    // funding settles every 1–8h: once an hour is enough
    const withFunding = now - this.lastFundingAt >= HOUR - 5 * 60_000
    try {
      const queue = [...list]
      const worker = async (): Promise<void> => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          try {
            await this.syncOne(s, now, withFunding)
          } catch (err) {
            errors++
            firstError ??= `${s.symbol}: ${(err as Error).message}`
          }
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker))
      if (withFunding) this.lastFundingAt = now
      const pruned = this.repo.prune(now)
      this.lastRun = { at: Date.now(), symbols: list.length, errors, firstError }
      log.info({ symbols: list.length, errors, firstError, pruned, ms: Date.now() - now }, 'flow sync done')
    } finally {
      this.running = false
    }
  }

  private async syncOne(s: SymbolRow, now: number, withFunding: boolean): Promise<void> {
    // OI: what is missing since the last snapshot; first time ≥ the 24h + 4h the features look back
    const last = this.repo.lastOiT(s.id)
    const missing = last === null ? 400 : Math.ceil((now - last) / FIVE_MIN) + 1
    const oi = await this.client.openInterestHist(s.symbol, '5m', Math.min(500, Math.max(2, missing)))
    this.repo.saveOi(s.id, oi)
    // funding: full window once, then just the latest settlements
    const have = this.repo.fundingCount(s.id)
    if (!withFunding && have >= FUNDING_WINDOW) return
    const funding = await this.client.fundingRates(s.symbol, have >= FUNDING_WINDOW ? 3 : 100)
    this.repo.saveFunding(s.id, funding)
  }

  dispose(): void {
    this.job?.stop()
    if (this.startTimer) clearTimeout(this.startTimer)
  }
}
