/**
 * Backtest worker (utilityProcess, one per run). Backtest v2 simulates every setup × exit plan on
 * 1m candles (several seconds per coin), so it runs here instead of blocking the main process (UI)
 * or the data worker (live data, bot). Read-only database connection; exits when done.
 */
import type { BacktestParams, BacktestProgress, BacktestResult } from '@shared/backtest'
import type { AppConfig } from '@shared/config'
import { runBacktest } from '../backtest/runBacktest'
import { openDatabase } from '../db/client'
import { initLogger, logger } from '../logger'
import type { WorkerInit } from './protocol'

export type ToBacktestWorker = { type: 'run'; params: BacktestParams; config: AppConfig }
export type FromBacktestWorker =
  | { type: 'progress'; progress: BacktestProgress }
  | { type: 'result'; result: BacktestResult | null }
  | { type: 'error'; error: string }

const port = process.parentPort
const init = JSON.parse(process.argv[2] ?? '{}') as WorkerInit
initLogger(init.logsDir, { stdout: false })
const log = logger('backtest-worker')
const send = (m: FromBacktestWorker): void => port.postMessage(m)

port.once('message', ({ data: msg }: { data: ToBacktestWorker }) => {
  let exitCode = 0
  try {
    const db = openDatabase({ path: init.dbPath, migrationsFolder: init.migrationsFolder, readonly: true })
    let last = 0
    const result = runBacktest(db, msg.params, msg.config, (progress) => {
      if (progress.stage !== 'simulate' || Date.now() - last > 250) {
        last = Date.now()
        send({ type: 'progress', progress })
      }
    })
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
