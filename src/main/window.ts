import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'

const here = fileURLToPath(new URL('.', import.meta.url))

export interface WindowController {
  window: BrowserWindow
  show(): void
}

/**
 * Create the main window. Closing it only hides it (app keeps running in the tray)
 * unless `shouldQuit()` returns true.
 */
export function createMainWindow(shouldQuit: () => boolean): WindowController {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0a0b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.on('close', (e) => {
    if (!shouldQuit()) {
      e.preventDefault()
      win.hide()
    }
  })

  // No in-app navigation or popups; external http(s) links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(here, '../renderer/index.html'))
  }

  return {
    window: win,
    show() {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
}
