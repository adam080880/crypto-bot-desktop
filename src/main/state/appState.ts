import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { appConfigSchema, defaultAppConfig, modelConfluenceSchema, RECOMMENDED_MODEL_CONFLUENCE, RECOMMENDED_MODEL_CONFLUENCE_ANY, type AppConfig, type ConfigPatch, type ModelConfluence } from '@shared/config'
import { REQUIRABLE_CONFLUENCES } from '@shared/smc'
import type { AppStatus } from '@shared/ipc'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { logger } from '../logger'

const log = logger('state')
const killSwitchSchema = z.object({ active: z.boolean(), at: z.number().nullable() })
const confs = z.array(z.string()).optional()
const legacyBotConfSchema = z.object({ bot: z.object({ requireConfluence: confs, trendRequireConfluence: confs, modelConfluence: z.unknown().optional() }).optional() })

/**
 * Old configs: `requireConfluence` (M0–M4) + `trendRequireConfluence` (M5), M6 none. Configs without
 * those keys keep the new defaults. `addPdZone` = the 2026-11-16 pdZone migration never ran.
 */
export function migrateModelConfluence(legacy: z.infer<typeof legacyBotConfSchema>['bot'], addPdZone = false): ModelConfluence {
  const out: ModelConfluence = { ...RECOMMENDED_MODEL_CONFLUENCE }
  if (!legacy || legacy.modelConfluence) return modelConfluenceSchema.parse(legacy?.modelConfluence ?? out)
  const valid = (xs: string[]): ModelConfluence['M0'] => xs.filter((x): x is ModelConfluence['M0'][number] => (REQUIRABLE_CONFLUENCES as readonly string[]).includes(x))
  if (legacy.requireConfluence) {
    const smc = valid(addPdZone && !legacy.requireConfluence.includes('pdZone') ? [...legacy.requireConfluence, 'pdZone'] : legacy.requireConfluence)
    for (const m of ['M0', 'M1', 'M2a', 'M2b', 'M4'] as const) out[m] = smc
  }
  if (legacy.trendRequireConfluence) out.M5 = valid(legacy.trendRequireConfluence)
  if (legacy.requireConfluence || legacy.trendRequireConfluence) out.M6 = []
  return out
}

/** Single source of truth for runtime status. Emits 'status' on every change. */
export class AppState extends EventEmitter<{ status: [AppStatus]; config: [AppConfig] }> {
  private config: AppConfig
  private status: AppStatus

  constructor(
    private readonly db: Db,
    meta: { dbPath: string; version: string }
  ) {
    super()
    // read before any migration below rewrites the stored config (parsing drops the old keys)
    const legacyBot = readSetting(db, 'app_config', legacyBotConfSchema)?.bot
    this.config = readSetting(db, 'app_config', appConfigSchema) ?? defaultAppConfig
    // smc.models has no UI: configs saved before M5 existed get the new model detected (the bot still
    // only trades what bot.models allows)
    for (const m of ['M5', 'M6', 'M7', 'M8', 'M9', 'M10'] as const)
      if (!this.config.smc.models.includes(m)) this.config = { ...this.config, smc: { ...this.config.smc, models: [...this.config.smc.models, m] } }
    // M9 (user, 2026-11-23) is forward-tested as shadow paper next to M8, once; removing it later sticks
    if (!readSetting(db, 'migr_shadow_m9', z.boolean())) {
      if (!this.config.bot.shadowModels.includes('M9')) this.config = { ...this.config, bot: { ...this.config.bot, shadowModels: [...this.config.bot.shadowModels, 'M9'] } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_shadow_m9', true)
    }
    // M6 (user, 2026-11-15) joins the bot's models once; removing it later in Settings sticks
    if (!readSetting(db, 'migr_bot_m6', z.boolean())) {
      if (!this.config.bot.models.includes('M6')) this.config = { ...this.config, bot: { ...this.config.bot, models: [...this.config.bot.models, 'M6'] } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_bot_m6', true)
    }
    // per-model confluence lists (user, 2026-11-19) replace the shared SMC list + the M5 list: copy the old
    // lists once so the bot behaves the same until the user changes them
    if (!readSetting(db, 'migr_bot_model_conf', z.boolean())) {
      if (legacyBot) this.config = { ...this.config, bot: { ...this.config.bot, modelConfluence: migrateModelConfluence(legacyBot, !readSetting(db, 'migr_bot_pdzone', z.boolean())) } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_bot_model_conf', true)
    }
    // user 2026-11-20: plain HTF OCL is no longer a POI, the HTF OCL Break is (M0 too); once, so later
    // Settings changes stick
    if (!readSetting(db, 'migr_ocl_break_htf', z.boolean())) {
      this.config = { ...this.config, smc: { ...this.config.smc, oclParentTimeframes: [], m0OclBreakTimeframes: ['4h', '1d', '1w'] } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_ocl_break_htf', true)
    }
    // user 2026-11-22: liquidity tags from the lab join the per-model required lists once (later Settings changes stick)
    if (!readSetting(db, 'migr_liq_tags', z.boolean())) {
      const add: Partial<Record<keyof ModelConfluence, ModelConfluence[keyof ModelConfluence]>> = { M0: ['cleanApproach'], M1: ['liqHtfBehind'], M7: ['liqHtfBehind'] }
      const mc = { ...this.config.bot.modelConfluence }
      for (const [m, tags] of Object.entries(add) as [keyof ModelConfluence, ModelConfluence[keyof ModelConfluence]][])
        mc[m] = [...new Set([...(mc[m] ?? []), ...tags])]
      this.config = { ...this.config, bot: { ...this.config.bot, modelConfluence: mc } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_liq_tags', true)
    }
    // user 2026-11-23 ("yang bagus langsung jalanin"): inducement/exit lab (100 coins, IS and OOS positive), once:
    // SMC exit without a TP (tiered + order flow + trailing), M4 on that exit too (breakerTpR 0), M8 TP 3R,
    // M0 + baitTaken, M4 fvg + slLiqClear + cleanApproach, M9 + cleanApproach (shadow). Later Settings changes stick.
    if (!readSetting(db, 'migr_lab_1123', z.boolean())) {
      const mc = { ...this.config.bot.modelConfluence }
      mc.M0 = [...new Set([...(mc.M0 ?? []), 'baitTaken' as const])]
      mc.M4 = ['fvg', 'slLiqClear', 'cleanApproach']
      mc.M9 = [...new Set([...(mc.M9 ?? []), 'cleanApproach' as const])]
      this.config = {
        ...this.config,
        exit: { ...this.config.exit, tpMode: 'trail' },
        smc: { ...this.config.smc, breakerTpR: 0, m8TpR: 3 },
        bot: { ...this.config.bot, modelConfluence: mc }
      }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_lab_1123', true)
    }
    // user 2026-11-23: M9's POI behind the bait is an order block (OB/QM), not RBS/SBR; once, later Settings changes stick
    if (!readSetting(db, 'migr_m9_ob', z.boolean())) {
      this.config = { ...this.config, smc: { ...this.config.smc, m9Kinds: ['OB', 'QM'] } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_m9_ob', true)
    }
    // user 2026-11-23 ("cari kombinasi terbaik mode or"): OR lists from the OR lab, once (later Settings changes stick)
    if (!readSetting(db, 'migr_or_1123', z.boolean())) {
      this.config = { ...this.config, bot: { ...this.config.bot, modelConfluenceAny: structuredClone(RECOMMENDED_MODEL_CONFLUENCE_ANY) } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_or_1123', true)
    }
    // M10 (user 2026-11-23, QM confirmation) gets its lab required list once; not traded until added to bot.models
    if (!readSetting(db, 'migr_m10', z.boolean())) {
      this.config = { ...this.config, bot: { ...this.config.bot, modelConfluence: { ...this.config.bot.modelConfluence, M10: ['btc4h', 'slLiqClear'] } } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_m10', true)
    }
    // user 2026-11-23: M8 also on 3h POIs (lab: 3h +0,16R ≈ 4h +0,18R; with anomaly 4h+1d+3h +0,31R n 873 vs +0,40R n 519),
    // once; unticking it later in Settings sticks
    if (!readSetting(db, 'migr_m8_3h', z.boolean())) {
      if (!this.config.smc.m8PoiTimeframes.includes('3h')) this.config = { ...this.config, smc: { ...this.config.smc, m8PoiTimeframes: [...this.config.smc.m8PoiTimeframes, '3h'] } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_m8_3h', true)
    }
    // user 2026-11-23 (POI story layer 3): M8 requires a liquidity target B and a strong leg displacement, once
    if (!readSetting(db, 'migr_m8_story', z.boolean())) {
      const mc = { ...this.config.bot.modelConfluence }
      mc.M8 = [...new Set([...(mc.M8 ?? []), 'liqTarget' as const, 'dispStrong' as const])]
      this.config = { ...this.config, bot: { ...this.config.bot, modelConfluence: mc } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_m8_story', true)
    }
    // user 2026-11-23 (lab 300 coins incl. 200 new ones): M0 + slPoolClear, M9 + pdPremium + dayOpenCheap, M8 without the anomaly OR, once
    if (!readSetting(db, 'migr_story300', z.boolean())) {
      const mc = { ...this.config.bot.modelConfluence }
      mc.M0 = [...new Set([...(mc.M0 ?? []), 'slPoolClear' as const])]
      mc.M9 = [...new Set([...(mc.M9 ?? []), 'pdPremium' as const, 'dayOpenCheap' as const])]
      const any = { ...this.config.bot.modelConfluenceAny, M8: (this.config.bot.modelConfluenceAny.M8 ?? []).filter((k) => k !== 'anomaly') }
      this.config = { ...this.config, bot: { ...this.config.bot, modelConfluence: mc, modelConfluenceAny: any } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_story300', true)
    }
    // user 2026-11-24 ("bot papernya matiin aja, bikin bingung"): no shadow paper next to live, once (re-adding later sticks)
    if (!readSetting(db, 'migr_no_shadow', z.boolean())) {
      this.config = { ...this.config, bot: { ...this.config.bot, shadowModels: [] } }
      writeSetting(db, 'app_config', this.config)
      writeSetting(db, 'migr_no_shadow', true)
    }
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
