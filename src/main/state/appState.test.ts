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
    const state = new AppState(db, { dbPath: ':memory:', version: 't' })
    expect(state.getConfig().bot.modelConfluence).toMatchObject({ M0: ['fvg', 'trendParent', 'pdZone'], M5: ['oiConfirm'], M6: [] })
    state.updateConfig(parseConfigPatch({ bot: { modelConfluence: { ...state.getConfig().bot.modelConfluence, M0: ['prevOpposite'] } } }))
    expect(new AppState(db, { dbPath: ':memory:', version: 't' }).getConfig().bot.modelConfluence.M0).toEqual(['prevOpposite'])
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
