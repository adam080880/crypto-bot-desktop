import { app, BrowserWindow, Notification, powerSaveBlocker, type Tray } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { openDatabase } from './db/client'
import { registerIpcHandlers } from './ipc/handlers'
import { initLogger } from './logger'
import { installCloudflareDns } from './net/dns'
import { paths, pinUserData } from './paths'
import { SecretStore } from './security/secrets'
import { AppState } from './state/appState'
import { readProfiles } from './backtest/profiles'
import { DataController } from './sync/dataController'
import { readSetting } from './db/settingsRepo'
import { createTray } from './tray'
import { z } from 'zod'
import type { BackfillSummary } from '@shared/sync'
import { createMainWindow, type WindowController } from './window'
import { DiscordNotifier } from './notify/discord'
import { botMessages, pickBotEvents, radarMessage, screenerMessage } from './notify/format'

pinUserData()

let quitting = false
let mainWindow: WindowController | null = null
let tray: Tray | null = null // keep a reference so it isn't garbage-collected

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => mainWindow?.show())
  void app.whenReady().then(bootstrap)
}

function bootstrap(): void {
  const log = initLogger(paths.logs()).child({ module: 'main' })
  installCloudflareDns()
  electronApp.setAppUserModelId('dev.local.smc-trading-assistant')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  const dbPath = paths.db()
  const db = openDatabase({ path: dbPath, migrationsFolder: paths.migrations() })
  log.info({ dbPath }, 'database ready')

  const state = new AppState(db, { dbPath, version: app.getVersion() })
  const secrets = new SecretStore(db)
  const discord = new DiscordNotifier(
    () => secrets.get('discord.webhookUrl'),
    () => state.getConfig().notify
  )
  // bot events → Discord: only events newer than the first state seen (no flood of old history)
  let lastBotEventId: number | null = null

  mainWindow = createMainWindow(() => quitting)
  const main = mainWindow

  const sendAll = <T>(channel: string, payload: T): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  const lastRun = readSetting(db, 'backfill_last_run', z.custom<BackfillSummary>((v) => typeof v === 'object' && v !== null))
  const data = new DataController(
    { dbPath, migrationsFolder: paths.migrations(), logsDir: paths.logs(), docsDir: paths.docs(), claudeWorkDir: paths.claudeWorkDir() },
    state,
    {
      syncEvent: (event, ui) => sendAll('sync:event', { event, ui }),
      liveCandle: (event) => sendAll('live:candle', event),
      liveSynced: (symbol) => sendAll('live:synced', { symbol }),
      newsChanged: () => sendAll('news:changed', { at: Date.now() }),
      claudeChanged: () => sendAll('claude:changed', { at: Date.now() }),
      screenerState: (s) => sendAll('screener:state', s),
      botState: (s) => {
        sendAll('bot:state', s)
        const maxId = s.events.reduce((m, e) => Math.max(m, e.id), 0)
        if (lastBotEventId === null) {
          lastBotEventId = maxId
          return
        }
        const fresh = pickBotEvents(s.events, lastBotEventId, state.getConfig().notify)
        lastBotEventId = Math.max(lastBotEventId, maxId)
        for (const m of botMessages(fresh)) discord.notify(m)
      },
      radarHits: (hits) => {
        if (state.getConfig().notify.radar) discord.notify(radarMessage(hits))
        if (!Notification.isSupported()) return
        const n = new Notification({
          title: `Radar pump: ${hits.length} koin`,
          body: hits
            .slice(0, 5)
            .map((h) => `${h.symbol} vol ${h.volRatio}× · 24j ${(h.ret24 * 100).toFixed(1)}%`)
            .join('\n')
        })
        n.on('click', () => main.show())
        n.show()
      },
      rotationState: (s) => sendAll('rotation:state', s),
      screenerNewSetups: (rows) => {
        if (state.getConfig().notify.screener) discord.notify(screenerMessage(rows))
        if (!state.getConfig().screener.notify || !Notification.isSupported()) return
        const list = rows.slice(0, 5).map((r) => `${r.symbol} ${r.direction === 'bullish' ? 'LONG' : 'SHORT'} RR ${r.setup!.rr}`)
        const n = new Notification({
          title: `Screener: ${rows.length} setup OB valid baru`,
          body: list.join('\n') + (rows.length > 5 ? `\n+${rows.length - 5} lagi` : '')
        })
        n.on('click', () => main.show())
        n.show()
      }
    },
    lastRun,
    () => secrets.get('bls.apiKey'),
    () => secrets.get('anthropic.apiKey'),
    () => {
      const key = secrets.get('binance.apiKey')
      const secret = secrets.get('binance.apiSecret')
      return key && secret ? { key, secret } : null
    },
    () => readProfiles(db)
  )

  registerIpcHandlers({
    db,
    state,
    secrets,
    data,
    discord,
    dbPath,
    beforeRelaunch: () => {
      quitting = true
    },
    isTrustedSender: (wc) => wc.id === main.window.webContents.id
  })

  const t = createTray({
    show: () => main.show(),
    quit: () => app.quit(),
    killSwitch: () => state.activateKillSwitch()
  })
  tray = t.tray
  t.update(state.getStatus())

  // Keep the machine awake while live data runs and the bot isn't halted.
  let blockerId: number | null = null
  const updatePowerBlocker = (): void => {
    const st = state.getStatus()
    const want = state.getConfig().data.keepAwake && st.live.status !== 'off' && !st.killSwitch.active
    if (want && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
      log.info('powerSaveBlocker on')
    } else if (!want && blockerId !== null) {
      powerSaveBlocker.stop(blockerId)
      blockerId = null
      log.info('powerSaveBlocker off')
    }
  }

  state.on('status', (status) => {
    t.update(status)
    sendAll('app:status', status)
    updatePowerBlocker()
  })
  state.on('config', (c) => {
    updatePowerBlocker()
    sendAll('config:changed', c)
  })
  data.start()

  app.on('activate', () => main.show())
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    data.dispose() // stop the worker first so its exit can't touch a destroyed tray
    tray?.destroy()
    db.$client.close()
    log.info('shutdown complete')
  })

  log.info({ mode: state.getStatus().mode }, 'app started')
}

// Keep running in the tray when every window is closed/hidden.
app.on('window-all-closed', () => {
  /* intentionally empty */
})
