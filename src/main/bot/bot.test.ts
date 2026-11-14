import { describe, expect, it } from 'vitest'
import type { BotTrade } from '@shared/bot'
import { botConfigSchema, riskConfigSchema } from '@shared/config'
import type { ScreenerRow } from '@shared/screener'
import { isCryptoPerp, topCrypto, type ExchangeSymbol } from './binanceTrade'
import { PaperBroker, paperPnl } from './brokers'
import { accountGate, claudeGate, setupGate, type Candidate } from './gate'
import { planOrder, roundStep } from './sizing'

const RULES = { tickSize: 0.001, stepSize: 1, minQty: 1, minNotional: 5 }
const FEE = 0.09

describe('planOrder (risk-based sizing)', () => {
  it('sizes so that hitting the SL loses ≈ risk% of equity incl. fees', () => {
    // equity 10, risk 1% = 0.10; entry 1.000 SL 0.990 → 0.010/unit + fees
    const p = planOrder({ direction: 'bullish', entry: 1, sl: 0.99, tp: 1.05, equity: 10, riskPct: 1, maxLeverage: 20, rules: RULES, feePct: FEE })
    if (typeof p === 'string') throw new Error(p)
    expect(p.qty).toBe(8) // 0.1 / (0.01 + 1.99 × 0.0009) = 8.49 → 8 (step 1)
    expect(p.riskUsd).toBeLessThanOrEqual(0.1)
    expect(p.notional).toBe(8)
    expect(p.leverage).toBe(1)
  })

  it('caps the notional at equity × max leverage', () => {
    // SL 0.1% away: 1% risk incl. fees wants ~35 USDT notional (3.5×), cap 2× → 20 USDT
    const p = planOrder({ direction: 'bullish', entry: 1, sl: 0.999, tp: 1.01, equity: 10, riskPct: 1, maxLeverage: 2, rules: RULES, feePct: FEE })
    if (typeof p === 'string') throw new Error(p)
    expect(p.notional).toBe(20)
    expect(p.leverage).toBe(2)
    expect(p.riskUsd).toBeLessThan(0.1)
  })

  it('refuses orders below the exchange minimum instead of over-risking', () => {
    const r = planOrder({ direction: 'bullish', entry: 100, sl: 95, tp: 120, equity: 10, riskPct: 1, maxLeverage: 5, rules: { ...RULES, stepSize: 0.001, minQty: 0.001, minNotional: 100 }, feePct: FEE })
    expect(r).toMatch(/di bawah minimal order 100 USDT/)
  })

  it('rounds the SL away from entry and the TP towards it (short)', () => {
    const p = planOrder({ direction: 'bearish', entry: 1.0004, sl: 1.01001, tp: 0.95009, equity: 100, riskPct: 1, maxLeverage: 5, rules: RULES, feePct: FEE })
    if (typeof p === 'string') throw new Error(p)
    expect(p).toMatchObject({ entry: 1, sl: 1.011, tp: 0.951 })
  })

  it('roundStep has no float noise', () => {
    expect(roundStep(0.30000000000000004, 0.1, 'floor')).toBe(0.3)
    expect(roundStep(12.345, 0.01, 'ceil')).toBe(12.35)
  })
})

const NOW = Date.UTC(2026, 10, 12, 10)
const bot = botConfigSchema.parse({})
const cand = (p: Partial<ScreenerRow['setup'] & object> = {}, row: Partial<ScreenerRow> = {}): Candidate =>
  ({
    symbol: 'SOLUSDT',
    direction: 'bullish',
    price: 101,
    dataT: NOW,
    nearPoi: null,
    trendAligned: false,
    trend: { '4h': null, '1h': null, '15m': null },
    recentBos: null,
    ...row,
    setup: { id: 's1', entry: 100, sl: 99, tp: 104, rr: 4, score: 5, status: 'pending', createdT: NOW - 30 * 60_000, poi: { kind: 'OB', timeframe: '4h' }, ...p }
  }) as Candidate

describe('setupGate', () => {
  const o = { bot, entryTf: '15m' as const, universe: new Set(['SOLUSDT']), now: NOW }
  it('accepts a fresh pending setup from an HTF POI', () => expect(setupGate(cand(), o)).toBeNull())
  it('rejects coins outside the volume universe', () => expect(setupGate(cand({}, { symbol: 'XAUUSDT' }), o)).toMatch(/top 100/))
  it('rejects an LTF POI (needs HTF POI → LTF confirmation)', () => expect(setupGate(cand({ poi: { kind: 'OB', timeframe: '15m' } }), o)).toMatch(/bukan HTF/))
  it('rejects stale setups and price past TP / entry', () => {
    expect(setupGate(cand({ createdT: NOW - 3 * 3_600_000 }), o)).toMatch(/menit/)
    expect(setupGate(cand({}, { price: 104.5 }), o)).toMatch(/TP/)
    expect(setupGate(cand({}, { price: 99.5 }), o)).toMatch(/entry/)
  })
})

describe('claudeGate', () => {
  const o = { bot, entryTf: '15m' as const, now: NOW }
  const a = (p: object = {}) => ({ id: 'a', createdAt: NOW - 5 * 60_000, bias: 'long' as const, confidence: 75, forcedSkip: false, ...p })
  it('passes a fresh, aligned, confident analysis', () => expect(claudeGate(cand(), a(), o)).toEqual({ ok: true }))
  it('asks Claude when there is no analysis made after the setup', () => {
    expect(claudeGate(cand(), null, o)).toMatchObject({ ok: false, request: true })
    expect(claudeGate(cand(), a({ createdAt: NOW - 60 * 60_000 }), o)).toMatchObject({ ok: false, request: true })
  })
  it('rejects low confidence, opposite bias and forced skips', () => {
    expect(claudeGate(cand(), a({ confidence: 69 }), o)).toMatchObject({ ok: false, request: false })
    expect(claudeGate(cand(), a({ bias: 'short' }), o)).toMatchObject({ ok: false })
    expect(claudeGate(cand(), a({ forcedSkip: true }), o)).toMatchObject({ ok: false })
  })
})

describe('accountGate', () => {
  const base = { killSwitch: false, newsWindow: null, newsStrategy: false, activeTrades: 0, risk: riskConfigSchema.parse({}), pnlToday: 0, equityDayStart: 10 }
  it('blocks on kill switch, daily loss, news window and max positions', () => {
    expect(accountGate(base)).toBeNull()
    expect(accountGate({ ...base, killSwitch: true })).toMatch(/Kill Switch/)
    expect(accountGate({ ...base, pnlToday: -0.3 })).toMatch(/berhenti/)
    expect(accountGate({ ...base, newsWindow: 'CPI' })).toMatch(/news/)
    expect(accountGate({ ...base, activeTrades: 3 })).toMatch(/maks 3/)
  })
})

describe('universe', () => {
  const sym = (symbol: string, underlyingType: string, sub: string[]): ExchangeSymbol => ({
    symbol,
    underlyingType,
    underlyingSubType: sub,
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    rules: RULES
  })
  it('keeps crypto only and sorts by volume', () => {
    const list = [sym('BTCUSDT', 'COIN', ['PoW', 'Crypto']), sym('XAUUSDT', 'COMMODITY', ['TradFi']), sym('TSLAUSDT', 'EQUITY', ['TradFi']), sym('BTCDOMUSDT', 'INDEX', ['Index', 'Crypto']), sym('DOGEUSDT', 'COIN', ['Meme', 'Crypto'])]
    expect(list.filter(isCryptoPerp).map((s) => s.symbol)).toEqual(['BTCUSDT', 'DOGEUSDT'])
    const vol = new Map([['BTCUSDT', 1], ['DOGEUSDT', 5], ['XAUUSDT', 99]])
    expect(topCrypto(list, vol, 1)).toEqual(['DOGEUSDT'])
  })
})

describe('PaperBroker', () => {
  const trade = (p: Partial<BotTrade> = {}): BotTrade =>
    ({ id: 't', mode: 'paper', direction: 'bullish', entry: 100, sl: 99, tp: 104, qty: 1, status: 'pending', ...p }) as BotTrade
  const b = new PaperBroker(() => 10)

  it('fills on a touch of the entry and closes at TP on a later bar', async () => {
    expect(await b.sync(trade(), { high: 101, low: 100.5, last: 100.8 })).toBeNull()
    expect(await b.sync(trade(), { high: 101, low: 99.9, last: 100.2 })).toMatchObject({ status: 'open', filledQty: 1 })
    const win = await b.sync(trade({ status: 'open' }), { high: 104.2, low: 102, last: 104 })
    expect(win).toMatchObject({ status: 'closed', reason: 'tp', exitPrice: 104 })
    expect(win!.pnl).toBeCloseTo(4 - 0.02 - 0.0208)
  })

  it('counts fill + SL in the same bar as a loss (with slippage and taker fee)', async () => {
    const r = await b.sync(trade(), { high: 100.5, low: 98.5, last: 98.8 })
    expect(r).toMatchObject({ status: 'closed', reason: 'sl' })
    expect(r!.pnl).toBeCloseTo(paperPnl(trade(), 99, true))
    expect(r!.pnl).toBeLessThan(-1)
  })
})
