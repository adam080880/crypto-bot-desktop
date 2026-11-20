import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openDatabase } from './client'
import { readSetting, writeSetting } from './settingsRepo'

describe('database', () => {
  it('applies migrations and round-trips settings', () => {
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    expect(readSetting(db, 'x', z.number())).toBeNull()
    writeSetting(db, 'x', 42)
    writeSetting(db, 'x', 43)
    expect(readSetting(db, 'x', z.number())).toBe(43)
    // invalid shape → null instead of throwing
    expect(readSetting(db, 'x', z.string())).toBeNull()
  })
})

describe('candle repo', () => {
  it('stores candles, resamples, and answers weekly lookups', async () => {
    const { CandleRepo } = await import('./candles')
    const { upsertSymbols, symbolByName, getSyncState } = await import('./symbolsRepo')
    const { rebuildDerived } = await import('../sync/resample')
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    upsertSymbols(db, [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', onboardDate: 0, status: 'TRADING' }])
    const sym = symbolByName(db, 'BTCUSDT')!
    const repo = new CandleRepo(db)
    const mon = Date.UTC(2026, 10, 9) // Monday
    const rows = Array.from({ length: 2 * 1440 }, (_, i) => ({ t: mon + i * 60_000, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 2 }))
    expect(repo.insertNative('1m', sym.id, rows)).toBe(2880)
    expect(repo.insertNative('1m', sym.id, rows.slice(0, 10))).toBe(0) // idempotent

    const end = mon + 2 * 1440 * 60_000
    const written = rebuildDerived(db, repo, sym.id, mon, end)
    expect(written).toEqual({ '5m': 576, '15m': 192, '1h': 48, '4h': 12 })
    const h4 = repo.range('4h', sym.id, mon, end)
    expect(h4[0]).toMatchObject({ t: mon, o: 0, h: 240, l: -1, c: 239.5, v: 480, n: 240 })
    expect(getSyncState(db, sym.id, '4h')?.lastOpenTime).toBe(end - 4 * 3600_000)

    const wk = repo.week('1h', sym.id, mon + 3 * 86400_000) // Thursday → same week
    expect(wk).toHaveLength(48)
    expect(repo.pruneOlderThan('1m', mon + 1440 * 60_000)).toBe(1440)
  })

  it('fills taker buy volume + trades into old rows without touching OHLCV', async () => {
    const { CandleRepo } = await import('./candles')
    const { upsertSymbols, symbolByName } = await import('./symbolsRepo')
    const { rebuildDerived } = await import('../sync/resample')
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    upsertSymbols(db, [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', onboardDate: 0, status: 'TRADING' }])
    const sym = symbolByName(db, 'BTCUSDT')!
    const repo = new CandleRepo(db)
    const t0 = Date.UTC(2026, 10, 9)
    const old = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 60_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 4 }))
    repo.insertNative('1m', sym.id, old)
    expect(repo.missingFlow('1m', sym.id)).toEqual({ first: t0, last: t0 + 9 * 60_000, count: 10 })
    // a re-download with different OHLCV only fills the two new columns
    const fresh = old.map((c) => ({ ...c, o: 99, bv: 1, nt: 5 }))
    expect(repo.insertNative('1m', sym.id, fresh)).toBe(10)
    expect(repo.insertNative('1m', sym.id, fresh)).toBe(0) // already filled
    expect(repo.missingFlow('1m', sym.id)).toBeNull()
    expect(repo.rangeFlow('1m', sym.id, t0, t0 + 60_000)).toEqual([{ t: t0, o: 1, h: 2, l: 0.5, c: 1.5, v: 4, bv: 1, nt: 5 }])
    rebuildDerived(db, repo, sym.id, t0, t0 + 10 * 60_000)
    expect(repo.rangeFlow('5m', sym.id, t0, t0 + 10 * 60_000).map((c) => [c.bv, c.nt])).toEqual([[5, 25], [5, 25]])
    expect(repo.range('1m', sym.id, t0, t0 + 60_000)[0]).not.toHaveProperty('bv') // hot path stays lean
  })
})
