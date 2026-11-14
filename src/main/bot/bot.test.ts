import { describe, expect, it } from 'vitest'
import type { BotTrade } from '@shared/bot'
import { botConfigSchema, exitConfigSchema, riskConfigSchema } from '@shared/config'
import type { ScreenerRow, ScreenerSetup } from '@shared/screener'
import { BinanceApiError, isCryptoPerp, topCrypto, type ExchangeSymbol } from './binanceTrade'
import { LiveBroker, PaperBroker, paperPnl } from './brokers'
import { accountGate, claudeGate, setupGate, type Candidate } from './gate'
import { pickLeverage, planOrder, roundStep } from './sizing'

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
const cand = (p: Partial<ScreenerSetup> = {}, row: Partial<ScreenerRow> = {}): Candidate =>
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
    setup: {
      id: 's1',
      model: 'M1',
      entry: 100,
      sl: 99,
      tp: 104,
      tpLiquidity: 104,
      rr: 4,
      score: 5,
      confluence: ['fvg', 'trendParent'],
      status: 'pending',
      createdT: NOW - 30 * 60_000,
      poi: { kind: 'OB', timeframe: '4h', origin: 'sweep' },
      child: { kind: 'QM', timeframe: '15m' },
      ...p
    }
  }) as Candidate

describe('setupGate', () => {
  const o = { bot, entryTf: '15m' as const, universe: new Set(['SOLUSDT']), now: NOW }
  it('accepts a fresh pending setup from an HTF POI', () => expect(setupGate(cand(), o)).toBeNull())
  it('rejects coins outside the volume universe', () => expect(setupGate(cand({}, { symbol: 'XAUUSDT' }), o)).toMatch(/top 100/))
  it('rejects an LTF POI (needs HTF POI → LTF confirmation)', () => expect(setupGate(cand({ poi: { kind: 'OB', timeframe: '15m', origin: 'sweep' } }), o)).toMatch(/bukan HTF/))
  it('a coin profile replaces the global models / confluences / POIs for that coin', () => {
    const profile = {
      symbol: 'SOLUSDT',
      savedAt: NOW,
      models: ['M4' as const],
      pois: ['OB|1h'],
      requireConfluence: [],
      minScore: 0,
      plan: { key: 'r1', label: 'TP 1R', exit: { ...exitConfigSchema.parse({}), tpMode: 'fixedR' as const, tpR: 1 } },
      stats: { trades: 40, winrate: 0.6, avgR: 0.2, oosTrades: 12, oosAvgR: 0.1 }
    }
    expect(setupGate(cand(), { ...o, profile })).toMatch(/profil SOLUSDT/)
    expect(setupGate(cand({ model: 'M4', poi: { kind: 'OB', timeframe: '4h', origin: 'sweep' } }), { ...o, profile })).toMatch(/bukan POI profil/)
    expect(setupGate(cand({ model: 'M4', confluence: [], poi: { kind: 'OB', timeframe: '1h', origin: 'sweep' } }, { price: 100.5 }), { ...o, profile })).toBeNull()
    // fixed 1R plan: the pending limit is cancelled at 1R (101), not at the liquidity TP (104)
    expect(setupGate(cand({ model: 'M4', confluence: [], poi: { kind: 'OB', timeframe: '1h', origin: 'sweep' } }, { price: 101.5 }), { ...o, profile })).toMatch(/lewat TP/)
  })

  it('rejects models the bot does not trade and missing required confluences', () => {
    expect(setupGate(cand({ model: 'M0' }), o)).toMatch(/tidak dipakai bot/)
    expect(setupGate(cand({ confluence: ['fvg'] }), o)).toMatch(/konfluensi wajib: trendParent/)
    expect(setupGate(cand({ model: 'M4', poi: { kind: 'OB', timeframe: '15m', origin: 'sweep' } }), o)).toBeNull() // breakers: any TF
  })
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

describe('LiveBroker.moveStop (algo orders cannot be modified → cancel + place)', () => {
  const t = { id: 'x', symbol: 'AAAUSDT', direction: 'bullish', entry: 100, sl: 99, slOrderId: 'smc-x-s0', slSeq: 0 } as unknown as BotTrade
  const fake = (placeFails: number, cancelFails = false, failWith: Error = new BinanceApiError(-4130, 'closePosition exists', '/fapi/v1/algoOrder')) => {
    const calls: string[] = []
    let n = 0
    const client = {
      stopLoss: async (p: { clientId: string; triggerPrice: string }) => {
        calls.push(`place ${p.clientId} @${p.triggerPrice}`)
        if (n++ < placeFails) throw failWith
        return { algoId: 1, clientAlgoId: p.clientId }
      },
      cancelAlgo: async (_s: string, id: string) => {
        calls.push(`cancel ${id}`)
        if (cancelFails) throw new Error('timeout')
      },
      cancelAll: async () => void calls.push('cancelAll'),
      position: async () => ({ positionAmt: '1' }),
      marketClose: async () => void calls.push('marketClose')
    }
    return { broker: new LiveBroker(client as never), calls }
  }

  it('places the new stop before cancelling the old one', async () => {
    const { broker, calls } = fake(0)
    expect(await broker.moveStop(t, 100.1, RULES)).toMatchObject({ sl: 100.1, slOrderId: 'smc-x-s1', slSeq: 1 })
    expect(calls).toEqual(['place smc-x-s1 @100.100', 'cancel smc-x-s0'])
  })

  it('keeps the new stop when only the cancel of the old one fails (no market close)', async () => {
    const { broker, calls } = fake(0, true)
    expect(await broker.moveStop(t, 100.1, RULES)).toMatchObject({ slOrderId: 'smc-x-s1' })
    expect(calls).not.toContain('marketClose')
  })

  it('second closePosition stop refused → cancel old, then place new', async () => {
    const { broker, calls } = fake(1)
    expect(await broker.moveStop(t, 100.1, RULES)).toMatchObject({ slOrderId: 'smc-x-s1' })
    expect(calls).toEqual(['place smc-x-s1 @100.100', 'cancel smc-x-s0', 'place smc-x-s1 @100.100'])
  })

  it('-4142 (price already beyond the new stop) closes at market right away', async () => {
    const { broker, calls } = fake(1, false, new BinanceApiError(-4142, 'would trigger immediately', '/fapi/v1/algoOrder'))
    await expect(broker.moveStop(t, 100.1, RULES)).rejects.toThrow(/-4142/)
    expect(calls).toEqual(['place smc-x-s1 @100.100', 'cancelAll', 'marketClose'])
  })

  it('partial: shrink the TP via Modify Order first, then reduce-only market', async () => {
    const calls: string[] = []
    const client = {
      modifyOrder: async (p: { clientId: string; qty: string }) => void calls.push(`modify ${p.clientId} qty ${p.qty}`),
      marketClose: async (_s: string, q: number) => void calls.push(`market ${q}`)
    }
    const tr = { ...t, qty: 10, filledQty: 10, closedQty: 0, partials: 0, tp: 105, tpOrderId: 'smc-x-t0' } as unknown as BotTrade
    const r = await new LiveBroker(client as never).partialClose(tr, 5, 103, RULES)
    expect(calls).toEqual(['modify smc-x-t0 qty 5', 'market 5'])
    expect(r).toMatchObject({ closedQty: 5, partials: 1, tpOrderId: 'smc-x-t0' })
  })

  it('closes at market when no stop can be placed at all', async () => {
    const { broker, calls } = fake(2)
    await expect(broker.moveStop(t, 100.1, RULES)).rejects.toThrow(/ditutup market/)
    expect(calls).toContain('marketClose')
  })
})

describe('LiveBroker SL after fill (Binance -4509: closePosition stop needs an open position)', () => {
  const pend = { id: 'y', symbol: 'AAAUSDT', direction: 'bullish', entry: 100, sl: 99, tp: 105, qty: 10, status: 'pending', createdAt: 0, filledAt: null, entryOrderId: 'smc-y-e', slOrderId: null, tpOrderId: null } as unknown as BotTrade
  const fake = (o: { status: string; executedQty: string }, slFails = false) => {
    const calls: string[] = []
    const client = {
      setIsolated: async () => undefined,
      setLeverage: async () => undefined,
      limitEntry: async () => (calls.push('entry'), { status: 'NEW', executedQty: '0' }),
      getOrder: async () => ({ ...o, updateTime: 5 }),
      stopLoss: async (p: { clientId: string }) => {
        calls.push(`sl ${p.clientId}`)
        if (slFails) throw new BinanceApiError(-2021, 'would immediately trigger', '/fapi/v1/algoOrder')
        return { algoId: 1, clientAlgoId: p.clientId }
      },
      limitTakeProfit: async (p: { clientId: string }) => void calls.push(`tp ${p.clientId}`),
      cancelOrder: async () => (calls.push('cancelEntry'), null),
      cancelAll: async () => void calls.push('cancelAll'),
      position: async () => ({ positionAmt: '10' }),
      marketClose: async () => void calls.push('marketClose'),
      realised: async () => ({ pnl: -1.2, lastPrice: 98.9, lastTime: 9 })
    }
    return { broker: new LiveBroker(client as never), calls }
  }

  it('open() places only the limit entry, no stop yet', async () => {
    const { broker, calls } = fake({ status: 'NEW', executedQty: '0' })
    const plan = { entry: 100, sl: 99, qty: 10, leverage: 2 } as never
    expect(await broker.open(pend, plan, RULES)).toEqual({ entryOrderId: 'smc-y-e', slOrderId: null })
    expect(calls).toEqual(['entry'])
  })

  it('on fill: SL first, then TP', async () => {
    const { broker, calls } = fake({ status: 'FILLED', executedQty: '10' })
    expect(await broker.sync(pend, null, RULES)).toMatchObject({ status: 'open', slOrderId: 'smc-y-s', tpOrderId: 'smc-y-t0' })
    expect(calls).toEqual(['sl smc-y-s', 'tp smc-y-t0'])
  })

  it('partial fill still working: SL goes on right away', async () => {
    const { broker, calls } = fake({ status: 'PARTIALLY_FILLED', executedQty: '4' })
    expect(await broker.sync(pend, null, RULES)).toEqual({ slOrderId: 'smc-y-s' })
    expect(calls).toEqual(['sl smc-y-s'])
  })

  it('SL refused after fill → cancel rest, close at market, book as closed', async () => {
    const { broker, calls } = fake({ status: 'FILLED', executedQty: '10' }, true)
    const r = await broker.sync(pend, null, RULES)
    expect(r).toMatchObject({ status: 'closed', exitPrice: 98.9, pnl: -1.2 })
    expect(calls).toEqual(['sl smc-y-s', 'cancelEntry', 'cancelAll', 'marketClose'])
  })

  it('open position without a stop (restart between fill and SL) gets one', async () => {
    const { broker, calls } = fake({ status: 'FILLED', executedQty: '10' })
    expect(await broker.sync({ ...pend, status: 'open' } as BotTrade, null, RULES)).toEqual({ slOrderId: 'smc-y-s' })
    expect(calls).toEqual(['sl smc-y-s'])
  })
})

describe('pickLeverage (as high as safe; liquidation beyond the SL)', () => {
  const BR = [
    { initialLeverage: 50, notionalFloor: 0, notionalCap: 5000, maintMarginRatio: 0.01 },
    { initialLeverage: 20, notionalFloor: 5000, notionalCap: 25000, maintMarginRatio: 0.025 }
  ]
  const fee = 0.09

  it('tight SL → bracket max (50×), margin = notional ÷ 50', () => {
    // SL 0.3 %: safe = 1 / (1 % + 0.45 % + 0.09 %) = 64 → bracket 50
    const r = pickLeverage({ entry: 100, sl: 99.7, notional: 60, equity: 23, cap: 100, brackets: BR, feePct: fee })
    expect(r).toMatchObject({ leverage: 50 })
    expect((r as { marginUsd: number }).marginUsd).toBeCloseTo(1.2)
  })

  it('wider SL → lower leverage so liquidation stays ≥ 1.5 SL distances away', () => {
    // SL 2 %: safe = floor(1 / (1 % + 3 % + 0.09 %)) = 24
    const r = pickLeverage({ entry: 100, sl: 98, notional: 60, equity: 23, cap: 100, brackets: BR, feePct: fee }) as { leverage: number; liqDistPct: number }
    expect(r.leverage).toBe(24)
    expect(r.liqDistPct).toBeGreaterThan(2 * 1.5)
  })

  it('config cap and the bracket of the notional both apply', () => {
    expect(pickLeverage({ entry: 100, sl: 99.9, notional: 60, equity: 23, cap: 10, brackets: BR, feePct: fee })).toMatchObject({ leverage: 10 })
    expect(pickLeverage({ entry: 100, sl: 99.9, notional: 6000, equity: 1000, cap: 100, brackets: BR, feePct: fee })).toMatchObject({ leverage: 20 })
  })

  it('refuses when the margin would need more leverage than is safe', () => {
    // SL 5 %: safe = floor(1 / (1 % + 7.5 % + 0.09 %)) = 11, but notional 300 on equity 23 needs 14×
    expect(pickLeverage({ entry: 100, sl: 95, notional: 300, equity: 23, cap: 100, brackets: BR, feePct: fee })).toMatch(/aman maks 11×/)
  })
})

describe('LiveBroker.closeNow (manual)', () => {
  const mk = (pos: boolean) => {
    const calls: string[] = []
    const client = {
      cancelOrder: async () => (calls.push('cancelEntry'), null),
      position: async () => (pos ? { positionAmt: '-255' } : null),
      marketClose: async (_s: string, q: number) => void calls.push(`market ${q}`),
      cancelAll: async () => void calls.push('cancelAll'),
      realised: async () => ({ pnl: 0.4, lastPrice: 0.548, lastTime: 7 })
    }
    return { broker: new LiveBroker(client as never), calls }
  }
  const t = { id: 'z', symbol: 'ETHFIUSDT', direction: 'bearish', status: 'open', entryOrderId: 'smc-z-e', createdAt: 0, filledAt: 1 } as unknown as BotTrade

  it('open: market close while the SL is still there, then remove SL/TP', async () => {
    const { broker, calls } = mk(true)
    expect(await broker.closeNow(t)).toMatchObject({ status: 'closed', reason: 'manual-close', pnl: 0.4 })
    expect(calls).toEqual(['market -255', 'cancelAll'])
  })

  it('pending without fill: just cancelled', async () => {
    const { broker, calls } = mk(false)
    expect(await broker.closeNow({ ...t, status: 'pending' } as BotTrade)).toMatchObject({ status: 'cancelled', reason: 'manual' })
    expect(calls).toEqual(['cancelEntry', 'cancelAll'])
  })
})
