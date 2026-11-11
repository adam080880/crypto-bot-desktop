# SMC/ICT Trading Assistant — catatan untuk Claude

Aplikasi desktop Electron untuk bantu trading crypto (Binance USDT-M Futures) pakai konsep
SMC/ICT, news ekonomi USD, dan Claude sebagai analis berkala. Rencana lengkap & status fase:
**`docs/PLAN.md`** (baca dulu).

## Cara kerja dengan user
- Bahasa Indonesia santai (user pakai "gua/lo"). Ringkas, langsung ke poin.
- Kerjakan **per fase**. Selesai satu fase → **berhenti, kasih ringkasan**, tunggu go sebelum lanjut.
- Hal yang ambigu (terutama aturan SMC dari `materi/`) → tandai dan tanyakan, jangan ditebak.
- **Jangan bikin fitur kirim order live** sampai user minta. Default paper/testnet.
- **Full backfill (~10 GB) dijalankan user sendiri di PC pribadinya**, bukan oleh Claude dan bukan
  di laptop kerja. Untuk tes pakai `--test` (5 simbol) atau `--symbols`.

## Status (update tiap fase)
- Fase 1 ✅ scaffold, DB, tray, Kill Switch, Settings (API key via safeStorage).
- Fase 2 ✅ backfill historis + resample + estimasi. Tes 5 simbol OK; resample cocok 100% dengan
  kline asli Binance (`--verify`). Full backfill **belum** dijalankan.
- Fase 3 ✅ auto-sync (start + REST berkala via croner + prune harian), WebSocket kline live
  (chart/watchlist/posisi), forming candle 1m–4h ke chart (throttle 4x/detik), reconnect + isi gap,
  `powerSaveBlocker`, halaman Chart (lightweight-charts v5), filter simbol.
- Fase 4 ✅ `docs/smc-rules.md` dikonfirmasi user. Detektor fungsi murni di `src/main/strategy/`:
  swings/structure (BOS = pembalikan), OB (bentuk + **warna** candle), FVG, RBS/SBR, OCL/OCL break,
  QM, liquidity (wick OB + swing BSL/SSL), dan setups (POI kena → OB valid → entry/SL/TP, skor,
  status sampai TP/SL). Overlay di Chart (`src/renderer/src/chart/smcOverlay.ts`) dengan toggle layer.
- Fase 5 ✅ kalender ekonomi (FF feed + actual BLS/FRED/manual), bias USD→crypto, news window,
  reaksi harga, kandidat trade-on-news, statistik aturan. Fase 6 belum. **Fase 7 = bot trading Binance** (paper → testnet → live), hanya setelah user
  minta mulai. Detail di PLAN.md.

## Lanjut di sini
Fase 5 ✅. OCL sudah diputuskan user: OCL biasa hanya 1d/1w, di 4h ke bawah hanya OCL Break
(`oclPlainTimeframes`). Hasil 21 hari (net R): BTC −16,8, ETH −7,5, SOL +20,9. **Strategi belum
tervalidasi.** Jangan dipakai bot (Fase 7) sebelum ada backtest di data full.
Berikutnya: Fase 6 (Claude analis), menunggu go dari user.

## Keputusan yang sudah diambil (jangan diubah tanpa tanya)
- Data harga selalu dari endpoint **publik production** Binance (tanpa API key). Testnet harganya
  sintetis, jadi tidak dipakai untuk analisis.
- **1m 6 bulan** dari data.binance.vision (zip bulanan + harian, cek SHA-256) → REST klines
  (limit 1000 = weight 5) untuk gap terbaru. **1d/1w 2 tahun** via REST.
- **5m/15m/1h/4h di-resample dari 1m** dan disimpan sebagai tabel sendiri, dihitung bertingkat
  1m→5m→15m→1h→4h. Bucket dikunci ke UTC (4h = 00/04/08/12/16/20 UTC). Kolom `n` = jumlah
  candle 1m di bucket, untuk deteksi data tidak lengkap. Candle yang belum close **tidak** disimpan.
  Alasan: scan SMC multi-simbol berulang jadi murah (+~30% storage).
- Data turunan disimpan lebih lama (`derivedRetentionDays` 730) daripada 1m (`oneMinuteRetentionDays` 183).
- Minggu = Senin 00:00 UTC (sama dengan candle 1w Binance).
- Simbol disaring lewat config `data.excludeSymbols` (BTCDOM, USDC, XAUT, PAXG) + `excludeNonAscii`.
- WebSocket kline **wajib** pakai routed endpoint `wss://fstream.binance.com/market/stream`.
  URL lama tanpa `/market` tetap bisa connect tapi **tidak mengirim data kline** (diam-diam).
  Batasan: 1024 stream/koneksi, 10 pesan masuk/detik, koneksi diputus tiap 24 jam.

## Pertanyaan yang masih terbuka (tanyakan ke user)
1. Simpan harga sebagai integer berskala tick size untuk menghemat ~30–40% DB? Paling gampang
   diputuskan **sebelum** full backfill.
2. 1h/4h cuma 6 bulan (ikut 1m). Perlu download native 1h/4h 2 tahun?
3. ~~Jam daily/weekly~~ → selesai: **UTC** (materi tidak membahas sesi/jam).
4. ~~Q1–Q19 SMC~~ → selesai (lihat `docs/smc-rules.md`).

## SMC
- Sumber kebenaran aturan: `docs/smc-rules.md` (dari `materi/` + penjelasan user). Jangan menambah
  konsep di luar materi tanpa izin.
- User: OB/OB valid dikenali dari **bentuk candle**. Wick candle terakhir lebih panjang = sisa
  **liquidity**. Liquidity harus tampil di chart.

- `analyzeSmc(candles, tf, cfg)` dan `detectSetups()` itu **murni dan tidak repaint** (hanya pakai candle
  yang sudah close). Wajib dipakai sama persis untuk live dan backtest. `SmcService` cuma adapter DB.
- Test fixture di `src/main/strategy/testkit.ts` berjarak 15 menit (dianalisis sebagai 15m). Jarak
  candle harus cocok dengan TF, karena waktu aktif POI = waktu close candle.
- Hasil awal di data 21 hari (5 simbol): winrate ~22–26% dengan RR rata-rata 4–5. Ini **bukan**
  backtest yang valid. Backtest proper butuh full backfill + data out-of-sample.

## Arsitektur singkat
- `src/main` = otak (DB, exchange, sync, scheduler, Claude). `src/renderer` = UI saja, akses lewat
  `window.api` (kontrak di `src/shared/ipc.ts`, input divalidasi zod di main).
- **utilityProcess `src/main/workers/dataWorker.ts` = satu-satunya penulis data pasar**
  (backfill manual, AutoSync, LiveService/WebSocket). Penulisan dikunci per simbol
  (`Backfiller.locks`). Main (`src/main/sync/dataController.ts`) cuma meneruskan pesan, membaca
  DB untuk IPC (`candles:get`), dan me-restart worker kalau crash.
- Candle live yang close hanya ditulis kalau **nyambung** dengan `sync_state.last`
  (`Backfiller.ingestClosed1m`). Kalau ada lubang (putus/sleep) atau simbol belum pernah di-sync →
  isi via zip/REST dulu. Ini mencegah `sync_state` melompati data yang hilang.
- AutoSync melacak: simbol yang sudah punya histori 1m + watchlist + posisi. Setelah full backfill
  pertama (setting `full_backfill_done`), semua simbol aktif, jadi listing baru otomatis ter-backfill.
- Tabel candle `candles_<tf>` itu `WITHOUT ROWID` dengan PK `(symbol_id, open_time)`, dibuat di
  migration SQL manual `drizzle/0002_candles.sql` (drizzle-kit tidak mendukung WITHOUT ROWID).
  Akses lewat `CandleRepo` (`src/main/db/candles.ts`), termasuk helper mingguan `week()` / `weekBundle()`.
- `sync_state` (symbol, tf) → `last_open_time` naik terus (tidak pernah mundur), jadi backfill bisa
  dilanjutkan dari titik terakhir.
- Risk guard ditegakkan di kode (`src/shared/config.ts` + `src/main/risk`), stop-loss tidak bisa dimatikan.
- Lokasi data: `~/Library/Application Support/smc-trading-assistant/` (macOS); Windows di
  `%APPDATA%\smc-trading-assistant`. CLI dan app memakai DB yang sama (`src/main/userDataDir.ts`).
  Bisa diganti lewat env `SMC_DB_PATH` / `SMC_USER_DATA`.

## Setup di mesin baru (PC)
```bash
corepack enable            # pnpm 11
pnpm install               # pnpm-workspace.yaml sudah mengizinkan build: electron, better-sqlite3, esbuild
# Kalau node_modules/electron/dist tidak ada (binary Electron belum terdownload):
node node_modules/electron/install.js
pnpm rebuild:native        # build better-sqlite3 untuk ABI Electron
pnpm test && pnpm typecheck
pnpm dev
```
Backfill dari CLI:
```bash
pnpm data:backfill --test        # 5 simbol + estimasi full
pnpm data:backfill --estimate    # proyeksi ukuran DB/waktu
pnpm data:backfill --all         # FULL (~10 GB, ~1 jam 10 menit, ~5,4 GB download) — bisa Ctrl+C lalu dilanjutkan
pnpm data:backfill --verify      # cocokkan resample dengan kline asli Binance
```

## Sumber news (Fase 5, keputusan user)
- investing.com dan halaman forexfactory.com → **403 Cloudflare**. Jangan dicoba bypass.
- Jadwal/forecast/previous: feed JSON resmi `nfs.faireconomy.media/ff_calendar_thisweek.json` (tanpa
  actual). Ambil maksimal tiap 60 menit.
- Actual: **BLS API** (tanpa key 25 request/hari, dicatat di setting `bls_quota`; key opsional di Settings)
  dan **FRED CSV** `fred.stlouisfed.org/graph/fredgraph.csv?id=…` (tanpa key). Event tanpa sumber resmi
  (ISM, UoM, ADP) → actual diisi manual di UI.
- Seri sudah diverifikasi cocok dengan "previous" FF: PPI = `WPSFD4`, Core PPI = `WPSFD49104`.
- Aturan interpretasi ada di config `news.rules` (bisa diedit di Settings). Bias crypto pakai
  `cryptoBiasMode` (default inverse).

## Gotchas
- better-sqlite3 di-build untuk **Electron**, jadi `pnpm test` dan CLI jalan lewat
  `ELECTRON_RUN_AS_NODE=1 electron ...`. Jangan jalankan dengan `node` biasa (ABI mismatch).
- Pakai TypeScript 5.9 (bukan 7), demi kompatibilitas tooling.
- Setelah mengubah `src/main/db/schema.ts`: `pnpm db:generate`. Tabel candle: edit SQL manual.
- Logger modul (`logger('x')`) boleh dibuat saat import; dia ikut root logger yang aktif saat menulis log.
- **Jangan `pkill` semua Electron proyek ini**, karena itu ikut mematikan `yarn dev`/`pnpm dev` milik
  user. Matikan hanya PID yang Claude jalankan sendiri.
- Klik UI otomatis untuk verifikasi: jalankan `electron . --remote-debugging-port=9333` lalu pakai
  CDP (`Runtime.evaluate`). osascript tidak punya izin accessibility di laptop kerja.
- Watchlist pakai id Binance (`BTCUSDT`), bukan format ccxt. Mapping ke ccxt baru di Fase 7.
- Komponen shadcn/ui ditulis manual di `src/renderer/src/components/ui` (pakai paket `radix-ui`).
