import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { modelStats, tradeR, tradeStats, type BotEventLevel, type BotState, type BotTrade } from '@shared/bot'
import type { BotConfig, ExitConfig, NewsConfig, RiskConfig, SmcConfig } from '@shared/config'
import type { Candle } from '@shared/candles'
import { MODEL_LABEL, setupPath } from '@shared/smc'
import type { ScreenerRow } from '@shared/screener'
import { TF_MS } from '@shared/timeframes'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'
import { logger } from '../logger'
import { BinanceTradeClient, topCrypto, type ExchangeSymbol } from './binanceTrade'
import { FEES, LiveBroker, PaperBroker, openQty, type Bar, type Broker } from './brokers'
import { slBlacklist } from './blacklist'
import { fmtR, rAt, targetsText, tpText } from './rText'
import { accountGate, candidatesOf, claudeGate, directionGate, exitFor, knownAt, planTpFor, setupGate, type Candidate } from './gate'
import type { CoinProfile } from '@shared/backtest'
import { BotRepo } from './repo'
import { pickLeverage, planOrder, roundStep, type LeverageBracket, type SymbolRules } from './sizing'
import { ExitTracker } from '../strategy/exit'

const log = logger('bot')
const TICK_MS = 5_000
const UNIVERSE_MS = 60 * 60_000
const DAY = 86_400_000
const PAPER_SINCE = 'bot_paper_since'

export interface BotDeps {
  getBot: () => BotConfig
  getRisk: () => RiskConfig
  getSmc: () => SmcConfig
  /** Tiered exit / order flow plan (frozen into each trade at entry). */
  getExit: () => ExitConfig
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
  /** Coin profiles chosen in the backtest Meta table (symbol → profile). */
  getProfiles?: () => Record<string, CoinProfile>
  /** Stored 1m candles of a symbol from `from` (to rebuild exit trackers after a restart). */
  minuteCandles?: (symbol: string, from: number) => Candle[]
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
  private lastPx = new Map<string, number>()
  private lastRows: ScreenerRow[] = []
  private awaiting = new Set<string>()
  private requested = new Set<string>()
  private logged = new Map<string, string>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private equityCache: { v: number; at: number } | null = null
  private lastError: string | null = null
  /** Tiered exit per open trade (id → tracker), fed with closed 1m candles. */
  private trackers = new Map<string, ExitTracker>()
  private reconciling = new Set<string>()

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
    if (await c.isMultiAssets()) return 'akun Binance di Multi-Assets Mode; bot butuh Single-Asset Mode (isolated margin)'
    this.live = new LiveBroker(c)
    this.liveChecked = true
    return null
  }

  // ---------- inputs ----------

  /** Every live 1m kline message (forming or closed) for streamed symbols. */
  onKline(symbol: string, h: number, l: number, c: number): void {
    this.lastPx.set(symbol, c)
    const b = this.bars.get(symbol)
    if (b) {
      b.high = Math.max(b.high, h)
      b.low = Math.min(b.low, l)
      b.last = c
    } else this.bars.set(symbol, { high: h, low: l, last: c })
  }

  /**
   * Closed 1m candle of a streamed symbol: drives the tiered exit + order flow of open trades
   * (same ExitTracker as the backtest), then applies stop moves / partials through the broker.
   */
  async onClosed1m(symbol: string, k: Candle): Promise<void> {
    for (const t of this.repo.active()) {
      if (t.symbol !== symbol || t.status !== 'open' || !t.exitPlan) continue
      if (t.filledAt !== null && k.t + 60_000 <= t.filledAt) continue
      const tr = this.tracker(t, k.t)
      if (!tr) continue
      tr.bar(k, t.filledAt !== null && k.t <= t.filledAt && t.filledAt < k.t + 60_000)
      await this.reconcile(t, tr)
    }
  }

  /** Tracker of an open trade; rebuilt from stored 1m candles (open time < `before`) after a restart. */
  private tracker(t: BotTrade, before: number): ExitTracker | null {
    let tr = this.trackers.get(t.id)
    if (tr || !t.exitPlan) return tr ?? null
    tr = new ExitTracker(t.direction, t.entry, t.slInitial, t.tp, t.exitPlan, { makerFeePct: FEES.makerPct, takerFeePct: FEES.takerPct, slippagePct: FEES.slippagePct }, this.deps.getSmc().slBufferPct)
    const fillMinute = Math.floor((t.filledAt ?? Date.now()) / 60_000) * 60_000
    for (const k of this.deps.minuteCandles?.(t.symbol, fillMinute) ?? []) if (k.t < before) tr.bar(k, k.t === fillMinute)
    this.trackers.set(t.id, tr)
    return tr
  }

  /** Apply the tracker's decisions: ladder partials first, then the stop. */
  private async reconcile(t: BotTrade, tr: ExitTracker): Promise<void> {
    if (this.reconciling.has(t.id)) return
    this.reconciling.add(t.id)
    try {
      const b = this.broker(t.mode)
      const rules = this.rules.get(t.symbol)
      if (!b || !rules) return
      let cur = t
      const r = tr.result()
      const ladder = r.fills.filter((f) => f.reason === 'ladder')
      for (const f of ladder.slice(cur.partials ?? 0)) {
        const total = cur.filledQty ?? cur.qty
        const qty = Math.min(roundStep(total * f.frac, rules.stepSize, 'floor'), openQty(cur))
        if (qty <= 0 || qty >= openQty(cur)) {
          cur = { ...cur, partials: (cur.partials ?? 0) + 1 }
          continue
        }
        cur = { ...cur, ...(await b.partialClose(cur, qty, f.price, rules)) }
        this.event('order', t.symbol, `TP sebagian ${qty} @${f.price} (${Math.round(f.frac * 100)}%, ${fmtR(rAt(t, f.price))})`)
      }
      const bull = t.direction === 'bullish'
      // nearest tick: a break-even stop rounded away from price would no longer cover the fees
      const sl = roundStep(r.sl, rules.tickSize, 'round')
      if (!r.done && (bull ? sl > cur.sl : sl < cur.sl)) {
        cur = { ...cur, ...(await b.moveStop(cur, sl, rules)) }
        const why = r.holding ? 'order flow' : (bull ? sl >= t.entry : sl <= t.entry) ? 'BE/trailing' : 'trailing'
        this.event('order', t.symbol, `SL dipindah ke ${sl} (${why}, kunci ${fmtR(rAt(t, sl))})`)
      }
      const state = { bestR: Math.round(r.mfeR * 100) / 100, holding: r.holding, holds: r.orderFlowHolds }
      if (r.holding && !t.exitState?.holding) this.event('info', t.symbol, 'order flow terkonfirmasi → posisi ditahan sampai TP / close manual')
      if (!r.holding && t.exitState?.holding) this.event('warn', t.symbol, 'order flow patah → trailing bertingkat jalan lagi')
      cur = { ...cur, exitState: state }
      if (JSON.stringify(cur) !== JSON.stringify(t)) {
        this.repo.save(cur)
        void this.publish()
      }
    } catch (err) {
      this.event('error', t.symbol, `kelola exit gagal: ${(err as Error).message}`)
    } finally {
      this.reconciling.delete(t.id)
    }
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

  /**
   * Retry an entry that failed to place (status cancelled, reason 'error'). Not a blind resend: the row
   * is marked 'retried' and the setup goes through every gate again with current data.
   */
  async retryById(id: string): Promise<void> {
    const t = this.repo.get(id)
    if (!t || t.status !== 'cancelled' || t.reason !== 'error') return
    const dir = t.direction === 'bullish' ? 'LONG' : 'SHORT'
    this.repo.save({ ...t, reason: 'retried' })
    const mode = this.mode()
    const key = `${t.setupId}|${mode}`
    const stillThere = candidatesOf(this.lastRows).some((c) => c.setup.id === t.setupId)
    if (!this.deps.getBot().enabled) this.event('warn', t.symbol, `Retry ${dir}: bot lagi mati, start dulu`)
    else if (!stillThere) this.event('warn', t.symbol, `Retry ${dir}: setup sudah nggak ada / nggak pending lagi di scan terakhir, nggak dipasang`)
    else {
      this.event('info', t.symbol, `Retry ${dir}: setup dicek ulang`)
      this.logged.delete(key)
      while (this.busy) await new Promise((r) => setTimeout(r, 200))
      await this.evaluate()
      if (!this.repo.hasSetup(t.setupId, mode)) {
        const why = this.logged.get(key) ?? 'syarat entry nggak terpenuhi sekarang'
        this.event('warn', t.symbol, `Retry ${dir}: nggak dipasang (${why})`)
      }
    }
    this.publish()
  }

  /** Manual close from the UI: pending → cancel the limit, open → close at market (SL stays until flat). */
  async closeById(id: string): Promise<void> {
    const t = this.repo.active().find((x) => x.id === id)
    const b = t && this.broker(t.mode)
    if (!t || !b) return
    const dir = t.direction === 'bullish' ? 'LONG' : 'SHORT'
    try {
      const patch = await b.closeNow(t, this.lastPx.get(t.symbol) ?? null)
      const next = { ...t, ...patch }
      this.repo.save(next)
      this.trackers.delete(t.id)
      this.equityCache = null
      if (next.status === 'closed') this.event('warn', t.symbol, `${dir} ditutup manual (market) @${next.exitPrice ?? '?'} · PnL ${(next.pnl ?? 0).toFixed(3)} USDT`)
      else this.event('order', t.symbol, `${dir} limit dibatalkan manual`)
    } catch (err) {
      this.event('error', t.symbol, `close manual ${dir} gagal: ${(err as Error).message}`)
    }
    this.updateStreams()
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
      blacklist: [...this.blacklist(this.mode(), Date.now()).values()],
      ...this.stats(bot.statsSince),
      events: this.repo.events(200),
      lastError: this.lastError
    }
    this.emit('state', state)
  }

  /** Per-model and total statistics of trades opened since `since`. */
  private stats(since: number): Pick<BotState, 'modelStats' | 'statsTotal'> {
    const ts = this.repo.closedSince(this.mode(), 0).filter((t) => t.createdAt >= since)
    return { modelStats: modelStats(ts), statsTotal: tradeStats(ts) }
  }

  /** Coins blocked by repeated SL (bot.slBlacklistCount within bot.slBlacklistHours). */
  private blacklist(mode: string, now: number) {
    const bot = this.deps.getBot()
    return slBlacklist(this.repo.closedSince(mode, now - bot.slBlacklistHours * 3_600_000), bot, now)
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
    const exit = this.deps.getExit()
    const candidates = candidatesOf(this.lastRows)
    const wantClaude: string[] = []
    const black = this.blacklist(mode, now)

    for (const c of candidates) {
      const key = `${c.setup.id}|${mode}`
      if (this.repo.hasSetup(c.setup.id, mode)) continue
      const live = this.bars.get(c.symbol)
      const row = live ? { ...c, price: live.last } : c
      const profile = this.deps.getProfiles?.()[c.symbol] ?? null
      const sg = setupGate(row, { bot, entryTf: smc.entryTimeframe, universe: this.universe, now, exit, profile, smc })
      if (sg) {
        // only log setups that were plausible for the bot (in universe, a model it trades)
        if (this.universe.has(c.symbol) && ((profile?.models ?? bot.models) as string[]).includes(c.setup.model)) this.skip(key, c.symbol, sg)
        continue
      }
      const bl = black.get(c.symbol)
      if (bl) {
        this.skip(key, c.symbol, `koin di-blacklist: ${bl.losses}× SL dalam ${bot.slBlacklistHours} jam (buka lagi ${new Date(bl.until).toISOString().slice(0, 16).replace('T', ' ')} UTC)`)
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
      const dg = directionGate(this.repo.active().filter((t) => t.mode === mode), c.direction, bot.maxSameDirection)
      if (dg) {
        this.skip(key, c.symbol, `setup ${c.direction === 'bullish' ? 'LONG' : 'SHORT'} dilewati: ${dg}`)
        continue
      }
      if (!bot.requireClaude) {
        await this.enter(row, null, equity)
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

  private async enter(c: Candidate, a: { id: string; confidence: number } | null, equity: number): Promise<void> {
    const bot = this.deps.getBot()
    const profile = this.deps.getProfiles?.()[c.symbol] ?? null
    const smc = this.deps.getSmc()
    const exit = exitFor(c.setup.model, this.deps.getExit(), profile, smc)
    const risk = this.deps.getRisk()
    const mode = this.mode()
    const rules = this.rules.get(c.symbol)
    const dirLabel = c.direction === 'bullish' ? 'LONG' : 'SHORT'
    if (!rules) return this.skip(`${c.setup.id}|${mode}`, c.symbol, 'aturan order simbol belum dimuat')
    const plan = planOrder({
      direction: c.direction,
      entry: c.setup.entry,
      sl: c.setup.sl,
      tp: planTpFor(c.setup, c.direction === 'bullish', exit),
      equity,
      riskPct: bot.riskPerTradePct,
      maxLeverage: risk.maxLeverage,
      rules,
      feePct: FEES.makerPct + FEES.takerPct + FEES.slippagePct
    })
    if (typeof plan === 'string') return this.skip(`${c.setup.id}|${mode}`, c.symbol, `${dirLabel} dilewati: ${plan}`)
    // leverage as high as is safe (margin = notional ÷ leverage; the loss at the SL stays = risk %)
    let brackets: LeverageBracket[] = []
    try {
      brackets = await this.broker(mode)!.leverageBrackets(c.symbol)
    } catch (err) {
      return this.skip(`${c.setup.id}|${mode}`, c.symbol, `${dirLabel} dilewati: bracket leverage gagal diambil (${(err as Error).message})`)
    }
    const lev = pickLeverage({ entry: plan.entry, sl: plan.sl, notional: plan.notional, equity, cap: risk.maxLeverage, brackets, feePct: FEES.makerPct + FEES.takerPct + FEES.slippagePct })
    if (typeof lev === 'string') return this.skip(`${c.setup.id}|${mode}`, c.symbol, `${dirLabel} dilewati: ${lev}`)
    plan.leverage = lev.leverage
    const id = randomUUID().replace(/-/g, '').slice(0, 20)
    const trade: BotTrade = {
      id,
      mode,
      setupId: c.setup.id,
      symbol: c.symbol,
      direction: c.direction,
      model: c.setup.model,
      confluence: c.setup.confluence,
      poi: { kind: c.setup.poi.kind, timeframe: c.setup.poi.timeframe },
      score: c.setup.score,
      analysisId: a?.id ?? null,
      confidence: a?.confidence ?? null,
      entry: plan.entry,
      sl: plan.sl,
      slInitial: plan.sl,
      tp: plan.tp,
      qty: plan.qty,
      closedQty: 0,
      realized: 0,
      partials: 0,
      slSeq: 0,
      exitPlan: {
        ladder: exit.ladder,
        trailStepR: exit.trailStepR,
        trailGapR: exit.trailGapR,
        orderFlowHold: exit.orderFlowHold,
        orderFlowTf: exit.orderFlowTf,
        orderFlowSignals: exit.orderFlowSignals,
        orderFlowWickRatio: exit.orderFlowWickRatio,
        tightSlPct: exit.tightSlPct,
        tightBeAtR: exit.tightBeAtR,
        tightBeLockR: exit.tightBeLockR
      },
      exitState: null,
      equity,
      riskUsd: plan.riskUsd,
      leverage: plan.leverage,
      status: 'pending',
      reason: null,
      createdAt: Date.now(),
      expiresAt: knownAt(c, smc.entryTimeframe) + (c.setup.expiryCandles ?? smc.setupExpiryCandles) * TF_MS[smc.entryTimeframe],
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
    if (trade.status === 'closed') {
      this.event('error', c.symbol, `${dirLabel} langsung terisi tapi SL gagal dipasang, posisi ditutup market (${trade.reason})`)
      this.updateStreams()
      return
    }
    this.event(
      'order',
      c.symbol,
      `${mode.toUpperCase()} ${dirLabel} limit ${plan.entry} · SL ${plan.sl} (−1R) · ${tpText(trade)}${targetsText(trade) ? ` · ${targetsText(trade)}` : ''} · qty ${plan.qty} (${plan.notional.toFixed(2)} USDT, ${plan.leverage}× · margin ${lev.marginUsd.toFixed(2)} · likuidasi ±${lev.liqDistPct.toFixed(1)}%) · risk ${plan.riskUsd.toFixed(3)} USDT · ${MODEL_LABEL[c.setup.model]} · ${setupPath(c.setup.model, c.setup.poi.kind, c.setup.poi.timeframe, c.setup.child.kind, c.setup.child.timeframe)} · skor ${c.setup.score}${profile ? ` · profil ${profile.plan.label}` : ''}${a ? ` · Claude ${a.confidence}` : ''}`
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
            const cancelAt = t.tp ?? null
            if (bar && cancelAt !== null && (bull ? bar.high >= cancelAt : bar.low <= cancelAt)) {
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
        if (next.status === 'open' && t.status === 'pending') this.event('order', t.symbol, `entry terisi @${t.entry} (qty ${next.filledQty}), SL ${t.sl} (${fmtR(rAt(t, t.sl))}) / ${tpText(t)} aktif${targetsText(t) ? ` · ${targetsText(t)}` : ''}`)
        if (next.status === 'closed' || next.status === 'cancelled') this.trackers.delete(t.id)
        if (next.status === 'closed') {
          this.equityCache = null
          this.event(next.pnl! >= 0 ? 'order' : 'warn', t.symbol, `posisi ditutup (${next.reason}) @${next.exitPrice ?? '?'} · PnL ${next.pnl!.toFixed(3)} USDT${tradeR(next) !== null ? ` (${fmtR(tradeR(next)!)} bersih fee)` : ''}`)
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
