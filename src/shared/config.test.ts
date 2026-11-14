import { describe, expect, it } from 'vitest'
import { appConfigSchema, defaultAppConfig, riskConfigSchema } from './config'

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
