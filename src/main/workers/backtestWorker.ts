/**
 * Backtest worker (utilityProcess, one per run). Backtest v2 simulates every setup × exit plan on
 * 1m candles (several seconds per coin), so it runs here instead of blocking the main process (UI)
 * or the data worker (live data, bot). Read-only database connection; exits when done.
 */
import type { BacktestParams, BacktestProgress, BacktestResult } from '@shared/backtest'
import type { AppConfig } from '@shared/config'
import { runBacktest } from '../backtest/runBacktest'
import { openDatabase } from '../db/client'
import { symbolByName } from '../db/symbolsRepo'
import { downloadFlow } from '../flow/visionFlow'
import { fetchBtcDom } from '../flow/btcDom'
import type { Candle } from '@shared/candles'
import { TF_MS } from '@shared/timeframes'
import { initLogger, logger } from '../logger'
import { installCloudflareDns } from '../net/dns'
import type { FlowData } from '../strategy/flow'
import type { WorkerInit } from './protocol'

export type ToBacktestWorker = { type: 'run'; params: BacktestParams; config: AppConfig }
export type FromBacktestWorker =
  | { type: 'progress'; progress: BacktestProgress }
  | { type: 'result'; result: BacktestResult | null }
  | { type: 'error'; error: string }

const port = process.parentPort
const init = JSON.parse(process.argv[2] ?? '{}') as WorkerInit
initLogger(init.logsDir, { stdout: false })
installCloudflareDns() // the flow history is downloaded here (ISP blocks Binance by DNS)
const log = logger('backtest-worker')
const send = (m: FromBacktestWorker): void => port.postMessage(m)

port.once('message', async ({ data: msg }: { data: ToBacktestWorker }) => {
  let exitCode = 0
  try {
    const db = openDatabase({ path: init.dbPath, migrationsFolder: init.migrationsFolder, readonly: true })
    let last = 0
    // open interest / funding history for the flow confluences (download only, never stored)
    let flow: FlowData | undefined
    const sym = symbolByName(db, msg.params.symbol)
    const span = sym
      ? (db.$client.prepare('SELECT min(open_time) AS a, max(open_time) AS b FROM candles_15m WHERE symbol_id = ?').get(sym.id) as { a: number | null; b: number | null })
      : null
    if (span?.a != null && span.b != null) {
      try {
        flow = await downloadFlow(msg.params.symbol, span.a, span.b, (done, total) => {
          if (Date.now() - last > 250 || done === total) {
            last = Date.now()
            send({ type: 'progress', progress: { symbol: msg.params.symbol, stage: 'flow', done, total } })
          }
        })
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'flow download failed; backtest without OI/funding')
      }
    }
    // BTC dominance for the btcDom tag (download only, never stored); 300 candles of warm-up for the structure
    let btcDom: Candle[] | undefined
    if (span?.a != null && span.b != null) {
      const tf = msg.config.smc.btcDomTimeframe
      try {
        btcDom = await fetchBtcDom(tf, span.a - 300 * TF_MS[tf], span.b + TF_MS[tf])
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'BTCDOM download failed; backtest without btcDom')
      }
    }
    const result = runBacktest(db, msg.params, msg.config, (progress) => {
      if (progress.stage !== 'simulate' || Date.now() - last > 250) {
        last = Date.now()
        send({ type: 'progress', progress })
      }
    }, flow, btcDom)
    send({ type: 'result', result })
    db.$client.close()
  } catch (err) {
    log.error({ err: (err as Error).message }, 'backtest failed')
    send({ type: 'error', error: (err as Error).message })
    exitCode = 1
  }
  // let the last message flush before exiting
  setTimeout(() => process.exit(exitCode), 50)
})
