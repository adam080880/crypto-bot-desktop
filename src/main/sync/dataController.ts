import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { AppConfig } from '@shared/config'
import type { LiveCandleEvent } from '@shared/live'
import type { AutoSyncState, BackfillEstimate, BackfillEvent, BackfillSummary } from '@shared/sync'
import type { AppStatus, SyncStartRequest, SyncUiState } from '@shared/ipc'
import { logger } from '../logger'
import type { AppState } from '../state/appState'
import type { FromWorker, ServiceConfig, ToWorker, WorkerInit } from '../workers/protocol'

const log = logger('data-controller')
const here = fileURLToPath(new URL('.', import.meta.url))
export const TEST_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']

export interface DataBroadcast {
  syncEvent: (e: BackfillEvent, ui: SyncUiState) => void
  liveCandle: (e: LiveCandleEvent) => void
  liveSynced: (symbol: string) => void
}

const serviceConfig = (c: AppConfig): ServiceConfig => ({ data: c.data, watchlist: c.watchlist })

/**
 * Owns the data utilityProcess (backfill + auto-sync + live WebSocket), restarts it if it
 * dies, and mirrors its state into AppState (header) and the renderer.
 */
export class DataController {
  private child: UtilityProcess | null = null
  private disposed = false
  private chartSymbol: string | null = null
  private autoSync: AutoSyncState | null = null
  private ui: SyncUiState = { running: false, progress: null, lastSummary: null, lastError: null }
  private pendingEstimate: { resolve: (e: BackfillEstimate) => void; reject: (e: Error) => void } | null = null

  constructor(
    private readonly init: WorkerInit,
    private readonly state: AppState,
    private readonly out: DataBroadcast,
    lastSummary: BackfillSummary | null
  ) {
    this.ui.lastSummary = lastSummary
    state.on('config', (c) => this.post({ type: 'config', config: serviceConfig(c) }))
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
    child.postMessage({ type: 'start-services', config: serviceConfig(this.state.getConfig()) } satisfies ToWorker)
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
    }
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

  setChart(symbol: string | null): void {
    this.chartSymbol = symbol
    this.post({ type: 'set-chart', symbol })
  }

  estimate(): Promise<BackfillEstimate> {
    if (this.pendingEstimate) return Promise.reject(new Error('estimate already running'))
    return new Promise((resolve, reject) => {
      this.pendingEstimate = { resolve, reject }
      this.post({ type: 'estimate', data: this.state.getConfig().data })
    })
  }

  dispose(): void {
    this.disposed = true
    this.child?.kill()
  }
}
