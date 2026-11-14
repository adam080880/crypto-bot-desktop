import { EventEmitter } from 'node:events'
import { Cron } from 'croner'
import { z } from 'zod'
import { isSymbolAllowed, type DataConfig } from '@shared/config'
import { rotationConfigSchema, type RotationCommand, type RotationState } from '@shared/rotation'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { logger } from '../logger'
import { isCryptoPerp, type BinanceTradeClient } from '../bot/binanceTrade'
import { emptyState, mark, nextRebalanceAt, rankUniverse, rebalance, targets, type CoinDaily } from './paper'

const log = logger('rotation')
const DAY = 86_400_000
const SETTING = 'rotation_state'
const CRYPTO_MS = 6 * 3_600_000

// stored state: validated loosely (it is our own JSON), config strictly
const stateSchema = z.object({ config: rotationConfigSchema }).passthrough()

/**
 * Paper forward test of the momentum rotation (docs/entry-v2.md §11). Runs in the data worker,
 * reads stored 1d candles (kept current by AutoSync) and funding (FlowSync). Never sends orders.
 * Every 15 minutes it checks whether a new daily close is stored for BTC; then it marks the paper
 * positions to that close, books funding, and rebalances when the weekly moment has passed.
 */
export class RotationService extends EventEmitter<{ state: [RotationState] }> {
  private state: RotationState
  private job: Cron | null = null
  private busy = false
  private crypto: { at: number; set: Set<string> } | null = null

  constructor(
    private readonly db: Db,
    private readonly deps: {
      market: Pick<BinanceTradeClient, 'exchangeSymbols'>
      getData: () => DataConfig
      canRun: () => boolean
    }
  ) {
    super()
    const saved = readSetting(db, SETTING, stateSchema) as RotationState | null
    this.state = saved ?? emptyState(rotationConfigSchema.parse({}))
  }

  getState(): RotationState {
    return this.state
  }

  start(): void {
    this.job = new Cron('0 */15 * * * *', { timezone: 'UTC', protect: true }, () => void this.tick())
    setTimeout(() => void this.tick(), 150_000).unref?.()
  }

  async command(c: RotationCommand): Promise<void> {
    if (c.cmd === 'start') {
      // a fresh forward test from the latest close (config is fixed for the run)
      this.set({ ...emptyState(c.config), running: true, startedAt: Date.now(), ranking: this.state.ranking })
      await this.tick(true)
    } else if (c.cmd === 'stop') this.set({ ...this.state, running: false, nextRebalanceAt: null })
    else if (c.cmd === 'reset') this.set(emptyState(this.state.config))
    else await this.tick(false, true)
  }

  private set(s: RotationState): void {
    this.state = s
    writeSetting(this.db, SETTING, s)
    this.emit('state', s)
  }

  private async cryptoSet(): Promise<Set<string> | null> {
    if (this.crypto && Date.now() - this.crypto.at < CRYPTO_MS) return this.crypto.set
    try {
      const ex = await this.deps.market.exchangeSymbols()
      this.crypto = { at: Date.now(), set: new Set(ex.filter(isCryptoPerp).map((s) => s.symbol)) }
      return this.crypto.set
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'exchangeInfo failed')
      return this.crypto?.set ?? null
    }
  }

  /** Daily closes of every crypto perpetual for the window the ranking needs. */
  private loadCoins(fromDay: number, crypto: Set<string>): CoinDaily[] {
    const data = this.deps.getData()
    const rows = this.db.$client
      .prepare(
        `SELECT s.symbol AS symbol, c.open_time AS t, c.close AS c, c.volume AS v
         FROM candles_1d c JOIN symbols s ON s.id = c.symbol_id
         WHERE c.open_time >= ? ORDER BY c.symbol_id, c.open_time`
      )
      .all(fromDay * DAY) as { symbol: string; t: number; c: number; v: number }[]
    const first = new Map(
      (this.db.$client.prepare('SELECT s.symbol AS symbol, min(c.open_time) AS t FROM candles_1d c JOIN symbols s ON s.id = c.symbol_id GROUP BY c.symbol_id').all() as { symbol: string; t: number }[]).map(
        (r) => [r.symbol, Math.floor(r.t / DAY)]
      )
    )
    const by = new Map<string, CoinDaily & { close: Map<number, number>; qv: Map<number, number> }>()
    for (const r of rows) {
      if (!crypto.has(r.symbol) || !isSymbolAllowed(r.symbol, data)) continue
      let x = by.get(r.symbol)
      if (!x) by.set(r.symbol, (x = { symbol: r.symbol, firstDay: first.get(r.symbol) ?? 0, close: new Map(), qv: new Map() }))
      const d = Math.floor(r.t / DAY)
      x.close.set(d, r.c)
      x.qv.set(d, r.v * r.c)
    }
    return [...by.values()]
  }

  /** Sum of funding rates settled in (fromT, toT] per symbol. */
  private fundingSum(symbols: string[], fromT: number, toT: number): Map<string, number> {
    const out = new Map<string, number>()
    if (!symbols.length) return out
    try {
      const rows = this.db.$client
        .prepare(
          `SELECT s.symbol AS symbol, sum(f.rate) AS r FROM flow_funding f JOIN symbols s ON s.id = f.symbol_id
           WHERE f.t > ? AND f.t <= ? AND s.symbol IN (${symbols.map(() => '?').join(',')}) GROUP BY s.symbol`
        )
        .all(fromT, toT, ...symbols) as { symbol: string; r: number }[]
      for (const r of rows) out.set(r.symbol, r.r)
    } catch {
      // flow tables missing (old DB): no funding
    }
    return out
  }

  /** Process the latest stored daily close (mark, then rebalance when due). */
  async tick(forceRebalance = false, rankOnly = false): Promise<void> {
    if (this.busy || (!this.deps.canRun() && !forceRebalance && !rankOnly)) return
    this.busy = true
    try {
      const btcLast = this.db.$client
        .prepare(`SELECT max(c.open_time) FROM candles_1d c JOIN symbols s ON s.id = c.symbol_id WHERE s.symbol = 'BTCUSDT'`)
        .pluck()
        .get() as number | null
      if (!btcLast) return void this.set({ ...this.state, lastError: 'belum ada candle 1d BTC di DB' })
      // the newest stored daily candle is closed (candles are stored only after they close)
      const day = Math.floor(btcLast / DAY)
      const s0 = this.state
      const cfg = s0.config
      const crypto = await this.cryptoSet()
      if (!crypto) return void this.set({ ...s0, lastError: 'daftar koin crypto (exchangeInfo) belum bisa diambil' })
      const coins = this.loadCoins(day - Math.max(cfg.lookbackDays, 31) - 2, crypto)
      const rows = rankUniverse(coins, day, cfg)
      let s: RotationState = { ...s0, ranking: { t: day * DAY, rows }, lastError: null }
      if (rankOnly || !s.running) return void this.set(s)

      const byName = new Map(coins.map((c) => [c.symbol, c]))
      const price = (sym: string): number | undefined => byName.get(sym)?.close.get(day)
      const btc = price('BTCUSDT') ?? null
      if (s.lastDay === null || day > s.lastDay) {
        const fromT = s.lastDay === null ? (day + 1) * DAY : (s.lastDay + 1) * DAY
        const fund = this.fundingSum(
          s.positions.map((p) => p.symbol),
          fromT,
          (day + 1) * DAY
        )
        s = mark(s, day, price, (sym) => fund.get(sym) ?? 0, btc)
      }
      // a scheduled rebalance waits until yesterday's close is stored (AutoSync may still be fetching it)
      const fresh = day >= Math.floor(Date.now() / DAY) - 1
      const due = forceRebalance || s.positions.length === 0 || (fresh && s.nextRebalanceAt !== null && Date.now() >= s.nextRebalanceAt)
      if (due && rows.length) {
        s = rebalance(s, day, targets(rows, cfg), price)
        log.info({ day: new Date(day * DAY).toISOString().slice(0, 10), equity: s.equity, longs: s.rebalances.at(-1)?.longs, shorts: s.rebalances.at(-1)?.shorts }, 'rotation rebalanced (paper)')
      }
      if (due || s.nextRebalanceAt === null) s = { ...s, nextRebalanceAt: nextRebalanceAt(Date.now(), cfg.rebalanceWeekday) }
      this.set(s)
    } catch (err) {
      log.error({ err: (err as Error).message }, 'rotation tick failed')
      this.set({ ...this.state, lastError: (err as Error).message })
    } finally {
      this.busy = false
    }
  }

  dispose(): void {
    this.job?.stop()
  }
}
