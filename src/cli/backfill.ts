/**
 * pnpm data:backfill [options]
 *
 *   --test                 5 test symbols (BTC, ETH, SOL, XRP, DOGE), then print a full estimate
 *   --symbols A,B          explicit symbols (e.g. BTCUSDT,ETHUSDT)
 *   --limit N              first N active symbols
 *   --all                  every active USDT-M perpetual (required for a full run)
 *   --estimate             only print the full-backfill estimate (uses last run's measurements)
 *   --verify               compare resampled 5m/15m/1h/4h with Binance native klines
 *   --sources 1m,1d,1w     which source timeframes to fetch (default all)
 *   --concurrency N        parallel symbols (default from config: 4)
 *   --db PATH              database file (default: the app's database)
 *
 * Runs under Electron-as-Node (see package.json) so better-sqlite3 uses the Electron build.
 */
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { dataConfigSchema } from '@shared/config'
import type { BackfillEvent } from '@shared/sync'
import { SOURCE_TIMEFRAMES, DERIVED_TIMEFRAMES, type SourceTimeframe } from '@shared/timeframes'
import { openDatabase } from '../main/db/client'
import { BinanceFuturesClient } from '../main/exchange/binanceFutures'
import { initLogger } from '../main/logger'
import { installCloudflareDns } from '../main/net/dns'
import { Backfiller } from '../main/sync/backfill'
import { dbFileBytes, estimateFullBackfill } from '../main/sync/estimate'
import { verifyResample } from '../main/sync/verify'
import { defaultDbPath, userDataDir } from '../main/userDataDir'

const TEST_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']

const { values: args } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    symbols: { type: 'string' },
    limit: { type: 'string' },
    all: { type: 'boolean', default: false },
    estimate: { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    sources: { type: 'string' },
    concurrency: { type: 'string' },
    db: { type: 'string' }
  }
})

const fmtBytes = (b: number): string => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(i ? 2 : 0)} ${u[i]}`
}
const fmtDur = (ms: number | null): string => {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}j ${m}m` : m ? `${m}m ${s % 60}dtk` : `${s}dtk`
}
const fmtInt = (n: number): string => Math.round(n).toLocaleString('id-ID')

async function main(): Promise<void> {
  initLogger(join(userDataDir(), 'logs'), { stdout: false })
  installCloudflareDns()
  const dbPath = resolve(args.db ?? defaultDbPath())
  const db = openDatabase({ path: dbPath, migrationsFolder: resolve('drizzle') })
  const data = dataConfigSchema.parse({ concurrency: args.concurrency ? Number(args.concurrency) : undefined })
  const client = new BinanceFuturesClient()
  const backfiller = new Backfiller(db, client)
  console.log(`DB: ${dbPath}`)

  const ctrl = new AbortController()
  process.on('SIGINT', () => {
    console.log('\nDibatalkan — progres sudah tersimpan, jalankan lagi untuk melanjutkan.')
    ctrl.abort(new Error('cancelled'))
  })

  const printEstimate = (): void => {
    const e = estimateFullBackfill(db, data, data.concurrency)
    console.log(`\n=== Estimasi full backfill: ${e.activeSymbols} simbol aktif ===`)
    if (e.measuredOn)
      console.log(
        `Diukur dari run terakhir: ${e.measuredOn.symbols} simbol, ${fmtInt(e.measuredOn.rows1m)} baris 1m, ${fmtDur(e.measuredOn.seconds * 1000)}`
      )
    console.log('TF    bytes/baris   baris (proyeksi)      ukuran (proyeksi)')
    for (const t of e.tables)
      console.log(
        `${t.timeframe.padEnd(5)} ${(t.bytesPerRow?.toFixed(1) ?? '~55').padStart(11)}   ${fmtInt(t.projectedRows).padStart(16)}   ${fmtBytes(t.projectedBytes).padStart(18)}`
      )
    console.log(`Total DB (perkiraan):     ${fmtBytes(e.projectedDbBytes)}`)
    console.log(`Download dari Binance:    ${e.projectedDownloadBytes != null ? fmtBytes(e.projectedDownloadBytes) : '—'}`)
    console.log(`Waktu (perkiraan):        ${fmtDur(e.projectedSeconds != null ? e.projectedSeconds * 1000 : null)} @ concurrency ${data.concurrency}`)
    console.log(`Batas REST weight:        ≥ ${e.restWeightMinutes.toFixed(1)} menit`)
    for (const n of e.notes) console.log(`- ${n}`)
  }

  if (args.estimate) {
    await backfiller.refreshSymbols(data)
    printEstimate()
    return
  }

  if (args.verify) {
    await backfiller.refreshSymbols(data)
    const syms = args.symbols?.split(',') ?? TEST_SYMBOLS
    console.log('\n=== Verifikasi resample vs kline asli Binance (500 candle terakhir) ===')
    for (const s of syms)
      for (const tf of DERIVED_TIMEFRAMES) {
        const r = await verifyResample(db, client, s.toUpperCase(), tf)
        console.log(
          `${r.symbol.padEnd(10)} ${tf.padEnd(4)} dibandingkan=${String(r.compared).padStart(4)}  OHLC beda=${r.ohlcMismatches}  maxΔvol=${(r.maxVolumeRelDiff * 100).toFixed(4)}%  bucket tak lengkap=${r.incomplete}`
        )
        for (const ex of r.examples) console.log(`    ${ex}`)
      }
    return
  }

  const symbols = args.test ? TEST_SYMBOLS : args.symbols?.split(',').map((s) => s.trim())
  const limit = args.limit ? Number(args.limit) : undefined
  if (!symbols && !limit && !args.all) {
    console.error('Pilih salah satu: --test, --symbols, --limit N, atau --all (full backfill).')
    process.exitCode = 2
    return
  }
  const sources = (args.sources?.split(',') ?? [...SOURCE_TIMEFRAMES]) as SourceTimeframe[]

  const tty = process.stdout.isTTY
  let lastLine = 0
  backfiller.on('event', (e: BackfillEvent) => {
    if (e.type === 'start') console.log(`Mulai: ${e.total} simbol, sumber ${sources.join('/')}`)
    else if (e.type === 'progress') {
      if (!tty && Date.now() - lastLine < 5000) return
      lastLine = Date.now()
      const line = `[${String(e.completed).padStart(3)}/${e.total}] ${(e.fraction * 100).toFixed(1).padStart(5)}%  ${e.symbol.padEnd(14)} ${e.timeframe.padEnd(5)} ${e.step.padEnd(14)} ${fmtBytes(e.bytesDownloaded).padStart(10)}  ETA ${fmtDur(e.etaMs)}`
      if (tty) process.stdout.write(`\r${line.padEnd(110)}`)
      else console.log(line)
    } else if (e.type === 'symbol-error') console.log(`\n! ${e.symbol}: ${e.error}`)
    else if (e.type === 'symbol-done' && !tty) console.log(`✓ ${e.symbol} (${fmtDur(e.ms)})`)
  })

  const s = await backfiller.run({ symbols, limit, sources, data, signal: ctrl.signal })
  if (tty) process.stdout.write('\n')
  console.log(`\nSelesai dalam ${fmtDur(s.finishedAt - s.startedAt)} — ${s.completed}/${s.symbols} simbol, ${s.errors.length} error${s.aborted ? ' (dibatalkan)' : ''}`)
  console.log(`Download ${fmtBytes(s.bytesDownloaded)}, REST requests ${s.restRequests}`)
  console.log('Baris baru:', Object.entries(s.rows).map(([k, v]) => `${k}=${fmtInt(v)}`).join('  '))
  console.log(`Ukuran DB sekarang: ${fmtBytes(dbFileBytes(db))}`)
  if (args.test && !s.aborted) printEstimate()
  db.$client.close()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
