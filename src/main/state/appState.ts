import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { appConfigSchema, defaultAppConfig, type AppConfig, type ConfigPatch } from '@shared/config'
import type { AppStatus } from '@shared/ipc'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { logger } from '../logger'

const log = logger('state')
const killSwitchSchema = z.object({ active: z.boolean(), at: z.number().nullable() })

/** Single source of truth for runtime status. Emits 'status' on every change. */
export class AppState extends EventEmitter<{ status: [AppStatus]; config: [AppConfig] }> {
  private config: AppConfig
  private status: AppStatus

  constructor(
    private readonly db: Db,
    meta: { dbPath: string; version: string }
  ) {
    super()
    this.config = readSetting(db, 'app_config', appConfigSchema) ?? defaultAppConfig
    // Kill switch persists across restarts: a halted bot stays halted until resumed manually.
    const kill = readSetting(db, 'kill_switch', killSwitchSchema) ?? { active: false, at: null }
    this.status = {
      mode: this.config.mode,
      connection: 'unknown',
      sync: { status: 'idle', upToDate: 0, total: 0 },
      live: { status: 'off', streams: 0, connections: 0, latencyMs: null },
      news: null,
      claude: null,
      killSwitch: kill,
      dbPath: meta.dbPath,
      version: meta.version
    }
  }

  getStatus(): AppStatus {
    return this.status
  }

  getConfig(): AppConfig {
    return this.config
  }

  /** Bot logic must check this before doing anything that could open a position. */
  isHalted(): boolean {
    return this.status.killSwitch.active
  }

  updateConfig(patch: ConfigPatch): AppConfig {
    const next = appConfigSchema.parse({
      ...this.config,
      ...patch,
      risk: { ...this.config.risk, ...(patch.risk ?? {}) },
      data: { ...this.config.data, ...(patch.data ?? {}) },
      smc: { ...this.config.smc, ...(patch.smc ?? {}) },
      news: { ...this.config.news, ...(patch.news ?? {}) },
      claude: { ...this.config.claude, ...(patch.claude ?? {}) },
      screener: { ...this.config.screener, ...(patch.screener ?? {}) },
      bot: { ...this.config.bot, ...(patch.bot ?? {}) },
      exit: { ...this.config.exit, ...(patch.exit ?? {}) }
    })
    if (next.bot.riskPerTradePct !== this.config.bot.riskPerTradePct)
      log.info({ from: this.config.bot.riskPerTradePct, to: next.bot.riskPerTradePct, patchKeys: Object.keys(patch.bot ?? {}) }, 'bot.riskPerTradePct changed')
    this.config = next
    writeSetting(this.db, 'app_config', next)
    this.patch({ mode: next.mode })
    this.emit('config', next)
    return next
  }

  /** Live trading switch; never reachable through updateConfig (patch schema omits it). */
  setBotLive(live: boolean): AppConfig {
    const next = appConfigSchema.parse({ ...this.config, bot: { ...this.config.bot, live } })
    this.config = next
    writeSetting(this.db, 'app_config', next)
    this.emit('config', next)
    return next
  }

  activateKillSwitch(): void {
    const kill = { active: true, at: Date.now() }
    writeSetting(this.db, 'kill_switch', kill)
    log.warn('KILL SWITCH ACTIVATED')
    this.patch({ killSwitch: kill })
  }

  resume(): void {
    const kill = { active: false, at: null }
    writeSetting(this.db, 'kill_switch', kill)
    log.info('bot resumed (kill switch cleared)')
    this.patch({ killSwitch: kill })
  }

  patch(partial: Partial<AppStatus>): void {
    this.status = { ...this.status, ...partial }
    this.emit('status', this.status)
  }
}
