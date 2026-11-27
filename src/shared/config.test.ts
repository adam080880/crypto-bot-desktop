import { describe, expect, it } from 'vitest'
import { appConfigSchema, defaultAppConfig, m8Exit, riskConfigSchema, riskPctFor } from './config'

describe('config schema', () => {
  it('defaults to paper mode with a risk guard', () => {
    expect(defaultAppConfig.mode).toBe('paper')
    expect(defaultAppConfig.risk.requireStopLoss).toBe(true)
    expect(defaultAppConfig.risk.maxOpenPositions).toBeGreaterThan(0)
  })

  it('refuses to disable mandatory stop-loss', () => {
    expect(riskConfigSchema.safeParse({ requireStopLoss: false }).success).toBe(false)
  })

  it('rejects a live mode (not implemented yet)', () => {
    expect(appConfigSchema.safeParse({ mode: 'live' }).success).toBe(false)
  })
})

describe('config patch', () => {
  it('rejects unknown keys and the stop-loss flag', async () => {
    const { configPatchSchema } = await import('./config')
    expect(configPatchSchema.safeParse({ risk: { maxLeverage: 3 } }).success).toBe(true)
    expect(configPatchSchema.safeParse({ risk: { requireStopLoss: false } }).success).toBe(false)
    expect(configPatchSchema.safeParse({ foo: 1 }).success).toBe(false)
  })

  it('accepts bot.minConfidence only as an integer 0–100 (not a 0–1 fraction)', async () => {
    const { configPatchSchema } = await import('./config')
    expect(defaultAppConfig.bot.minConfidence).toBe(70)
    expect(configPatchSchema.safeParse({ bot: { minConfidence: 80 } }).success).toBe(true)
    for (const v of [101, -1, 0.7]) expect(configPatchSchema.safeParse({ bot: { minConfidence: v } }).success).toBe(false)
  })

  it('accepts bot.riskPerTradePct above 0 up to 100 % of equity', async () => {
    const { configPatchSchema } = await import('./config')
    expect(defaultAppConfig.bot.riskPerTradePct).toBe(1)
    expect(configPatchSchema.safeParse({ bot: { riskPerTradePct: 0.5 } }).success).toBe(true)
    expect(configPatchSchema.safeParse({ bot: { riskPerTradePct: 10 } }).success).toBe(true)
    for (const v of [0, 101, -1]) expect(configPatchSchema.safeParse({ bot: { riskPerTradePct: v } }).success).toBe(false)
  })

  it('a partial patch keeps only the sent keys (zod 4 fills defaults inside partial)', async () => {
    const { parseConfigPatch } = await import('./config')
    expect(parseConfigPatch({ bot: { enabled: true } })).toEqual({ bot: { enabled: true } })
    expect(parseConfigPatch({ screener: { notify: false }, risk: { maxLeverage: 10 } })).toEqual({ screener: { notify: false }, risk: { maxLeverage: 10 } })
    expect(() => parseConfigPatch({ bot: { riskPerTradePct: 0 } })).toThrow()
  })

  it('never turns live trading on through a config patch', async () => {
    const { configPatchSchema } = await import('./config')
    expect(defaultAppConfig.bot.live).toBe(false)
    expect(defaultAppConfig.bot.enabled).toBe(false)
    expect(configPatchSchema.safeParse({ bot: { live: true } }).success).toBe(false)
  })
})

describe('symbol filter', () => {
  it('excludes configured symbols and non-ASCII names', async () => {
    const { isSymbolAllowed, dataConfigSchema } = await import('./config')
    const data = dataConfigSchema.parse({})
    expect(isSymbolAllowed('BTCUSDT', data)).toBe(true)
    expect(isSymbolAllowed('1000PEPEUSDT', data)).toBe(true)
    expect(isSymbolAllowed('BTCDOMUSDT', data)).toBe(false)
    expect(isSymbolAllowed('USDCUSDT', data)).toBe(false)
    expect(isSymbolAllowed('币安人生USDT', data)).toBe(false)
    expect(isSymbolAllowed('币安人生USDT', { ...data, excludeNonAscii: false })).toBe(true)
  })
})

describe('m8Exit', () => {
  it('TP at the story target (tpLiquidity) by default, fixed R when m8TpToTarget is off', () => {
    expect(defaultAppConfig.smc.m8TpToTarget).toBe(true)
    expect(m8Exit({ m8TpR: 3, m8TpToTarget: true })).toMatchObject({ tpMode: 'liquidity', tpR: 3 })
    expect(m8Exit({ m8TpR: 3, m8TpToTarget: false })).toMatchObject({ tpMode: 'fixedR', tpR: 3 })
  })
})

describe('risk per model (bot.modelRiskPct)', () => {
  it('defaults to the global risk and uses a model override when set', () => {
    expect(defaultAppConfig.bot.modelRiskPct).toEqual({})
    expect(riskPctFor({ riskPerTradePct: 1, modelRiskPct: {} }, 'M11')).toBe(1)
    expect(riskPctFor({ riskPerTradePct: 1, modelRiskPct: { M11: 3 } }, 'M11')).toBe(3)
    expect(riskPctFor({ riskPerTradePct: 1, modelRiskPct: { M11: 3 } }, 'M8')).toBe(1)
  })

  it('golden ratio: × oteRiskMult for an ote setup of an oteRiskModels model only', () => {
    expect(defaultAppConfig.bot.oteRiskMult).toBe(1.5)
    expect(defaultAppConfig.bot.oteRiskModels).toEqual(['M8'])
    const b = { riskPerTradePct: 1, modelRiskPct: {}, oteRiskMult: 1.5, oteRiskModels: ['M8' as const] }
    expect(riskPctFor(b, 'M8', ['liqTarget', 'ote'])).toBe(1.5)
    expect(riskPctFor(b, 'M8', ['liqTarget'])).toBe(1)
    expect(riskPctFor(b, 'M0', ['ote'])).toBe(1)
    expect(riskPctFor({ ...b, modelRiskPct: { M8: 2 } }, 'M8', ['ote'])).toBe(3)
  })

  it('keeps the override through a patch and rejects non-positive values', async () => {
    const { parseConfigPatch } = await import('./config')
    expect(parseConfigPatch({ bot: { modelRiskPct: { M11: 2.5 } } })).toEqual({ bot: { modelRiskPct: { M11: 2.5 } } })
    expect(() => parseConfigPatch({ bot: { modelRiskPct: { M11: 0 } } })).toThrow()
  })
})
