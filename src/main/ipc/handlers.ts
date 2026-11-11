import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { configPatchSchema } from '@shared/config'
import { SECRET_NAMES, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc'
import { TIMEFRAMES } from '@shared/timeframes'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { activeSymbols, symbolByName } from '../db/symbolsRepo'
import { logger } from '../logger'
import type { SecretStore } from '../security/secrets'
import type { AppState } from '../state/appState'
import type { DataController } from '../sync/dataController'
import { SmcService } from '../strategy/service'
import { NewsRepo } from '../news/repo'

const log = logger('ipc')

const secretNameSchema = z.enum(SECRET_NAMES)
const symbolSchema = z.string().regex(/^[A-Z0-9]{2,30}$/)

type Handler<C extends InvokeChannel> = (
  req: unknown,
  event: IpcMainInvokeEvent
) => IpcInvokeMap[C]['res'] | Promise<IpcInvokeMap[C]['res']>

export function registerIpcHandlers(deps: {
  db: Db
  state: AppState
  secrets: SecretStore
  data: DataController
  isTrustedSender: (wc: WebContents) => boolean
}): void {
  const { db, state, secrets, data, isTrustedSender } = deps
  const candles = new CandleRepo(db) // main-process reads; the data worker is the only writer
  const smc = new SmcService(db)
  const news = new NewsRepo(db)

  const handle = <C extends InvokeChannel>(channel: C, fn: Handler<C>): void => {
    ipcMain.handle(channel, async (event, req: unknown) => {
      if (!isTrustedSender(event.sender)) {
        log.warn({ channel }, 'rejected IPC from untrusted sender')
        throw new Error('untrusted sender')
      }
      try {
        return await fn(req, event)
      } catch (err) {
        log.error({ channel, err: (err as Error).message }, 'ipc handler failed')
        throw err
      }
    })
  }

  handle('app:getStatus', () => state.getStatus())
  handle('bot:killSwitch', () => {
    state.activateKillSwitch()
    return state.getStatus()
  })
  handle('bot:resume', () => {
    state.resume()
    return state.getStatus()
  })
  handle('config:get', () => state.getConfig())
  handle('config:update', (req) => state.updateConfig(configPatchSchema.parse(req)))

  handle('secrets:encryptionAvailable', () => secrets.isEncryptionAvailable())
  handle('secrets:list', () => secrets.list())
  handle('secrets:set', (req) => {
    const { name, value } = z
      .object({ name: secretNameSchema, value: z.string().trim().min(1).max(512) })
      .strict()
      .parse(req)
    secrets.set(name, value)
    if (name === 'bls.apiKey') data.pushConfig()
    return secrets.list()
  })
  handle('secrets:delete', (req) => {
    const { name } = z.object({ name: secretNameSchema }).strict().parse(req)
    secrets.delete(name)
    if (name === 'bls.apiKey') data.pushConfig()
    return secrets.list()
  })

  handle('sync:getState', () => data.getUiState())
  handle('sync:autoState', () => data.getAutoSync())
  handle('sync:now', () => data.syncNow())
  handle('sync:start', (req) =>
    data.startBackfill(
      z
        .discriminatedUnion('mode', [
          z.object({ mode: z.literal('test') }).strict(),
          z.object({ mode: z.literal('all') }).strict(),
          z.object({ mode: z.literal('symbols'), symbols: z.array(symbolSchema).min(1).max(1000) }).strict()
        ])
        .parse(req)
    )
  )
  handle('sync:cancel', () => data.cancelBackfill())
  handle('sync:estimate', () => data.estimate())

  handle('symbols:list', () => {
    const synced = new Set(
      db.$client.prepare(`SELECT symbol_id FROM sync_state WHERE timeframe = '1m'`).pluck().all() as number[]
    )
    return activeSymbols(db).map((s) => ({ symbol: s.symbol, synced: synced.has(s.id) }))
  })
  handle('candles:get', (req) => {
    const r = z
      .object({
        symbol: symbolSchema,
        timeframe: z.enum(TIMEFRAMES),
        limit: z.number().int().min(1).max(10_000),
        before: z.number().int().positive().optional()
      })
      .strict()
      .parse(req)
    const sym = symbolByName(db, r.symbol)
    if (!sym) return []
    return candles.latest(r.timeframe, sym.id, r.limit, r.before)
  })
  handle('smc:analyze', (req) => {
    const r = z
      .object({ symbol: symbolSchema, timeframe: z.enum(TIMEFRAMES), limit: z.number().int().min(50).max(10_000) })
      .strict()
      .parse(req)
    return smc.analyze(r.symbol, r.timeframe, r.limit, state.getConfig().smc)
  })
  handle('smc:setups', (req) => {
    const { symbol } = z.object({ symbol: symbolSchema }).strict().parse(req)
    return smc.setups(symbol, state.getConfig().smc)
  })
  handle('news:list', (req) => {
    const { from, to } = z.object({ from: z.number().int(), to: z.number().int() }).strict().parse(req)
    if (to - from > 62 * 86_400_000) throw new Error('range too large')
    return news.list(from, to)
  })
  handle('news:candidates', () => news.candidates(50))
  handle('news:reactions', (req) => news.reactions(z.object({ eventId: z.string().regex(/^[a-f0-9]{16}$/) }).strict().parse(req).eventId))
  handle('news:stats', () => news.stats(state.getConfig().news.cryptoBiasMode))
  handle('news:refresh', () => data.newsRefresh())
  handle('news:setActual', (req) => {
    const { id, value } = z
      .object({ id: z.string().regex(/^[a-f0-9]{16}$/), value: z.number().finite().nullable() })
      .strict()
      .parse(req)
    data.newsSetActual(id, value)
  })
  handle('live:setChart', (req) => {
    const { symbol } = z.object({ symbol: symbolSchema.nullable() }).strict().parse(req)
    data.setChart(symbol)
  })
}
