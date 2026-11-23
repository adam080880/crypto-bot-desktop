import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { AppConfig } from '@shared/config'
import type { LiveCandleEvent } from '@shared/live'
import type { ScreenerRow, ScreenerState } from '@shared/screener'
import type { RotationCommand, RotationState } from '@shared/rotation'
import type { RadarHit, RadarState } from '@shared/radar'
import type { BotState } from '@shared/bot'
import type { AutoSyncState, BackfillEstimate, BackfillEvent, BackfillSummary } from '@shared/sync'
import type { AppStatus, SyncStartRequest, SyncUiState } from '@shared/ipc'
import { findClaude } from '../claude/findClaude'
import { logger } from '../logger'
import type { AppState } from '../state/appState'
import type { FromWorker, ServiceConfig, ToWorker, WorkerInit } from '../workers/protocol'
import type { FromBacktestWorker, ToBacktestWorker } from '../workers/backtestWorker'
import type { BacktestParams, BacktestProgress, BacktestResult, CoinProfile } from '@shared/backtest'

const log = logger('data-controller')
const here = fileURLToPath(new URL('.', import.meta.url))
export const TEST_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']

export interface DataBroadcast {
  syncEvent: (e: BackfillEvent, ui: SyncUiState) => void
  liveCandle: (e: LiveCandleEvent) => void
  liveSynced: (symbol: string) => void
  newsChanged: () => void
  claudeChanged: () => void
  screenerState: (s: ScreenerState) => void
  /** New OB valid setups from an automatic scan (for a desktop notification). */
  screenerNewSetups: (rows: ScreenerRow[]) => void
  botState: (s: BotState) => void
  rotationState: (s: RotationState) => void
  radarHits: (hits: RadarHit[]) => void
}

/**
 * Owns the data utilityProcess (backfill + auto-sync + live WebSocket), restarts it if it
 * dies, and mirrors its state into AppState (header) and the renderer.
 */
export class DataController {
  private child: UtilityProcess | null = null
  private disposed = false
  private chartSymbol: string | null = null
  private autoSync: AutoSyncState | null = null
  private screener: ScreenerState | null = null
  /** Setup ids already seen in a finished scan; null until the worker's first state. */
  private seenSetups: Set<string> | null = null
  private bot: BotState | null = null
  private rotation: RotationState | null = null
  private radar: RadarState | null = null
  private ui: SyncUiState = { running: false, progress: null, lastSummary: null, lastError: null }
  private pendingEstimate: { resolve: (e: BackfillEstimate) => void; reject: (e: Error) => void } | null = null
  private estimatePromise: Promise<BackfillEstimate> | null = null

  constructor(
    private readonly init: WorkerInit,
    private readonly state: AppState,
    private readonly out: DataBroadcast,
    lastSummary: BackfillSummary | null,
    private readonly getBlsKey: () => string | null,
    private readonly getAnthropicKey: () => string | null,
    private readonly getBinanceKeys: () => { key: string; secret: string } | null,
    private readonly getProfiles: () => Record<string, CoinProfile> = () => ({})
  ) {
    this.ui.lastSummary = lastSummary
    state.on('config', () => this.pushConfig())
    // kill switch: cancel the bot's pending entries right away, then keep the flag in sync
    let killed = state.isHalted()
    state.on('status', (st) => {
      if (st.killSwitch.active === killed) return
      killed = st.killSwitch.active
      this.pushConfig()
      if (killed) this.post({ type: 'bot-kill' })
    })
  }

  private serviceConfig(c: AppConfig = this.state.getConfig()): ServiceConfig {
    return {
      data: c.data,
      watchlist: c.watchlist,
      news: c.news,
      smc: c.smc,
      claude: c.claude,
      screener: c.screener,
      bot: c.bot,
      exit: c.exit,
      radar: c.radar,
      profiles: this.getProfiles(),
      risk: c.risk,
      killSwitch: this.state.isHalted(),
      binance: this.getBinanceKeys(),
      blsApiKey: this.getBlsKey(),
      anthropicApiKey: this.getAnthropicKey(),
      claudeExecutable: findClaude(c.claude.executable)
    }
  }

  /** Re-send config (and secrets the worker needs) after a change. */
  pushConfig(): void {
    this.post({ type: 'config', config: this.serviceConfig() })
  }

  /** Spawn the worker and start auto-sync + live streams. */
  start(): void {
    this.spawn()
  }

  getUiState(): SyncUiState {
    return this.ui
  }

  getAutoSync(): AutoSyncState | null {
    return this.autoSync
  }

  getScreener(): ScreenerState | null {
    return this.screener
  }

  getBot(): BotState | null {
    return this.bot
  }

  botCancel(id: string): void {
    this.post({ type: 'bot-cancel', id })
  }

  botRetry(id: string): void {
    this.post({ type: 'bot-retry', id })
  }

  botClose(id: string): void {
    this.post({ type: 'bot-close', id })
  }

  botRefresh(): void {
    this.post({ type: 'bot-refresh' })
  }

  botResetPaper(): void {
    this.post({ type: 'bot-reset-paper' })
  }

  private spawn(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(join(here, 'dataWorker.js'), [JSON.stringify(this.init)], {
      serviceName: 'smc-data',
      stdio: 'inherit'
    })
    child.on('message', (m: FromWorker) => this.onMessage(m))
    child.on('exit', (code) => {
      this.child = null
      this.pendingEstimate?.reject(new Error('worker exited'))
      this.pendingEstimate = null
      if (this.disposed) return // app is quitting: don't touch state/tray anymore
      if (this.ui.running) this.ui = { ...this.ui, running: false, lastError: `worker exited (${code})` }
      this.state.patch({ live: { status: 'off', streams: 0, connections: 0, latencyMs: null } })
      log.error({ code }, 'data worker exited; restarting in 3s')
      setTimeout(() => !this.disposed && this.spawn(), 3000)
    })
    this.child = child
    child.postMessage({ type: 'start-services', config: this.serviceConfig() } satisfies ToWorker)
    if (this.chartSymbol) child.postMessage({ type: 'set-chart', symbol: this.chartSymbol } satisfies ToWorker)
    return child
  }

  private post(m: ToWorker): void {
    if (this.disposed) return
    this.spawn().postMessage(m)
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'estimate':
        this.pendingEstimate?.resolve(m.estimate)
        this.pendingEstimate = null
        return
      case 'estimate-error':
        this.pendingEstimate?.reject(new Error(m.error))
        this.pendingEstimate = null
        return
      case 'idle':
        this.ui = { ...this.ui, running: false }
        this.updateHeader()
        return
      case 'live-state':
        this.state.patch({ live: m.state })
        this.updateHeader()
        return
      case 'live-candle':
        if (m.event.symbol === this.chartSymbol) this.out.liveCandle(m.event)
        return
      case 'live-synced':
        this.out.liveSynced(m.symbol)
        return
      case 'autosync':
        this.autoSync = m.state
        this.updateHeader()
        return
      case 'event':
        if (m.event.kind === 'backfill') this.onBackfillEvent(m.event)
        return
      case 'news-state':
        this.state.patch({ news: m.state })
        return
      case 'news-changed':
        this.out.newsChanged()
        return
      case 'claude-state':
        this.state.patch({ claude: m.state })
        return
      case 'claude-changed':
        this.out.claudeChanged()
        return
      case 'screener-state':
        this.onScreenerState(m.state)
        return
      case 'bot-state':
        this.bot = m.state
        this.out.botState(m.state)
        return
      case 'rotation-state':
        this.rotation = m.state
        this.out.rotationState(m.state)
        return
      case 'radar-state':
        this.radar = m.state
        return
      case 'radar-hits':
        this.out.radarHits(m.hits)
        return
    }
  }

  private onScreenerState(next: ScreenerState): void {
    const finished = next.lastRun && next.lastRun.finishedAt !== this.screener?.lastRun?.finishedAt
    this.screener = next
    this.out.screenerState(next)
    if (!finished && this.seenSetups) return
    const withSetup = next.rows.filter((r) => r.setup)
    const seen = this.seenSetups
    this.seenSetups = new Set(withSetup.map((r) => r.setup!.id))
    // first state (persisted result / worker restart) only primes the seen set
    if (!seen || next.lastRun?.trigger === 'manual') return
    const fresh = withSetup.filter((r) => !seen.has(r.setup!.id))
    if (fresh.length) this.out.screenerNewSetups(fresh)
  }

  private onBackfillEvent(e: BackfillEvent): void {
    switch (e.type) {
      case 'start':
        this.ui = { ...this.ui, running: true, progress: null, lastError: null }
        break
      case 'progress':
        this.ui = { ...this.ui, progress: e }
        break
      case 'done':
        this.ui = { ...this.ui, running: false, lastSummary: e.summary }
        break
      case 'fatal':
        this.ui = { ...this.ui, running: false, lastError: e.error }
        break
    }
    this.updateHeader()
    this.out.syncEvent(e, this.ui)
  }

  /** Header: sync progress + exchange reachability. */
  private updateHeader(): void {
    const s = this.state.getStatus()
    const a = this.autoSync
    let sync: AppStatus['sync']
    if (this.ui.running) {
      const p = this.ui.progress
      sync = { status: 'syncing', upToDate: p?.completed ?? 0, total: p?.total ?? 0 }
    } else if (a) {
      sync = {
        status: a.running ? 'syncing' : a.lastError ? 'error' : 'idle',
        upToDate: a.upToDate,
        total: a.total
      }
    } else sync = s.sync
    const liveOk = s.live.status === 'connected' || s.live.status === 'delayed'
    const connection: AppStatus['connection'] =
      liveOk || a?.reachable === true ? 'connected' : a?.reachable === false || s.live.status === 'reconnecting' ? 'disconnected' : 'unknown'
    const same = s.connection === connection && JSON.stringify(s.sync) === JSON.stringify(sync)
    if (!same) this.state.patch({ sync, connection })
  }

  startBackfill(req: SyncStartRequest): SyncUiState {
    if (this.ui.running) return this.ui
    const data = this.state.getConfig().data
    const symbols = req.mode === 'test' ? TEST_SYMBOLS : req.mode === 'symbols' ? req.symbols : undefined
    this.ui = { ...this.ui, running: true, progress: null, lastError: null }
    this.post({ type: 'run', symbols, data })
    log.info({ mode: req.mode, symbols }, 'backfill started from app')
    return this.ui
  }

  cancelBackfill(): void {
    if (this.child) this.post({ type: 'cancel' })
  }

  syncNow(): void {
    this.post({ type: 'sync-now' })
  }

  claudeRun(): void {
    this.post({ type: 'claude-run' })
  }

  screenerRun(): void {
    this.post({ type: 'screener-run' })
  }

  getRotation(): RotationState | null {
    return this.rotation
  }

  getRadar(): RadarState {
    return this.radar ?? { lastRunAt: null, scanned: 0, hits: [] }
  }

  rotationCommand(command: RotationCommand): void {
    this.post({ type: 'rotation-cmd', command })
  }

  newsRefresh(): void {
    this.post({ type: 'news-refresh' })
  }

  newsSetActual(id: string, value: number | null): void {
    this.post({ type: 'news-set-actual', id, value })
  }

  setChart(symbol: string | null): void {
    this.chartSymbol = symbol
    this.post({ type: 'set-chart', symbol })
  }

  private backtest: UtilityProcess | null = null

  /**
   * Run a backtest in its own short-lived utilityProcess (several seconds of CPU per coin: keeps
   * the UI and the data worker responsive). A new run replaces a running one.
   */
  runBacktest(params: BacktestParams, onProgress: (p: BacktestProgress) => void): Promise<BacktestResult | null> {
    this.backtest?.kill()
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(join(here, 'backtestWorker.js'), [JSON.stringify(this.init)], { serviceName: 'smc-backtest', stdio: 'inherit' })
      this.backtest = child
      let settled = false
      child.on('message', (m: FromBacktestWorker) => {
        if (m.type === 'progress') onProgress(m.progress)
        else if (m.type === 'result') {
          settled = true
          resolve(m.result)
        } else {
          settled = true
          reject(new Error(m.error))
        }
      })
      child.on('exit', (code) => {
        if (this.backtest === child) this.backtest = null
        if (!settled) reject(new Error(code === null ? 'backtest dibatalkan' : `backtest berhenti (${code})`))
      })
      child.postMessage({ type: 'run', params, config: this.state.getConfig() } satisfies ToBacktestWorker)
    })
  }

  /** Concurrent callers share the in-flight estimate instead of failing. */
  estimate(): Promise<BackfillEstimate> {
    this.estimatePromise ??= new Promise<BackfillEstimate>((resolve, reject) => {
      this.pendingEstimate = { resolve, reject }
      this.post({ type: 'estimate', data: this.state.getConfig().data })
    }).finally(() => {
      this.estimatePromise = null
    })
    return this.estimatePromise
  }

  dispose(): void {
    this.disposed = true
    this.child?.kill()
  }

  /** Stop the worker and wait until it has exited (it owns a DB connection). */
  stop(): Promise<void> {
    this.disposed = true
    const child = this.child
    if (!child) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 10_000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      child.kill()
    })
  }
}
