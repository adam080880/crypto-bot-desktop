import { EventEmitter } from 'node:events'
import { Cron } from 'croner'
import { z } from 'zod'
import type { RadarConfig } from '@shared/config'
import type { RadarHit, RadarState } from '@shared/radar'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import type { SymbolRow } from '../db/symbolsRepo'
import { FlowRepo } from '../flow/flowRepo'
import { logger } from '../logger'
import { RADAR_BARS, radarCheck } from './radar'

const log = logger('radar')
const HOUR = 3_600_000
const KEEP_MS = 7 * 24 * HOUR
const SETTING = 'radar_state'

const stateSchema = z.object({ lastRunAt: z.number().nullable(), scanned: z.number(), hits: z.array(z.custom<RadarHit>((v) => typeof v === 'object' && v !== null)) })

interface Deps {
  getConfig: () => RadarConfig
  /** Symbols with local data (tracked by auto-sync), already filtered by the data config. */
  symbols: () => SymbolRow[]
  canRun: () => boolean
}

/**
 * Pump radar (docs/entry-v2.md §12) in the data worker. Every 15 minutes (:02:30 / :17:30 / …,
 * after the REST poll stored the last hour) each tracked coin's last closed 1h candle is checked;
 * a candle is only used once and only while it is the newest closed hour (no alerts on stale data).
 * New hits → 'hits' event (main sends them to Discord / desktop). Notify only, never orders.
 */
export class RadarService extends EventEmitter<{ hits: [RadarHit[]]; state: [RadarState] }> {
  private job: Cron | null = null
  private running = false
  private state: RadarState
  private readonly candles: CandleRepo
  private readonly flow: FlowRepo
  /** symbol → open time of the last 1h candle checked. */
  private readonly checked = new Map<string, number>()

  constructor(
    private readonly db: Db,
    private readonly deps: Deps
  ) {
    super()
    this.candles = new CandleRepo(db)
    this.flow = new FlowRepo(db)
    this.state = readSetting(db, SETTING, stateSchema) ?? { lastRunAt: null, scanned: 0, hits: [] }
  }

  getState(): RadarState {
    return this.state
  }

  start(): void {
    this.job ??= new Cron('30 2,17,32,47 * * * *', { timezone: 'UTC', protect: true }, () => void this.run())
  }

  dispose(): void {
    this.job?.stop()
    this.job = null
  }

  async run(now = Date.now()): Promise<RadarHit[]> {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled || this.running || !this.deps.canRun()) return []
    this.running = true
    try {
      const newest = Math.floor(now / HOUR) * HOUR - HOUR // open time of the last closed hour
      const last = new Map<string, number>()
      for (const h of this.state.hits) last.set(h.symbol, Math.max(last.get(h.symbol) ?? 0, h.t))
      const fresh: RadarHit[] = []
      let scanned = 0
      for (const s of this.deps.symbols()) {
        const c = this.candles.latest('1h', s.id, RADAR_BARS)
        const t = c.at(-1)?.t
        if (t !== newest || this.checked.get(s.symbol) === t) continue
        this.checked.set(s.symbol, t)
        scanned++
        const hit = radarCheck(s.symbol, c, this.flow.get(s.id).funding, cfg)
        if (hit && t - (last.get(s.symbol) ?? -Infinity) >= cfg.cooldownHours * HOUR) fresh.push(hit)
        if (scanned % 25 === 0) await new Promise((r) => setImmediate(r))
      }
      fresh.sort((a, b) => b.volRatio - a.volRatio)
      this.state = { lastRunAt: now, scanned, hits: [...fresh, ...this.state.hits].filter((h) => now - h.t <= KEEP_MS) }
      writeSetting(this.db, SETTING, this.state)
      if (scanned) log.info({ scanned, hits: fresh.length }, 'radar scan')
      if (fresh.length) this.emit('hits', fresh)
      this.emit('state', this.state)
      return fresh
    } catch (err) {
      log.error({ err: (err as Error).message }, 'radar scan failed')
      return []
    } finally {
      this.running = false
    }
  }
}
