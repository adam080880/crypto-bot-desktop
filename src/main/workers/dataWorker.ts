/**
 * Data service (utilityProcess). The only process that writes market data:
 * manual backfills, auto-sync catch-ups and live WebSocket ingest all run here, serialised per
 * symbol by Backfiller.locks. The main process only relays messages and reads.
 */
import { join } from 'node:path'
import {
  botConfigSchema,
  exitConfigSchema,
  claudeConfigSchema, dataConfigSchema, newsConfigSchema, riskConfigSchema, screenerConfigSchema, smcConfigSchema } from '@shared/config'
import { BotService } from '../bot/botService'
import { ClaudeAnalyst } from '../claude/analyst'
import { NewsService } from '../news/newsService'
import { openDatabase } from '../db/client'
import { CandleRepo } from '../db/candles'
import { symbolByName } from '../db/symbolsRepo'
import { LiveService } from '../live/liveService'
import { ScreenerService } from '../screener/screenerService'
import { initLogger, logger } from '../logger'
import { installCloudflareDns } from '../net/dns'
import { AutoSync } from '../sync/autoSync'
import { FlowSync } from '../flow/flowSync'
import { RotationService } from '../rotation/rotationService'
import { BinanceTradeClient } from '../bot/binanceTrade'
import { Backfiller } from '../sync/backfill'
import { estimateFullBackfill } from '../sync/estimate'
import type { FromWorker, ServiceConfig, ToWorker, WorkerInit } from './protocol'

const port = process.parentPort
const init = JSON.parse(process.argv[2] ?? '{}') as WorkerInit
initLogger(init.logsDir, { stdout: false })
installCloudflareDns()

// Event-loop stall detector: everything here (WS, bot, Claude MCP tools) shares one thread.
{
  const stallLog = logger('worker')
  let expected = Date.now() + 1000
  setInterval(() => {
    const lag = Date.now() - expected
    if (lag > 3000) stallLog.warn({ blockedMs: lag }, 'event loop blocked')
    expected = Date.now() + 1000
  }, 1000).unref()
}
const log = logger('data-worker')
const db = openDatabase({ path: init.dbPath, migrationsFolder: init.migrationsFolder })
const backfiller = new Backfiller(db)
const send = (m: FromWorker): void => port.postMessage(m)

let config: ServiceConfig = {
  data: dataConfigSchema.parse({}),
  watchlist: [],
  news: newsConfigSchema.parse({}),
  smc: smcConfigSchema.parse({}),
  claude: claudeConfigSchema.parse({}),
  screener: screenerConfigSchema.parse({}),
  bot: botConfigSchema.parse({}),
  exit: exitConfigSchema.parse({}),
  profiles: {},
  risk: riskConfigSchema.parse({}),
  killSwitch: false,
  binance: null,
  blsApiKey: null,
  anthropicApiKey: null,
  claudeExecutable: null
}
let positions: string[] = []
let manual: AbortController | null = null

const live = new LiveService(db, backfiller, () => config.data)
const autoSync = new AutoSync(
  db,
  backfiller,
  () => config.data,
  () => [...config.watchlist, ...positions],
  () => live.liveSymbols(),
  (state) => send({ type: 'autosync', state }),
  () => manual === null
)

// open interest + funding for the flow confluences (docs/entry-v2.md §10)
const flowSync = new FlowSync(db, {
  symbols: () => backfiller.trackedSymbols([...config.watchlist, ...positions]),
  getData: () => config.data,
  canRun: () => manual === null
})

// momentum rotation: paper forward test only, never orders (docs/entry-v2.md §11)
const rotation = new RotationService(db, { market: new BinanceTradeClient(), getData: () => config.data, canRun: () => manual === null })
rotation.on('state', (state) => send({ type: 'rotation-state', state }))

const news = new NewsService(db, {
  getConfig: () => config.news,
  getSmc: () => config.smc,
  getWatchlist: () => config.watchlist,
  getBlsKey: () => config.blsApiKey
})
news.on('state', (state) => send({ type: 'news-state', state }))
news.on('changed', () => send({ type: 'news-changed' }))

const analyst = new ClaudeAnalyst(db, {
  getConfig: () => config.claude,
  getSmc: () => config.smc,
  getNews: () => config.news,
  getNewsState: () => news.getState(),
  getWatchlist: () => config.watchlist,
  getPositionsNote: () => bot?.positionsNote() ?? 'tidak ada',
  getApiKey: () => config.anthropicApiKey,
  rulesPath: join(init.docsDir, 'smc-rules.md'),
  workDir: init.claudeWorkDir,
  getExecutable: () => config.claudeExecutable
})
analyst.on('state', (state) => send({ type: 'claude-state', state }))
analyst.on('done', () => send({ type: 'claude-changed' }))

const screener = new ScreenerService(db, {
  getConfig: () => config.screener,
  getSmc: () => config.smc,
  getExit: () => config.exit,
  getData: () => config.data,
  canAutoRun: () => manual === null
})
screener.on('state', (state) => {
  send({ type: 'screener-state', state })
  if (!state.running && state.lastRun && state.lastRun.finishedAt !== lastScreenerRun) {
    lastScreenerRun = state.lastRun.finishedAt
    bot.onScreener(state.rows)
  }
})
let lastScreenerRun: number | null = null

// Fase 7 bot: screener setups → gates (incl. Claude) → risk-sized orders (paper / live)
const bot: BotService = new BotService(db, {
  getBot: () => config.bot,
  getRisk: () => config.risk,
  getSmc: () => config.smc,
  getExit: () => config.exit,
  getProfiles: () => config.profiles,
  getNews: () => config.news,
  getKeys: () => config.binance,
  isKilled: () => config.killSwitch,
  newsWindow: () => {
    const w = news.getState()?.window
    return w && Date.now() < w.endsAt ? w.title : null
  },
  requestClaude: (symbols) => analyst.runFor(symbols),
  setStreams: (symbols) => live.setSources({ bot: symbols }),
  minuteCandles: (symbol, from) => {
    const sym = symbolByName(db, symbol)
    return sym ? new CandleRepo(db).range('1m', sym.id, from, Date.now()) : []
  },
  syncedSymbols: () =>
    new Set(db.$client.prepare(`SELECT s.symbol FROM symbols s JOIN sync_state ss ON ss.symbol_id = s.id AND ss.timeframe = '1m'`).pluck().all() as string[])
})
bot.on('state', (state) => send({ type: 'bot-state', state }))
analyst.on('done', () => bot.onClaudeDone())

// News-triggered analysis: collect simultaneous releases (e.g. CPI + Core CPI) into one run.
const pendingRelease = new Map<number, { titles: string[]; timer: ReturnType<typeof setTimeout> }>()
news.on('released', (e) => {
  if (!config.claude.triggerOnNews) return
  const p = pendingRelease.get(e.time)
  if (p) {
    if (!p.titles.includes(e.title)) p.titles.push(e.title)
    return
  }
  const entry = {
    titles: [e.title],
    timer: setTimeout(() => {
      pendingRelease.delete(e.time)
      void analyst.run('news', entry.titles)
    }, 90_000)
  }
  pendingRelease.set(e.time, entry)
})

// Optional periodic analysis (off by default: intervalMinutes = 0).
let intervalTimer: ReturnType<typeof setInterval> | null = null
const scheduleInterval = (): void => {
  if (intervalTimer) clearInterval(intervalTimer)
  intervalTimer = null
  if (config.claude.intervalMinutes > 0)
    intervalTimer = setInterval(() => void analyst.run('interval'), config.claude.intervalMinutes * 60_000)
}

backfiller.on('event', (event) => send({ type: 'event', event }))
live.on('state', (state) => send({ type: 'live-state', state }))
live.on('candle', (event) => send({ type: 'live-candle', event }))
live.on('kline', (k) => {
  bot.onKline(k.symbol, k.candle.h, k.candle.l, k.candle.c)
  if (k.closed) void bot.onClosed1m(k.symbol, k.candle)
})
live.on('synced', (symbol) => send({ type: 'live-synced', symbol }))

let started = false

port.on('message', async ({ data: msg }: { data: ToWorker }) => {
  switch (msg.type) {
    case 'start-services':
      config = msg.config
      if (started) break
      started = true
      try {
        // make sure the symbol list exists before subscribing / tracking
        await backfiller.refreshSymbols(config.data)
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'symbol refresh failed at startup')
      }
      live.setSources({ watchlist: config.watchlist })
      autoSync.start()
      flowSync.start()
      rotation.start()
      send({ type: 'rotation-state', state: rotation.getState() })
      news.start()
      scheduleInterval()
      send({ type: 'claude-state', state: analyst.getState() })
      screener.start()
      send({ type: 'screener-state', state: screener.getState() })
      bot.configure()
      bot.start()
      break
    case 'config':
      config = msg.config
      live.setSources({ watchlist: config.watchlist })
      autoSync.configure()
      scheduleInterval()
      screener.configure()
      bot.configure()
      break
    case 'bot-kill':
      void bot.kill()
      break
    case 'bot-cancel':
      void bot.cancelById(msg.id)
      break
    case 'bot-retry':
      void bot.retryById(msg.id)
      break
    case 'bot-close':
      void bot.closeById(msg.id)
      break
    case 'bot-reset-paper':
      bot.resetPaper()
      break
    case 'claude-run':
      void analyst.run('manual')
      break
    case 'screener-run':
      void screener.run('manual')
      break
    case 'rotation-cmd':
      void rotation.command(msg.command)
      break
    case 'news-refresh':
      void news.refreshNow()
      break
    case 'news-set-actual':
      news.setManualActual(msg.id, msg.value)
      break
    case 'set-chart':
      live.setSources({ chart: msg.symbol })
      break
    case 'set-positions':
      positions = msg.symbols
      live.setSources({ positions })
      break
    case 'sync-now':
      void autoSync.tick('manual')
      break
    case 'run': {
      if (manual) return
      manual = new AbortController()
      autoSync.abort() // catch-ups are resumable; the manual run takes priority
      try {
        await backfiller.run({ symbols: msg.symbols, limit: msg.limit, data: msg.data, signal: manual.signal })
      } catch (err) {
        send({ type: 'event', event: { type: 'fatal', kind: 'backfill', error: (err as Error).message } })
      } finally {
        manual = null
        send({ type: 'idle' })
        autoSync.refreshCounts()
      }
      break
    }
    case 'cancel':
      manual?.abort(new Error('cancelled'))
      break
    case 'estimate':
      try {
        await backfiller.refreshSymbols(msg.data)
        send({ type: 'estimate', estimate: estimateFullBackfill(db, msg.data, msg.data.concurrency) })
      } catch (err) {
        send({ type: 'estimate-error', error: (err as Error).message })
      }
      break
  }
})

process.on('exit', () => {
  live.dispose()
  autoSync.dispose()
  flowSync.dispose()
  rotation.dispose()
  news.dispose()
  screener.dispose()
  bot.dispose()
  if (intervalTimer) clearInterval(intervalTimer)
  db.$client.close()
})
