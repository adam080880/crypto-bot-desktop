import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfigPatch } from '@shared/config'
import { openDatabase } from '../db/client'
import { AppState } from './appState'

describe('AppState.updateConfig', () => {
  it('"Start bot" does not reset other bot settings', () => {
    const state = new AppState(openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') }), { dbPath: ':memory:', version: 't' })
    state.updateConfig(parseConfigPatch({ bot: { riskPerTradePct: 3, minScore: 8 } }))
    const next = state.updateConfig(parseConfigPatch({ bot: { enabled: true } }))
    expect(next.bot).toMatchObject({ enabled: true, riskPerTradePct: 3, minScore: 8 })
  })
})
