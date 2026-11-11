import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          backfill: resolve('src/cli/backfill.ts'),
          dataWorker: resolve('src/main/workers/dataWorker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Sandboxed preload must be bundled into one CJS file.
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src'), ...shared }
    },
    plugins: [react(), tailwindcss()]
  }
})
