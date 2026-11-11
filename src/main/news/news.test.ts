import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, newsConfigSchema } from '@shared/config'
import type { EconomicEvent } from '@shared/news'
import { computeActual, minReferenceDate } from './actuals'
import { findRule, interpret } from './interpret'
import { activeWindow, blocksNewPositions, nextEvent } from './newsWindow'
import { cleanText, formatLike, parseFfValue } from './parse'

const rule = (key: string) => DEFAULT_RULES.find((r) => r.key === key)!

describe('parse', () => {
  it('parses ForexFactory values', () => {
    expect(parseFfValue('0.3%')).toBe(0.3)
    expect(parseFfValue('194K')).toBe(194)
    expect(parseFfValue('-1.2B')).toBe(-1.2)
    expect(parseFfValue('<0.1%')).toBe(0.1)
    expect(parseFfValue('')).toBeNull()
    expect(parseFfValue('n/a')).toBeNull()
    expect(formatLike(0.35, '0.3%', 1)).toBe('0.3%') // toFixed rounding, display only
    expect(formatLike(203, '194K', 0)).toBe('203K')
    expect(cleanText('CPI\u0000 m/m\n')).toBe('CPI  m/m')
  })
})

describe('interpretation', () => {
  it('matches rules by title', () => {
    expect(findRule('Core CPI m/m', DEFAULT_RULES)?.key).toBe('core_cpi_mom')
    expect(findRule('CPI m/m', DEFAULT_RULES)?.key).toBe('cpi_mom')
    expect(findRule('FOMC Member Waller Speaks', DEFAULT_RULES)).toBeNull()
  })

  it('CPI higher than forecast = USD bullish → crypto bearish (inverse)', () => {
    const r = interpret(0.4, 0.3, 0.6, rule('cpi_mom'), 'inverse')
    expect(r).toMatchObject({ usdBias: 'bullish', cryptoBias: 'bearish' })
  })

  it('unemployment higher = USD bearish → crypto bullish (inverted event)', () => {
    expect(interpret(4.3, 4.1, 4.1, rule('unemployment_rate'), 'inverse')).toMatchObject({ usdBias: 'bearish', cryptoBias: 'bullish' })
    expect(interpret(203, 194, 189, rule('claims'), 'inverse')).toMatchObject({ usdBias: 'bearish', cryptoBias: 'bullish' })
  })

  it('equal → neutral; mode same/off; falls back to previous', () => {
    expect(interpret(0.3, 0.3, 0.6, rule('cpi_mom'), 'inverse').usdBias).toBe('neutral')
    expect(interpret(0.4, 0.3, null, rule('cpi_mom'), 'same').cryptoBias).toBe('bullish')
    expect(interpret(0.4, 0.3, null, rule('cpi_mom'), 'off').cryptoBias).toBe('neutral')
    expect(interpret(0.4, null, 0.6, rule('cpi_mom'), 'inverse').usdBias).toBe('bearish')
  })
})

describe('official actuals', () => {
  const oct10 = Date.UTC(2026, 10, 10, 13, 30) // CPI release, 10 Nov 2026 08:30 ET
  const cpi = [
    { date: Date.UTC(2026, 8, 1), value: 336.298 },
    { date: Date.UTC(2026, 9, 1), value: 337.476 }
  ]
  it('computes m/m from index levels and rejects stale data', () => {
    expect(computeActual(cpi, rule('cpi_mom').source!, oct10)).toBe(0.4) // 0.350% → 0.4
    expect(computeActual(cpi.slice(0, 1), rule('cpi_mom').source!, oct10)).toBeNull() // Oct not out yet
  })

  it('NFP diff, claims scaled to K with weekly freshness', () => {
    const nfp = [
      { date: Date.UTC(2026, 8, 1), value: 159128 },
      { date: Date.UTC(2026, 9, 1), value: 159293 }
    ]
    expect(computeActual(nfp, rule('nfp').source!, Date.UTC(2026, 10, 6, 13, 30))).toBe(165)
    const thu = Date.UTC(2026, 10, 12, 13, 30)
    const claims = [
      { date: Date.UTC(2026, 9, 31), value: 189000 },
      { date: Date.UTC(2026, 10, 7), value: 203000 }
    ]
    expect(computeActual(claims, rule('claims').source!, thu)).toBe(203)
    expect(computeActual(claims.slice(0, 1), rule('claims').source!, thu)).toBeNull()
  })

  it('reference dates', () => {
    expect(minReferenceDate(Date.UTC(2026, 10, 10), { unit: 'month', n: 1 })).toBe(Date.UTC(2026, 9, 1))
    expect(minReferenceDate(Date.UTC(2026, 9, 29), { unit: 'quarter', n: 1 })).toBe(Date.UTC(2026, 6, 1))
    expect(minReferenceDate(Date.UTC(2026, 10, 4, 19), { unit: 'day', n: -1 })).toBe(Date.UTC(2026, 10, 5))
  })
})

describe('news window', () => {
  const cfg = newsConfigSchema.parse({})
  const ev = (over: Partial<EconomicEvent>): EconomicEvent => ({
    id: 'x', source: 'ff', title: 'CPI m/m', currency: 'USD', impact: 'High', time: 1_000_000_000_000,
    forecastRaw: null, previousRaw: null, actualRaw: null, forecast: null, previous: null, actual: null,
    actualSource: null, actualAt: null, ruleKey: null, usdBias: null, cryptoBias: null, biasReason: null, ...over
  })
  it('opens 15m before and closes 30m after high-impact USD events', () => {
    const e = ev({})
    expect(activeWindow([e], cfg, e.time - 16 * 60_000)).toBeNull()
    expect(activeWindow([e], cfg, e.time - 15 * 60_000)?.eventId).toBe('x')
    expect(activeWindow([e], cfg, e.time + 30 * 60_000)?.endsAt).toBe(e.time + 30 * 60_000)
    expect(activeWindow([e], cfg, e.time + 31 * 60_000)).toBeNull()
    expect(activeWindow([ev({ impact: 'Medium' })], cfg, e.time)).toBeNull()
    expect(activeWindow([ev({ currency: 'EUR' })], cfg, e.time)).toBeNull()
  })
  it('blocks new positions unless the news strategy is on; finds the next event', () => {
    const w = activeWindow([ev({})], cfg, 1_000_000_000_000)
    expect(blocksNewPositions(w, cfg)).toBe(true)
    expect(blocksNewPositions(w, { ...cfg, newsStrategyEnabled: true })).toBe(false)
    expect(nextEvent([ev({ id: 'a', time: 5 }), ev({ id: 'b', time: 10, impact: 'Low' }), ev({ id: 'c', time: 20 })], cfg, 6)?.id).toBe('c')
  })
})

describe('repo dedupe of simultaneous releases', () => {
  it('counts one reaction sample per release in stats and one candidate per release+direction', async () => {
    const { resolve } = await import('node:path')
    const { openDatabase } = await import('../db/client')
    const { NewsRepo } = await import('./repo')
    const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
    const repo = new NewsRepo(db)
    const cfg = newsConfigSchema.parse({})
    const t = Date.UTC(2026, 10, 10, 13, 30)
    repo.upsertFeed('ff', [
      { title: 'CPI m/m', currency: 'USD', impact: 'High', time: t, forecastRaw: '0.3%', previousRaw: '0.6%', actualRaw: null },
      { title: 'Core CPI m/m', currency: 'USD', impact: 'High', time: t, forecastRaw: '0.2%', previousRaw: '0.3%', actualRaw: null }
    ], cfg)
    const [a, b] = repo.list(t - 1, t + 1)
    repo.setActual(a!.id, 0.4, '0.4%', 'bls', findRule(a!.title, cfg.rules), 'inverse')
    repo.setActual(b!.id, 0.4, '0.4%', 'bls', findRule(b!.title, cfg.rules), 'inverse')
    for (const e of [a!, b!]) repo.addReaction({ eventId: e.id, symbol: 'BTCUSDT', horizonMin: 60, priceBefore: 100, priceAfter: 99, changePct: -1 })
    const st = repo.stats('inverse')
    expect(st).toHaveLength(1)
    expect(st[0]).toMatchObject({ usdBias: 'bullish', n: 1, ruleHitPct: 1 })

    repo.addCandidate({ id: `${a!.id}-BTCUSDT`, eventId: a!.id, eventTitle: a!.title, symbol: 'BTCUSDT', direction: 'bearish', createdAt: t, price: 1, trend: {}, poi: null, target: null, setupId: null, aligned: false, reasons: [] })
    expect(repo.hasCandidateForRelease('BTCUSDT', t, 'bearish')).toBe(true)
    expect(repo.hasCandidateForRelease('BTCUSDT', t, 'bullish')).toBe(false)
  })
})
