import { app, BrowserWindow, powerSaveBlocker, type Tray } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { openDatabase } from './db/client'
import { registerIpcHandlers } from './ipc/handlers'
import { initLogger } from './logger'
import { paths, pinUserData } from './paths'
import { SecretStore } from './security/secrets'
import { AppState } from './state/appState'
import { DataController } from './sync/dataController'
import { readSetting } from './db/settingsRepo'
import { createTray } from './tray'
import { z } from 'zod'
import type { BackfillSummary } from '@shared/sync'
import { createMainWindow, type WindowController } from './window'

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
  electronApp.setAppUserModelId('dev.local.smc-trading-assistant')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  const dbPath = paths.db()
  const db = openDatabase({ path: dbPath, migrationsFolder: paths.migrations() })
  log.info({ dbPath }, 'database ready')

  const state = new AppState(db, { dbPath, version: app.getVersion() })
  const secrets = new SecretStore(db)

  mainWindow = createMainWindow(() => quitting)
  const main = mainWindow

  const sendAll = <T>(channel: string, payload: T): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  const lastRun = readSetting(db, 'backfill_last_run', z.custom<BackfillSummary>((v) => typeof v === 'object' && v !== null))
  const data = new DataController(
    { dbPath, migrationsFolder: paths.migrations(), logsDir: paths.logs() },
    state,
    {
      syncEvent: (event, ui) => sendAll('sync:event', { event, ui }),
      liveCandle: (event) => sendAll('live:candle', event),
      liveSynced: (symbol) => sendAll('live:synced', { symbol })
    },
    lastRun
  )

  registerIpcHandlers({
    db,
    state,
    secrets,
    data,
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
  state.on('config', updatePowerBlocker)
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
