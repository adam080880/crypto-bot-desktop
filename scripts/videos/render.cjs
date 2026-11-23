// Renders the README videos (GIF + WebM) with Electron's Chromium, no ffmpeg needed.
// Usage: node_modules/.bin/electron scripts/videos/render.cjs <cases.json> <outDir> [scene ...]
// Scenes: cara-kerja, siklus-order, kasus-0, kasus-1, kasus-2 (default: all).
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const args = process.argv.slice(2).filter((a) => !a.endsWith('render.cjs'))
const preview = (args.find((a) => a.startsWith('--preview=')) ?? '').slice(10)
const [casesPath, outDir, ...only] = args.filter((a) => !a.startsWith('--'))
const SCENES = only.length ? only : ['cara-kerja', 'siklus-order', 'kasus-0', 'kasus-1', 'kasus-2']

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  for (const scene of SCENES) {
    const win = new BrowserWindow({
      show: false,
      width: 960,
      height: 540,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
    })
    const done = new Promise((resolve) => ipcMain.once(`done:${scene}`, (_e, msg) => resolve(msg)))
    win.webContents.on('console-message', (_e, _l, msg) => console.log(`[${scene}]`, msg))
    win.webContents.on('render-process-gone', (_e, d) => console.log(`[${scene}] renderer gone`, d.reason))
    win.loadFile(path.join(__dirname, 'render.html'), { query: { scene, cases: path.resolve(casesPath), out: path.resolve(outDir), ...(preview ? { preview } : {}) } }).catch(() => {})
    console.log(scene, await done)
    win.destroy()
  }
  app.quit()
})
