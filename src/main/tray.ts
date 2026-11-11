import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import type { AppStatus } from '@shared/ipc'

/** Draw a tiny candlestick glyph so we don't need an icon asset yet. */
function trayIcon(): NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4) // BGRA
  const fill = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = (y * size + x) * 4
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255
      }
  }
  // two candles: wick + body
  fill(4, 4, 1, 14); fill(2, 6, 4, 10)
  fill(11, 11, 3, 13); fill(9, 13, 6, 11)
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size })
  img.setTemplateImage(true)
  return img
}

export function createTray(actions: {
  show: () => void
  quit: () => void
  killSwitch: () => void
}): { tray: Tray; update: (status: AppStatus) => void } {
  const tray = new Tray(trayIcon())
  tray.setToolTip('SMC Trading Assistant')

  const update = (status: AppStatus): void => {
    if (tray.isDestroyed()) return
    const halted = status.killSwitch.active
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Mode: ${status.mode.toUpperCase()}`, enabled: false },
        { label: halted ? 'Bot: HALTED (kill switch)' : 'Bot: idle', enabled: false },
        { type: 'separator' },
        { label: 'Buka window', click: actions.show },
        { label: 'Kill Switch', enabled: !halted, click: actions.killSwitch },
        { type: 'separator' },
        { label: 'Keluar', click: actions.quit }
      ])
    )
  }

  tray.on('click', () => {
    if (process.platform !== 'darwin') actions.show()
  })
  return { tray, update }
}
