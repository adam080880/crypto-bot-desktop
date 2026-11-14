import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { BotEventLevel, BotState, BotTrade } from '@shared/bot'
import type { BotConfig, NewsConfig, RiskConfig, SmcConfig } from '@shared/config'
import type { ScreenerRow } from '@shared/screener'
import { TF_MS } from '@shared/timeframes'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { logger } from '../logger'
import { BinanceTradeClient, topCrypto, type ExchangeSymbol } from './binanceTrade'
import { FEES, LiveBroker, PaperBroker, type Bar, type Broker } from './brokers'
import { accountGate, claudeGate, knownAt, setupGate, type Candidate } from './gate'
import { BotRepo } from './repo'
import { planOrder, type SymbolRules } from './sizing'

const log = logger('bot')
const TICK_MS = 5_000
const UNIVERSE_MS = 60 * 60_000
const DAY = 86_400_000
const PAPER_SINCE = 'bot_paper_since'

export interface BotDeps {
  getBot: () => BotConfig
  getRisk: () => RiskConfig
  getSmc: () => SmcConfig
  getNews: () => NewsConfig
  getKeys: () => { key: string; secret: string } | null
  isKilled: () => boolean
  /** Active news window title, or null. */
  newsWindow: () => string | null
  /** Ask Claude to analyse these symbols (resolves when the run is over). */
  requestClaude: (symbols: string[]) => Promise<void>
  /** Symbols the bot needs streamed live (universe + active trades). */
  setStreams: (symbols: string[]) => void
  /** Symbols with local 1m history (the screener only scans these). */
  syncedSymbols: () => Set<string>
  /** Public market metadata (injectable for tests). */
  market?: Pick<BinanceTradeClient, 'exchangeSymbols' | 'quoteVolumes'>
}

/**
 * Fase 7 bot (runs in the data worker next to the screener and Claude).
 * Screener setups → setup / account / Claude gates → risk-sized limit entry with its SL placed
 * together → TP after the fill → booked on exit. Paper by default; live only after confirmation.
 */
export class BotService extends EventEmitter<{ state: [BotState] }> {
  private readonly repo: BotRepo
  private readonly paper: PaperBroker
  private live: LiveBroker | null = null
  private liveKey = ''
  private readonly market: Pick<BinanceTradeClient, 'exchangeSymbols' | 'quoteVolumes'>
  private universe = new Set<string>()
  private rules = new Map<string, SymbolRules>()
  private universeAt: number | null = null
  private bars = new Map<string, Bar>()
  private lastRows: ScreenerRow[] = []
  private awaiting = new Set<string>()
  private requested = new Set<string>()
  private logged = new Map<string, string>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private equityCache: { v: number; at: number } | null = null
  private lastError: string | null = null

  constructor(
    private readonly db: Db,
    private readonly deps: BotDeps
  ) {
    super()
    this.repo = new BotRepo(db)
    this.market = deps.market ?? new BinanceTradeClient()
    this.paper = new PaperBroker(() => this.paperEquity())
  }

  // ---------- lifecycle ----------

  start(): void {
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS)
    void this.refreshUniverse().then(() => this.publish())
  }

  /** Config changed (enable/disable, live switch, keys). */
  configure(): void {
    const k = this.deps.getKeys()
    const id = k ? `${k.key}:${k.secret.length}` : ''
    if (id !== this.liveKey) {
      this.liveKey = id
      this.live = k ? new LiveBroker(new BinanceTradeClient(k.key, k.secret)) : null
      this.liveChecked = false
    }
    this.updateStreams()
    this.publish()
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
  }

  private liveChecked = false

  /** One-time safety checks before the first live order. */
  private async liveReady(): Promise<string | null> {
    if (!this.live) return 'API key Binance belum diisi'
    if (this.liveChecked) return null
    const k = this.deps.getKeys()!
    const c = new BinanceTradeClient(k.key, k.secret)
    await c.syncTime()
    if (await c.isHedgeMode()) return 'akun Binance di Hedge Mode; bot butuh One-way Mode'
    this.live = new LiveBroker(c)
    this.liveChecked = true
    return null
  }

  // ---------- inputs ----------

  /** Every live 1m kline message (forming or closed) for streamed symbols. */
  onKline(symbol: string, h: number, l: number, c: number): void {
    const b = this.bars.get(symbol)
    if (b) {
      b.high = Math.max(b.high, h)
      b.low = Math.min(b.low, l)
      b.last = c
    } else this.bars.set(symbol, { high: h, low: l, last: c })
  }

  onScreener(rows: ScreenerRow[]): Promise<void> {
    this.lastRows = rows
    return this.evaluate()
  }

  onClaudeDone(): void {
    if (this.awaiting.size) void this.evaluate()
  }

  /** Kill switch: cancel every pending entry. Open positions keep their SL + TP. */
  async kill(): Promise<void> {
    for (const t of this.repo.active().filter((x) => x.status === 'pending')) await this.cancelTrade(t, 'kill')
    this.event('warn', null, 'Kill Switch: semua limit entry dibatalkan, posisi terbuka tetap dengan SL/TP')
    this.publish()
  }

  /** Cancel one pending trade from the UI. */
  async cancelById(id: string): Promise<void> {
    const t = this.repo.active().find((x) => x.id === id)
    if (t?.status === 'pending') await this.cancelTrade(t, 'manual')
    this.publish()
  }

  /** For the Claude prompt. */
  positionsNote(): string {
    const act = this.repo.active()
    if (!act.length) return `tidak ada (mode ${this.mode()})`
    return act
      .map((t) => `${t.symbol} ${t.direction === 'bullish' ? 'LONG' : 'SHORT'} ${t.status === 'open' ? 'posisi terbuka' : 'limit menunggu'} entry ${t.entry} SL ${t.sl} TP ${t.tp} (${t.mode})`)
      .join('; ')
  }

  resetPaper(): void {
    writeSetting(this.db, PAPER_SINCE, Date.now())
    this.event('info', null, `Akun paper di-reset ke ${this.deps.getBot().paperEquity} USDT`)
    this.publish()
  }

  // ---------- state ----------

  private mode(): 'paper' | 'live' {
    return this.deps.getBot().live ? 'live' : 'paper'
  }

  private paperEquity(): number {
    const since = readSetting(this.db, PAPER_SINCE, z.number()) ?? 0
    return this.deps.getBot().paperEquity + this.repo.pnlSince('paper', since)
  }

  private broker(mode: 'paper' | 'live'): Broker | null {
    return mode === 'paper' ? this.paper : this.live
  }

  private async equity(): Promise<number> {
    if (this.mode() === 'paper') return this.paperEquity()
    if (this.equityCache && Date.now() - this.equityCache.at < 30_000) return this.equityCache.v
    const v = await this.live!.equity()
    this.equityCache = { v, at: Date.now() }
    return v
  }

  private event(level: BotEventLevel, symbol: string | null, message: string): void {
    this.repo.log(level, symbol, message)
    if (level === 'error' || level === 'warn') log.warn({ symbol }, message)
    else log.info({ symbol }, message)
  }

  /** Log a skip once per setup + reason (scans repeat every 15 minutes). */
  private skip(key: string, symbol: string, reason: string): void {
    if (this.logged.get(key) === reason) return
    this.logged.set(key, reason)
    if (this.logged.size > 2000) this.logged.clear()
    this.event('skip', symbol, reason)
  }

  private blockedReason(equityDayStart: number | null, pnlToday: number): string | null {
    const bot = this.deps.getBot()
    if (!bot.enabled) return 'bot mati'
    return accountGate({
      killSwitch: this.deps.isKilled(),
      newsWindow: this.deps.newsWindow(),
      newsStrategy: this.deps.getNews().newsStrategyEnabled,
      activeTrades: this.repo.active().filter((t) => t.mode === this.mode()).length,
      risk: this.deps.getRisk(),
      pnlToday,
      equityDayStart
    })
  }

  private dayStart(): number {
    return Math.floor(Date.now() / DAY) * DAY
  }

  private updateStreams(): void {
    const bot = this.deps.getBot()
    const active = this.repo.active().map((t) => t.symbol)
    this.deps.setStreams(bot.enabled ? [...new Set([...this.universe, ...active])] : active)
  }

  async publish(): Promise<void> {
    const bot = this.deps.getBot()
    const mode = this.mode()
    let equity: number | null = null
    try {
      equity = mode === 'paper' ? this.paperEquity() : this.live ? await this.equity() : null
    } catch (err) {
      this.lastError = (err as Error).message
    }
    const pnlToday = this.repo.pnlSince(mode, this.dayStart())
    const state: BotState = {
      enabled: bot.enabled,
      live: bot.live,
      blocked: this.blockedReason(equity === null ? null : equity - pnlToday, pnlToday),
      equity,
      equityAt: Date.now(),
      pnlToday,
      universe: { count: this.universe.size, updatedAt: this.universeAt },
      awaitingClaude: [...this.awaiting],
      trades: this.repo.recent(100),
      events: this.repo.events(200),
      lastError: this.lastError
    }
    this.emit('state', state)
  }

  // ---------- universe ----------

  private exchange: ExchangeSymbol[] = []

  private async refreshUniverse(): Promise<void> {
    try {
      if (!this.exchange.length || !this.universeAt || Date.now() - this.universeAt > UNIVERSE_MS) {
        this.exchange = await this.market.exchangeSymbols()
        this.rules = new Map(this.exchange.map((s) => [s.symbol, s.rules]))
      }
      const volumes = await this.market.quoteVolumes()
      const synced = this.deps.syncedSymbols()
      const top = topCrypto(this.exchange, volumes, this.deps.getBot().topVolume)
      this.universe = new Set(top.filter((s) => synced.has(s)))
      this.universeAt = Date.now()
      const missing = top.length - this.universe.size
      this.event('info', null, `Universe: ${this.universe.size} koin crypto top ${this.deps.getBot().topVolume} volume${missing ? ` (${missing} belum punya data lokal, dilewati)` : ''}`)
      this.updateStreams()
    } catch (err) {
      this.lastError = `universe: ${(err as Error).message}`
      log.warn({ err: (err as Error).message }, 'universe refresh failed')
    }
  }

  // ---------- entries ----------

  /** Exposed for tests; normally triggered by screener results and Claude runs. */
  async evaluate(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.evaluateInner()
    } catch (err) {
      this.lastError = (err as Error).message
      this.event('error', null, `evaluasi gagal: ${(err as Error).message}`)
    } finally {
      this.busy = false
      void this.publish()
    }
  }

  private async evaluateInner(): Promise<void> {
    const bot = this.deps.getBot()
    if (!bot.enabled) return
    if (!this.universeAt || Date.now() - this.universeAt > UNIVERSE_MS) await this.refreshUniverse()
    const mode = this.mode()
    if (mode === 'live') {
      const notReady = await this.liveReady()
      if (notReady) {
        this.lastError = notReady
        return
      }
    }
    const smc = this.deps.getSmc()
    const now = Date.now()
    const candidates = this.lastRows.filter((r): r is Candidate => !!r.setup)
    const wantClaude: string[] = []

    for (const c of candidates) {
      const key = `${c.setup.id}|${mode}`
      if (this.repo.hasSetup(c.setup.id, mode)) continue
      const live = this.bars.get(c.symbol)
      const row = live ? { ...c, price: live.last } : c
      const sg = setupGate(row, { bot, entryTf: smc.entryTimeframe, universe: this.universe, now })
      if (sg) {
        // only log setups that were plausible for the bot (in universe, HTF POI)
        if (this.universe.has(c.symbol) && (bot.poiTimeframes as string[]).includes(c.setup.poi.timeframe)) this.skip(key, c.symbol, sg)
        continue
      }
      const equity = await this.equity()
      const pnlToday = this.repo.pnlSince(mode, this.dayStart())
      const blocked = this.blockedReason(equity - pnlToday, pnlToday)
      if (blocked) {
        this.skip(key, c.symbol, `setup ${c.direction === 'bullish' ? 'LONG' : 'SHORT'} dilewati: ${blocked}`)
        continue
      }
      if (this.repo.active().some((t) => t.symbol === c.symbol)) {
        this.skip(key, c.symbol, 'sudah ada order/posisi bot di koin ini')
        continue
      }
      const a = this.repo.latestAnalysis(c.symbol)
      const cg = claudeGate(row, a, { bot, entryTf: smc.entryTimeframe, now })
      if (!cg.ok) {
        if (cg.request && !this.requested.has(c.setup.id)) {
          this.requested.add(c.setup.id)
          wantClaude.push(c.symbol)
        } else this.skip(key, c.symbol, cg.reason)
        continue
      }
      await this.enter(row, a!, equity)
    }

    if (wantClaude.length) {
      const list = [...new Set(wantClaude)].filter((s) => !this.awaiting.has(s))
      if (list.length) {
        for (const s of list) this.awaiting.add(s)
        this.event('info', null, `Minta analisis Claude untuk ${list.join(', ')}`)
        void this.publish()
        this.deps
          .requestClaude(list)
          .catch((err) => this.event('error', null, `Claude gagal: ${(err as Error).message}`))
          .finally(() => {
            for (const s of list) this.awaiting.delete(s)
            void this.evaluate()
          })
      }
    }
  }

  private async enter(c: Candidate, a: { id: string; confidence: number }, equity: number): Promise<void> {
    const bot = this.deps.getBot()
    const risk = this.deps.getRisk()
    const smc = this.deps.getSmc()
    const mode = this.mode()
    const rules = this.rules.get(c.symbol)
    const dirLabel = c.direction === 'bullish' ? 'LONG' : 'SHORT'
    if (!rules) return this.skip(`${c.setup.id}|${mode}`, c.symbol, 'aturan order simbol belum dimuat')
    const plan = planOrder({
      direction: c.direction,
      entry: c.setup.entry,
      sl: c.setup.sl,
      tp: c.setup.tp,
      equity,
      riskPct: bot.riskPerTradePct,
      maxLeverage: risk.maxLeverage,
      rules,
      feePct: FEES.makerPct + FEES.takerPct + FEES.slippagePct
    })
    if (typeof plan === 'string') return this.skip(`${c.setup.id}|${mode}`, c.symbol, `${dirLabel} dilewati: ${plan}`)
    const id = randomUUID().replace(/-/g, '').slice(0, 20)
    const trade: BotTrade = {
      id,
      mode,
      setupId: c.setup.id,
      symbol: c.symbol,
      direction: c.direction,
      poi: { kind: c.setup.poi.kind, timeframe: c.setup.poi.timeframe },
      score: c.setup.score,
      analysisId: a.id,
      confidence: a.confidence,
      entry: plan.entry,
      sl: plan.sl,
      tp: plan.tp,
      qty: plan.qty,
      equity,
      riskUsd: plan.riskUsd,
      leverage: plan.leverage,
      status: 'pending',
      reason: null,
      createdAt: Date.now(),
      expiresAt: knownAt(c, smc.entryTimeframe) + smc.setupExpiryCandles * TF_MS[smc.entryTimeframe],
      filledAt: null,
      filledQty: null,
      closedAt: null,
      exitPrice: null,
      pnl: null,
      entryOrderId: null,
      slOrderId: null,
      tpOrderId: null
    }
    // final guard right before sending: kill switch may have been hit meanwhile
    if (this.deps.isKilled()) return
    try {
      Object.assign(trade, await this.broker(mode)!.open(trade, plan, rules))
    } catch (err) {
      this.repo.save({ ...trade, status: 'cancelled', reason: 'error', closedAt: Date.now() })
      this.event('error', c.symbol, `${dirLabel} gagal dipasang: ${(err as Error).message}`)
      return
    }
    this.repo.save(trade)
    this.event(
      'order',
      c.symbol,
      `${mode.toUpperCase()} ${dirLabel} limit ${plan.entry} · SL ${plan.sl} · TP ${plan.tp} · qty ${plan.qty} (${plan.notional.toFixed(2)} USDT, ${plan.leverage}×) · risk ${plan.riskUsd.toFixed(3)} USDT · ${c.setup.poi.kind} ${c.setup.poi.timeframe} · Claude ${a.confidence}`
    )
    this.updateStreams()
  }

  // ---------- follow-up ----------

  private async cancelTrade(t: BotTrade, reason: string): Promise<void> {
    const b = this.broker(t.mode)
    if (!b) return
    try {
      const patch = await b.cancel(t, reason, this.rules.get(t.symbol))
      const next = { ...t, ...patch }
      this.repo.save(next)
      this.event(next.status === 'open' ? 'warn' : 'order', t.symbol, next.status === 'open' ? `entry sebagian terisi (${next.filledQty}), lanjut dengan SL/TP` : `limit dibatalkan (${reason})`)
    } catch (err) {
      this.event('error', t.symbol, `gagal batal order: ${(err as Error).message}`)
    }
  }

  /** Exposed for tests; normally driven by the 5 s timer. */
  async tick(): Promise<void> {
    const active = this.repo.active()
    if (!active.length) {
      this.bars.clear()
      return
    }
    const bars = this.bars
    this.bars = new Map()
    let changed = false
    for (const t of active) {
      const b = this.broker(t.mode)
      if (!b) continue
      const bar = bars.get(t.symbol) ?? null
      if (bar) this.onKline(t.symbol, bar.last, bar.last, bar.last) // keep last price for the next evaluation
      try {
        const bull = t.direction === 'bullish'
        let patch = null as Awaited<ReturnType<Broker['sync']>>
        if (t.status === 'pending') {
          // live: the exchange is the truth, so look for a fill first
          if (t.mode === 'live') patch = await b.sync(t, bar, this.rules.get(t.symbol))
          if (!patch) {
            // TP reached before the fill → missed (same conservative rule as the detector/backtest)
            if (bar && (bull ? bar.high >= t.tp : bar.low <= t.tp)) {
              await this.cancelTrade(t, 'missed')
              changed = true
              continue
            }
            if (Date.now() > t.expiresAt) {
              await this.cancelTrade(t, 'expired')
              changed = true
              continue
            }
          }
        }
        if (!patch) patch = await b.sync(t, bar, this.rules.get(t.symbol))
        if (!patch) continue
        const next = { ...t, ...patch }
        this.repo.save(next)
        changed = true
        if (next.status === 'open' && t.status === 'pending') this.event('order', t.symbol, `entry terisi @${t.entry} (qty ${next.filledQty}), SL ${t.sl} / TP ${t.tp} aktif`)
        if (next.status === 'closed') {
          this.equityCache = null
          this.event(next.pnl! >= 0 ? 'order' : 'warn', t.symbol, `posisi ditutup (${next.reason}) @${next.exitPrice ?? '?'} · PnL ${next.pnl!.toFixed(3)} USDT`)
        }
        if (next.status === 'cancelled') this.event('order', t.symbol, `order hilang/dibatalkan di exchange (${next.reason})`)
      } catch (err) {
        this.lastError = (err as Error).message
        log.warn({ trade: t.id, err: (err as Error).message }, 'sync failed')
      }
    }
    if (changed) {
      this.updateStreams()
      void this.publish()
    }
  }
}
