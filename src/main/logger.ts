import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pino, { type Logger } from 'pino'

let root: Logger | null = null
let generation = 0

/** Create the root logger once. Writes JSON lines to `<logsDir>/app.log` and optionally stdout. */
export function initLogger(
  logsDir: string,
  { level = process.env.LOG_LEVEL ?? 'info', stdout = true }: { level?: string; stdout?: boolean } = {}
): Logger {
  mkdirSync(logsDir, { recursive: true })
  root = pino(
    { level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream([
      { level: 'trace', stream: pino.destination({ dest: join(logsDir, 'app.log'), mkdir: true, sync: false }) },
      ...(stdout ? [{ level: 'trace' as const, stream: process.stdout }] : [])
    ])
  )
  generation++
  return root
}

type LogFn = Logger['info']
export type ModuleLogger = Pick<Logger, 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'>

/**
 * Module logger usable at import time: it binds to whichever root logger exists when a
 * message is written, so modules imported before initLogger() still log to the right place.
 */
export function logger(module: string): ModuleLogger {
  let child: Logger | null = null
  let gen = -1
  const current = (): Logger => {
    if (!root) root = pino({ level: 'info', base: undefined })
    if (!child || gen !== generation) {
      child = root.child({ module })
      gen = generation
    }
    return child
  }
  const bind = (lvl: keyof ModuleLogger): LogFn =>
    ((...a: Parameters<LogFn>) => current()[lvl](...a)) as LogFn
  return {
    trace: bind('trace'),
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
    fatal: bind('fatal')
  }
}
