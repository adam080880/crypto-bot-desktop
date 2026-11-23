import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfigPatch, RECOMMENDED_MODEL_CONFLUENCE } from '@shared/config'
import { openDatabase } from '../db/client'
import { writeSetting } from '../db/settingsRepo'
import { AppState, migrateModelConfluence } from './appState'

describe('AppState.updateConfig', () => {
  it('"Start bot" does not reset other bot settings', () => {
    const state = new AppState(openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') }), { dbPath: ':memory:', version: 't' })
    state.updateConfig(parseConfigPatch({ bot: { riskPerTradePct: 3, minScore: 8 } }))
    const next = state.updateConfig(parseConfigPatch({ bot: { enabled: true } }))
    expect(next.bot).toMatchObject({ enabled: true, riskPerTradePct: 3, minScore: 8 })
  })
})

describe('per-model confluence migration', () => {
  it('copies the old SMC list to M0–M4 and the M5 list to M5', () => {
    const m = migrateModelConfluence({ requireConfluence: ['fvg', 'pdZone', 'bogus'], trendRequireConfluence: [] })
    expect(m).toMatchObject({ M0: ['fvg', 'pdZone'], M1: ['fvg', 'pdZone'], M2a: ['fvg', 'pdZone'], M2b: ['fvg', 'pdZone'], M4: ['fvg', 'pdZone'], M5: [], M6: [] })
  })
  it('keeps the recommended defaults for configs without the old keys, and an existing per-model list', () => {
    expect(migrateModelConfluence(undefined)).toEqual(RECOMMENDED_MODEL_CONFLUENCE)
    expect(migrateModelConfluence({ requireConfluence: ['fvg'], modelConfluence: { M0: ['sweep'] } }).M0).toEqual(['sweep'])
  })
  it('runs once on a stored old config, then sticks', () => {
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    writeSetting(db, 'app_config', { bot: { requireConfluence: ['fvg', 'trendParent', 'pdZone'], trendRequireConfluence: ['oiConfirm'] } })
    writeSetting(db, 'migr_bot_pdzone', true)
    writeSetting(db, 'migr_liq_tags', true)
    writeSetting(db, 'migr_lab_1123', true)
    writeSetting(db, 'migr_story300', true)
    const state = new AppState(db, { dbPath: ':memory:', version: 't' })
    expect(state.getConfig().bot.modelConfluence).toMatchObject({ M0: ['fvg', 'trendParent', 'pdZone'], M5: ['oiConfirm'], M6: [] })
    state.updateConfig(parseConfigPatch({ bot: { modelConfluence: { ...state.getConfig().bot.modelConfluence, M0: ['prevOpposite'] } } }))
    expect(new AppState(db, { dbPath: ':memory:', version: 't' }).getConfig().bot.modelConfluence.M0).toEqual(['prevOpposite'])
  })
})

describe('liquidity tag migration (2026-11-22)', () => {
  it('adds cleanApproach to M0 and liqHtfBehind to M1/M7 once, keeping the rest', () => {
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    writeSetting(db, 'migr_bot_model_conf', true)
    writeSetting(db, 'migr_lab_1123', true)
    writeSetting(db, 'migr_story300', true)
    writeSetting(db, 'app_config', { bot: { modelConfluence: { M0: ['prevOpposite', 'slLiqClear'], M1: ['fvg'], M4: ['fvg'], M7: [] } } })
    const state = new AppState(db, { dbPath: ':memory:', version: 't' })
    expect(state.getConfig().bot.modelConfluence).toMatchObject({ M0: ['prevOpposite', 'slLiqClear', 'cleanApproach'], M1: ['fvg', 'liqHtfBehind'], M4: ['fvg'], M7: ['liqHtfBehind'] })
    state.updateConfig(parseConfigPatch({ bot: { modelConfluence: { ...state.getConfig().bot.modelConfluence, M0: ['prevOpposite'] } } }))
    expect(new AppState(db, { dbPath: ':memory:', version: 't' }).getConfig().bot.modelConfluence.M0).toEqual(['prevOpposite'])
  })
})

describe('inducement/exit lab migration (2026-11-23)', () => {
  it('switches the SMC exit to trailing, M4 to that exit, M8 TP 3R, adds the lab tags and M9 shadow — once', () => {
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    writeSetting(db, 'migr_bot_model_conf', true)
    writeSetting(db, 'migr_liq_tags', true)
    writeSetting(db, 'migr_story300', true)
    writeSetting(db, 'app_config', {
      exit: { tpMode: 'liquidity' },
      smc: { breakerTpR: 1, m8TpR: 2 },
      bot: { shadowModels: ['M8'], modelConfluence: { M0: ['prevOpposite', 'slLiqClear', 'cleanApproach'], M4: ['fvg', 'oiConfirm', 'slLiqClear'], M2a: ['trendParent'] } }
    })
    const state = new AppState(db, { dbPath: ':memory:', version: 't' })
    const c = state.getConfig()
    expect(c.exit.tpMode).toBe('trail')
    expect(c.smc).toMatchObject({ breakerTpR: 0, m8TpR: 3 })
    expect(c.bot.shadowModels).toEqual(['M8', 'M9'])
    expect(c.bot.modelConfluence).toMatchObject({
      M0: ['prevOpposite', 'slLiqClear', 'cleanApproach', 'baitTaken'],
      M2a: ['trendParent'],
      M4: ['fvg', 'slLiqClear', 'cleanApproach'],
      M9: ['cleanApproach']
    })
    // a later change in Settings sticks
    state.updateConfig(parseConfigPatch({ exit: { tpMode: 'liquidity' } }))
    expect(new AppState(db, { dbPath: ':memory:', version: 't' }).getConfig().exit.tpMode).toBe('liquidity')
  })
})

describe('OCL → OCL Break HTF migration (2026-11-20)', () => {
  it('drops the plain OCL as POI and allows the 4h/1d/1w OCL Break once', () => {
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    writeSetting(db, 'app_config', { smc: { oclParentTimeframes: ['4h', '1d', '1w'], m0OclBreakTimeframes: ['1w'] } })
    const state = new AppState(db, { dbPath: ':memory:', version: 't' })
    expect(state.getConfig().smc).toMatchObject({ oclParentTimeframes: [], m0OclBreakTimeframes: ['4h', '1d', '1w'] })
    state.updateConfig(parseConfigPatch({ smc: { m0OclBreakTimeframes: ['1d'] } }))
    expect(new AppState(db, { dbPath: ':memory:', version: 't' }).getConfig().smc.m0OclBreakTimeframes).toEqual(['1d'])
  })
})
