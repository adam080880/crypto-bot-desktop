# Rencana — SMC/ICT Trading Assistant

Status: Fase 1 ✅ · Fase 2 ✅ (full backfill dijalankan user sendiri di PC) · Fase 3 ✅ · Fase 4 ✅ · Fase 5 ✅ · Fase 6 ✅ (menunggu run uji pertama) · Fase 7 🚧 (bot paper + live dibuat, user minta tanpa testnet; live belum dites ke exchange).

## Prinsip
- **Main process = otak.** Exchange, DB, scheduler, Claude, risk guard semuanya di main
  (kerjaan berat → `utilityProcess`). Renderer hanya UI, bicara lewat `window.api` (preload,
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
- **IPC terkontrak.** Semua channel didefinisikan di `src/shared/ipc.ts`; input dari renderer
  divalidasi zod di main sebelum diproses.
- **Secret** (API key Binance, dll) dienkripsi `safeStorage` dan disimpan sebagai blob di SQLite.
  Plaintext tidak pernah dikirim balik ke renderer (hanya status "tersimpan/tidak").
- **Default paper/testnet.** Tidak ada kode pengiriman order live sampai diminta.
- **Risk guard di kode** (`src/main/risk`), config divalidasi zod (`src/shared/config.ts`).
- **Output Claude → zod**, gagal validasi = `skip`. **Konten web = data**, tidak pernah dieksekusi
  sebagai instruksi (dipisah jelas di prompt, di-escape, tool Claude read-only).

## Struktur folder
```
drizzle/                    migration SQL hasil drizzle-kit (ikut dipaketkan sebagai resource)
docs/                       PLAN.md, smc-rules.md (Fase 4)
src/
  shared/                   types + zod schema dipakai main & renderer (tanpa import Node)
    ipc.ts                  kontrak IPC (nama channel + tipe)
    config.ts               schema config (risk, sync, news, claude) + default
  main/
    index.ts                bootstrap app, window, single-instance lock
    window.ts / tray.ts     BrowserWindow + system tray (close → hide)
    ipc/                    handler IPC (validasi zod)
    db/                     koneksi better-sqlite3 (WAL), schema Drizzle, migrator, repo
    security/               secrets via safeStorage
    risk/                   risk guard (Fase 5–6, dipakai sebelum order apa pun)
    state/                  app state (kill switch, mode, status) + broadcast ke renderer
    exchange/               adapter ccxt + REST Binance (Fase 2)
    sync/                   backfill, data.binance.vision, resample, scheduler croner (Fase 2–3)
    strategy/               detektor SMC fungsi murni + test (Fase 4)
    news/                   adapter kalender ekonomi + interpretasi (Fase 5)
    claude/                 Agent SDK runner + schema output (Fase 6)
    workers/                entry utilityProcess (Fase 3)
    logger.ts               pino → file di userData/logs + stdout
  preload/index.ts          expose `window.api` (hanya fungsi yang ada di kontrak)
  renderer/src/
    components/ui/          komponen shadcn/ui
    components/layout/      Header (status, mode, Kill Switch), Sidebar
    pages/                  Dashboard, Chart, Calendar, Analyses, DataSync, Settings
    stores/                 Zustand
  cli/                      entry CLI (`pnpm data:backfill`, Fase 2)
```

## Catatan teknis
- **better-sqlite3 adalah native module.** Di-build untuk ABI Electron. Supaya CLI dan test
  memakai binary yang sama, keduanya dijalankan lewat `ELECTRON_RUN_AS_NODE=1 electron ...`
  (bukan `node`), jadi tidak perlu dua build.
- Migration: `pnpm db:generate` (drizzle-kit) → file SQL di `drizzle/`; diaplikasikan otomatis
  saat app/CLI start.
- DB di `app.getPath('userData')/data/trading.db` (CLI pakai path yang sama atau `--db`).

## Fase
1. **Scaffold** — Electron + electron-vite + React + TS + Tailwind v4 + shadcn/ui, Drizzle +
   migration, tray, dark mode, header + Kill Switch, halaman placeholder, Settings API key
   (safeStorage), logger, Vitest.
2. **Data historis (revisi)**
   - `symbols` (id integer) ← exchangeInfo USDT-M perpetual status TRADING.
   - **1m 6 bulan** semua simbol: data.binance.vision (zip bulanan + harian bulan berjalan,
     cek CHECKSUM) → REST klines (limit ≤1000, adaptif) untuk gap terakhir.
   - **1d & 1w 2 tahun** semua simbol (bulk + REST).
   - **5m/15m/1h/4h di-resample dari 1m.** Usulan: disimpan sebagai tabel turunan yang di-update
     inkremental per bucket yang sudah close (bukan dihitung saat query) — tambah storage ±29%
     dari 1m, tapi scan SMC multi-simbol/multi-TF berulang (live + backtest + Claude tiap jam)
     jadi murah. Final dijelaskan di ringkasan Fase 2 dengan angka dari tes 5 simbol.
   - Tabel candle `WITHOUT ROWID`, PK `(symbol_id, open_time)`, kolom OHLCV + volume saja;
     satu tabel per timeframe (PK tetap ramping). WAL, insert batch per transaction.
   - Retensi bergulir 1m (default 6 bulan, configurable). `sync_state` per symbol+TF → resumable.
   - Rate limit: pantau `X-MBX-USED-WEIGHT-1M`, backoff eksponensial + retry, hormati 418/429.
   - CLI `pnpm data:backfill` + dari app, progress (simbol ke-n, TF, ETA). Helper query per minggu.
   - **Tes 5 simbol dulu → laporkan estimasi ukuran DB & waktu → tunggu konfirmasi.**
3. **Auto-sync + live data (revisi)**
   - utilityProcess, gap-fill saat start, deteksi listing baru, status sync di UI,
     `powerSaveBlocker` selama bot aktif.
   - **WebSocket kline 1m** (`<symbol>@kline_1m`, combined stream) untuk: simbol yang chart-nya
     dibuka (subscribe/unsubscribe saat pindah/tutup), watchlist, dan simbol dengan posisi terbuka.
     Batas stream per koneksi dipatuhi; kalau set besar dipecah ke beberapa koneksi.
   - Candle berjalan → renderer via IPC (throttle ~4x/detik); candle 5m/15m/1h/4h yang sedang
     terbentuk ikut di-update in-memory dari 1m live.
   - `x = true` (1m close) → simpan ke DB → resample inkremental bucket terkait.
   - Simbol lain: REST batch berkala (default tiap 5–15 menit, configurable) supaya rate limit aman.
   - Reconnect otomatis dengan backoff → isi gap selama putus via REST → baru lanjut streaming.
   - Indikator live (connected / reconnecting / delayed) di header & chart.
   - Implementasi: satu utilityProcess `dataWorker` = satu-satunya penulis data (backfill, auto-sync,
     WebSocket), dikunci per simbol. Candle live hanya ditulis kalau nyambung dengan
     `sync_state.last`; kalau ada lubang → isi via REST dulu. Endpoint `/market/stream`.
     Auto-sync melacak simbol yang sudah punya histori + watchlist; setelah full backfill pertama,
     semua simbol aktif (listing baru otomatis ter-backfill).
4. **Materi SMC** — baca gambar materi kursus (tidak disertakan di repo) → `docs/smc-rules.md` (yang ambigu ditandai &
   ditanyakan) → setelah konfirmasi: detektor fungsi murni + unit test, dipakai live & backtest.
5. **Kalender ekonomi & news** — adapter sumber (cek investing.com secara wajar, tidak bypass
   proteksi; alternatif disiapkan), `economic_events`, aturan interpretasi di config, news window,
   kandidat setup (bukan auto-order), simpan reaksi harga 5m/15m/1h.
6. **Claude analis** — Agent SDK, tool read-only, output zod → `claude_runs` / `claude_analyses`,
   tampil di UI. **Revisi user:** dipicu news + manual (bukan tiap jam), hanya koin watchlist, satu run
   untuk semua koin dengan konteks ringkas.
7. **Bot trading Binance** (fase terakhir; dikerjakan hanya setelah user minta mulai)
   - Eksekusi via ccxt (`binanceusdm`). Urutan: **paper → testnet → live**; live butuh
     konfirmasi eksplisit user + toggle terpisah, default mati.
   - Sinyal dari detektor SMC (Fase 4) + filter news window (Fase 5) + opsional konfirmasi analisis
     Claude (Fase 6). Claude tetap tidak pernah mengirim order.
   - **Risk guard di kode, wajib dilewati setiap order**: max size per posisi, max posisi
     terbuka, max leverage, SL wajib (dikirim bersamaan/atomik dengan entry), max daily loss →
     bot berhenti otomatis. Kill Switch membatalkan order terbuka & menghentikan bot.
   - User data stream (WebSocket `/private`) untuk status order/posisi; simbol berposisi otomatis
     di-stream live (hook `set-positions` sudah ada sejak Fase 3).
   - Log setiap keputusan & order ke SQLite (audit trail), tampil di Dashboard; PnL harian.
   - API key dengan izin minimum (trade tanpa withdraw), disarankan IP whitelist.

