import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { botConfigSchema, exitConfigSchema, newsConfigSchema, riskConfigSchema, smcConfigSchema } from '@shared/config'
import type { ScreenerRow, ScreenerSetup } from '@shared/screener'
import { openDatabase } from '../db/client'
import { BotService, type BotDeps } from './botService'

const RULES = { tickSize: 0.001, stepSize: 1, minQty: 1, minNotional: 5 }
const SETUP = (now: number): ScreenerSetup => ({
  id: 'set-1',
  model: 'M1',
  entry: 1,
  sl: 0.99,
  tp: 1.05,
  tpLiquidity: 1.05,
  rr: 5,
  score: 5,
  confluence: ['fvg', 'trendParent', 'pdZone', 'liqHtfBehind'],
  status: 'pending',
  createdT: now - 20 * 60_000,
  poi: { kind: 'OB', timeframe: '4h', origin: 'sweep' },
  child: { kind: 'QM', timeframe: '15m' }
})

function setup(overrides: Partial<BotDeps> = {}, botCfg: object = { requireClaude: true }) {
  const db = openDatabase({ path: ':memory:', migrationsFolder: resolve('drizzle') })
  const now = Date.now()
  const claudeCalls: string[][] = []
  let killed = false
  const deps: BotDeps = {
    getBot: () => botConfigSchema.parse({ enabled: true, paperEquity: 100, modelConfluenceAny: {}, ...botCfg }),
    getExit: () => exitConfigSchema.parse({ orderFlowHold: false }),
    getRisk: () => riskConfigSchema.parse({}),
    getSmc: () => smcConfigSchema.parse({}),
    getNews: () => newsConfigSchema.parse({}),
    getKeys: () => null,
    isKilled: () => killed,
    newsWindow: () => null,
    requestClaude: async (symbols) => {
      claudeCalls.push(symbols)
      for (const s of symbols)
        db.$client
          .prepare(`INSERT INTO claude_analyses (id, run_id, created_at, symbol, bias, confidence, price, forced_skip, payload) VALUES (?, 'r', ?, ?, 'long', 80, 1, 0, '{}')`)
          .run(`a-${s}`, Date.now(), s)
    },
    setStreams: () => {},
    syncedSymbols: () => new Set(['AAAUSDT', 'BBBUSDT']),
    market: {
      exchangeSymbols: async () =>
        ['AAAUSDT', 'BBBUSDT', 'XAUUSDT'].map((symbol) => ({
          symbol,
          underlyingType: symbol === 'XAUUSDT' ? 'COMMODITY' : 'COIN',
          underlyingSubType: symbol === 'XAUUSDT' ? ['TradFi'] : ['Crypto'],
          contractType: 'PERPETUAL',
          status: 'TRADING',
          quoteAsset: 'USDT',
          rules: RULES
        })),
      quoteVolumes: async () => new Map([['AAAUSDT', 10], ['BBBUSDT', 5], ['XAUUSDT', 99]])
    },
    ...overrides
  }
  const bot = new BotService(db, deps)
  const row: ScreenerRow = {
    symbol: 'AAAUSDT',
    direction: 'bullish',
    price: 1.01,
    dataT: now,
    setup: SETUP(now),
    setups: [SETUP(now)],
    nearPoi: null,
    trendAligned: true,
    trend: { '4h': 'bullish', '1h': 'bullish', '15m': 'bullish' },
    recentBos: null
  }
  return { db, bot, row, claudeCalls, kill: () => (killed = true) }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('BotService (paper, end to end)', () => {
  it('asks Claude, enters with risk sizing, then books the TP', async () => {
    const { bot, row, claudeCalls } = setup()
    const states: import('@shared/bot').BotState[] = []
    bot.on('state', (s) => states.push(s))

    await bot.onScreener([row])
    await wait(20) // Claude request resolves → re-evaluation
    expect(claudeCalls).toEqual([['AAAUSDT']])
    await bot.evaluate()
    await bot.publish()
    const st = states.at(-1)!
    const t = st.trades[0]!
    expect(t).toMatchObject({ mode: 'paper', symbol: 'AAAUSDT', status: 'pending', entry: 1, sl: 0.99, tp: 1.05, confidence: 80 })
    // 1% of 100 = 1 USDT risk; 0.01 + fees per unit → 84 units
    expect(t.qty).toBe(84)
    expect(t.riskUsd).toBeLessThanOrEqual(1)

    // same setup is never entered twice
    await bot.onScreener([row])
    await bot.publish()
    expect(states.at(-1)!.trades).toHaveLength(1)

    bot.onKline('AAAUSDT', 1.005, 0.999, 1.0) // fills
    await bot.tick()
    bot.onKline('AAAUSDT', 1.051, 1.02, 1.05) // TP
    await bot.tick()
    await bot.publish()
    const done = states.at(-1)!.trades[0]!
    expect(done).toMatchObject({ status: 'closed', reason: 'tp' })
    expect(done.pnl!).toBeGreaterThan(84 * 0.05 * 0.99)
    expect(states.at(-1)!.equity).toBeCloseTo(100 + done.pnl!)
  })

  it('cancels the limit when price reaches the TP first (missed)', async () => {
    const { bot, row } = setup()
    await bot.onScreener([row])
    await wait(20)
    await bot.evaluate()
    bot.onKline('AAAUSDT', 1.06, 1.003, 1.055)
    await bot.tick()
    const states: import('@shared/bot').BotState[] = []
    bot.on('state', (s) => states.push(s))
    await bot.publish()
    expect(states[0]!.trades[0]).toMatchObject({ status: 'cancelled', reason: 'missed', pnl: null })
  })

  it('does nothing while the kill switch is active, and kill cancels pending entries', async () => {
    const a = setup()
    a.kill()
    await a.bot.onScreener([a.row])
    await wait(20)
    await a.bot.evaluate()
    const s1: import('@shared/bot').BotState[] = []
    a.bot.on('state', (s) => s1.push(s))
    await a.bot.publish()
    expect(s1[0]!.trades).toHaveLength(0)
    expect(s1[0]!.blocked).toMatch(/Kill Switch/)

    const b = setup()
    await b.bot.onScreener([b.row])
    await wait(20)
    await b.bot.evaluate()
    await b.bot.kill()
    const s2: import('@shared/bot').BotState[] = []
    b.bot.on('state', (s) => s2.push(s))
    await b.bot.publish()
    expect(s2[0]!.trades[0]).toMatchObject({ status: 'cancelled', reason: 'kill' })
  })

  it('skips non-crypto and low-confidence setups', async () => {
    const { bot, row, db } = setup({ requestClaude: async () => {} })
    db.$client
      .prepare(`INSERT INTO claude_analyses (id, run_id, created_at, symbol, bias, confidence, price, forced_skip, payload) VALUES ('x', 'r', ?, 'AAAUSDT', 'long', 50, 1, 0, '{}')`)
      .run(Date.now())
    await bot.onScreener([row, { ...row, symbol: 'XAUUSDT', setup: { ...row.setup!, id: 'set-x' }, setups: [{ ...row.setup!, id: 'set-x' }] }])
    const states: import('@shared/bot').BotState[] = []
    bot.on('state', (s) => states.push(s))
    await bot.publish()
    expect(states[0]!.trades).toHaveLength(0)
    expect(states[0]!.events.map((e) => e.message).join('\n')).toMatch(/confidence 50 < 70/)
  })

  it('enters without Claude when requireClaude is off (pure ICT math)', async () => {
    const { bot, row, claudeCalls } = setup({}, { requireClaude: false })
    const states: import('@shared/bot').BotState[] = []
    bot.on('state', (s) => states.push(s))
    await bot.onScreener([row])
    await bot.publish()
    expect(claudeCalls).toHaveLength(0)
    expect(states.at(-1)!.trades[0]).toMatchObject({ status: 'pending', model: 'M1', analysisId: null, confidence: null })
  })

  it('retry: a failed entry is re-checked through the gates and placed again', async () => {
    const { db, bot, row } = setup({}, { requireClaude: false })
    await bot.onScreener([row])
    const first = db.$client.prepare(`SELECT id FROM bot_trades`).pluck().get() as string
    // pretend the exchange refused it
    const t = JSON.parse(db.$client.prepare(`SELECT payload FROM bot_trades WHERE id = ?`).pluck().get(first) as string)
    db.$client.prepare(`UPDATE bot_trades SET status = 'cancelled', payload = ? WHERE id = ?`).run(JSON.stringify({ ...t, status: 'cancelled', reason: 'error' }), first)
    await bot.retryById(first)
    const rows = db.$client.prepare(`SELECT status, json_extract(payload, '$.reason') AS reason FROM bot_trades ORDER BY created_at`).all()
    expect(rows).toEqual([
      { status: 'cancelled', reason: 'retried' },
      { status: 'pending', reason: null }
    ])
    // retrying a non-error row does nothing
    await bot.retryById(first)
    expect(db.$client.prepare(`SELECT count(*) FROM bot_trades`).pluck().get()).toBe(2)
  })

  it('shadow paper: an M8 setup goes to the paper account while the bot is live (never a live order)', async () => {
    const { bot, row } = setup({}, { requireClaude: false, live: true })
    const m8: ScreenerSetup = { ...SETUP(Date.now()), id: 'set-m8', model: 'M8', sl: 0.98, tp: 1.04, tpLiquidity: null, rr: 2, confluence: ['liqTarget', 'dispStrong'], poi: { kind: 'RBS', timeframe: '4h', origin: null }, child: { kind: 'LEVEL', timeframe: '15m' } }
    const states: import('@shared/bot').BotState[] = []
    bot.on('state', (s) => states.push(s))
    // live has no API key → live setups (the M1 on BBB) are not placed, the shadow M8 still is
    await bot.onScreener([
      { ...row, setup: m8, setups: [m8] },
      { ...row, symbol: 'BBBUSDT', setup: { ...row.setup!, id: 'set-live' }, setups: [{ ...row.setup!, id: 'set-live' }] }
    ])
    await bot.publish()
    const st = states.at(-1)!
    expect(st.trades).toHaveLength(1)
    expect(st.trades[0]).toMatchObject({ mode: 'paper', model: 'M8', symbol: 'AAAUSDT', status: 'pending', tp: 1.06 }) // M8 TP 3R (smc.m8TpR)
    expect(st.shadowStats).not.toBeNull()
    expect(st.events.map((e) => e.message).join('\n')).toMatch(/PAPER \(shadow\) LONG/)
  })

  it('tiered exit: 1R → BE incl. fee, 3R → half off + SL to 1R, rest stopped in profit', async () => {
    const { bot, row } = setup({}, { requireClaude: false })
    const states: import('@shared/bot').BotState[] = []
    bot.on('state', (s) => states.push(s))
    await bot.onScreener([row])
    bot.onKline('AAAUSDT', 1.005, 0.999, 1.0) // fills
    await bot.tick()
    const m = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
    await bot.onClosed1m('AAAUSDT', { t: m, o: 1.0, h: 1.011, l: 1.0, c: 1.01, v: 1 }) // ≥ 1R
    await bot.publish()
    expect(states.at(-1)!.trades[0]!.sl).toBe(1.001) // BE + fees, nearest tick
    await bot.onClosed1m('AAAUSDT', { t: m + 60_000, o: 1.01, h: 1.031, l: 1.009, c: 1.03, v: 1 }) // ≥ 3R
    await bot.publish()
    const t = states.at(-1)!.trades[0]!
    expect(t).toMatchObject({ closedQty: 42, partials: 1, sl: 1.01 })
    expect(t.realized).toBeGreaterThan(0)
    bot.onKline('AAAUSDT', 1.012, 1.0095, 1.0098) // back to 1R
    await bot.tick()
    await bot.publish()
    const done = states.at(-1)!.trades[0]!
    expect(done).toMatchObject({ status: 'closed', reason: 'trail' })
    expect(done.pnl!).toBeGreaterThan(t.realized) // the rest also closed in profit
  })
})
