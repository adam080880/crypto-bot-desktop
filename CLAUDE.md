# SMC/ICT Trading Assistant — catatan untuk Claude

Aplikasi desktop Electron untuk bantu trading crypto (Binance USDT-M Futures) pakai konsep
SMC/ICT, news ekonomi USD, dan Claude sebagai analis berkala. Rencana lengkap & status fase:
**`docs/PLAN.md`** (baca dulu).

## Cara kerja dengan user
- Bahasa Indonesia santai (user pakai "gua/lo"). Ringkas, langsung ke poin.
- Kerjakan **per fase**. Selesai satu fase → **berhenti, kasih ringkasan**, tunggu go sebelum lanjut.
- Hal yang ambigu (terutama aturan SMC di `docs/smc-rules.md`) → tandai dan tanyakan, jangan ditebak.
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
  reaksi harga, kandidat trade-on-news, statistik aturan. Fase 6 ✅ (lihat bagian Claude analis). Fase 8 (entry v2) 🚧: 8B mesin entry, 8C Backtest v2, 8D bot selesai; 8E UX (screener/chart/settings) belum. **Fase 7 = bot trading Binance** (paper → testnet → live), hanya setelah user
  minta mulai. Detail di PLAN.md.

## Lanjut di sini
Fase 6 ✅ dibangun (Claude analis via Agent SDK), **belum pernah dijalankan dengan model asli**. Run
pertama menunggu persetujuan user, karena memakai kredit/akun Claude-nya. Setelah itu verifikasi hasil di
halaman Claude Analyses. Fase 7 (bot) sudah dibuat atas permintaan user (lihat "Bot Fase 7"). Live belum pernah
dites ke exchange beneran.

## Entry v2 + exit bertingkat (keputusan user, 2026-11-14) — detail: `docs/entry-v2.md`
- Entry **hanya di OB / QM / breaker**. **Tidak pernah di FVG** (cuma info/konfluensi) dan **tidak di OCL/OCL Break**.
  OCL cuma boleh jadi POI induk (alasan), dan harus dari HTF. OB = Order Block, bukan OCL Break.
- Tiap POI punya `origin` (liquidity sweep / nyentuh POI TF lebih besar). POI induk tanpa origin tidak dipakai.
- Model (`Setup.model`): M0 (aturan lama, cuma baseline), M1 POI besar → CHoCH 15m + displacement → QM/OB kecil,
  M2a OB di balik SSL/BSL, M2b grab + CHoCH, M4 breaker. Trend BTC 4h/1h dan Wyckoff (`wyckoff.ts`) **cuma skor**.
- Exit (`config.exit`, `strategy/exit.ts` `ExitTracker`, dipakai backtest + bot): 1R → BE incl. fee, 3R → tutup 50% +
  SL 1R, lalu trailing (best − 2R). **Order flow** (FVG searah diretest dan mantul, atau wick reaktif di area entry) →
  tahan posisi (tanpa partial/trailing, SL ke ujung retest/wick, BE tetap jalan). Close tembus FVG berarti order flow patah.
- Bot: `bot.requireClaude` default **false** (murni ICT). `bot.models` default M1/M2b/M4, `bot.requireConfluence`
  default `fvg + trendParent`. SL live digeser dengan pasang algo baru dulu, baru batalkan yang lama. Partial lewat
  reduce-only market. Tracker dibangun ulang dari 1m DB setelah restart.
- Backtest lab 2 tahun BTC/ETH/SOL (fee + 1m): M0 −0,25R. M1 + FVG + trend di TP 1R: WR 53% (OOS 59%), ±0R.
  M4 + FVG + trend: WR 56%, ±0R. **Belum ada edge bersih yang konsisten setelah fee.** Fee ±0,15–0,2R per trade
  (SL median 0,4–0,6%). Order flow menaikkan WR 2–3 poin tapi avg R tidak naik. Script ada di scratchpad sesi, bukan repo.
- **M5 trend breakout 4h** (bukan SMC, permintaan user 2026-11-14, `docs/entry-v2.md §9`): close 4h tembus channel 20 +
  EMA200 → limit di close, SL 3×ATR, exit trailing saja (`trendExit`, tanpa BE/TP). Satu-satunya model yang positif di
  IS dan OOS (lab +0,08R lewat kode app). Konfluensi wajib tidak berlaku untuk M5. `smc.models` lama otomatis ditambah M5
  saat load (`appState`). Killzone (`killzone`, `smc.killzonesUtc`) = filter saja, di lab tidak ada edge.
- **Open interest + funding** (`docs/entry-v2.md §10`): tag `oiConfirm` / `oiFlush` / `fundingContra` (filter, tanpa skor).
  `oiHold` (OI 15m tidak turun > 0,3%). M5 + `oiConfirm` + `oiHold` = +0,26R (IS +0,27, OOS +0,24), default
  `bot.trendRequireConfluence` khusus M5. OI = snapshot **5 menit**, DB cuma simpan OI 3 hari + funding 35 hari
  (`flow_oi`/`flow_funding`, `FlowSync` tiap 15 menit di :x0:40). Backtest download histori dari data.binance.vision
  saat run, tidak disimpan.
- **Radar pump + Discord** (`docs/entry-v2.md §12`, 2026-11-15): pump tidak bisa dideteksi saat koin sepi; yang kuat =
  volume 24j ≥ 8× median atau funding ≤ −0,05% + volume ≥ 3× (default, lift 5,3–6,8×, ±12–18 notif/hari). M6 otomatis rugi di OOS (slippage), jadi
  radar = **notifikasi saja** (`radar`, `notify` config; webhook = secret `discord.webhookUrl`, tes di Settings). Bot tidak
  entry dari radar. Breaker cuma 1h/4h (`smc.breakerTimeframes`), SL ≥ 1× ATR14 (`smc.minSlAtr`), M4 TP 1R (`breakerTpR`).
  SL < 1% → BE baru di 2R kunci +0,5R bersih (`exit.tightSlPct`). BE punya kategori sendiri di halaman Bot.
- **M6 radar pump = model bot** (keputusan user, `docs/entry-v2.md §13`): long saja, entry limit di close 1h yang tembus box
  24j setelah radar, SL 3× ATR, **tanpa TP (user TP manual)**, trailing SL. Lab OOS −0,21R (n kecil), user tetap mau.
  Tag `anomaly` (volume 24j ≥ 3× median): setup di koin "bangun" justru lebih bagus (M5 OOS +0,24–0,30R vs −0,13R).
- **Premium/discount + Bollinger + blacklist SL** (2026-11-16, `docs/entry-v2.md §14`): tag `pdZone` (long di discount /
  short di premium range 4h 60 candle) **wajib default** untuk SMC, `bbMomentum` (BB 1h) cuma filter, blacklist koin
  setelah 3× SL dalam 7 hari (`bot.slBlacklist*`, `src/main/bot/blacklist.ts`). SBR/RBS memang break pakai close (body).
- **BTC dominance** (2026-11-17, `docs/entry-v2.md §15`): tag `btcDom` dari `BTCDOMUSDT` 4h (REST langsung, tidak disimpan,
  `src/main/flow/btcDom.ts`). Alt long saat BTCDOM turun, short saat naik, BTC dibalik. USDT.D tidak dibuat (= kebalikan `btc4h`).
- **M0 + liquidity** (2026-11-18, `docs/entry-v2.md §16`): M0 wajib `poiLiq` (wick POI belum diambil), tag `slLiqClear`
  (tidak ada swing di belakang SL ≤ 1R), OCL Break cuma weekly. Lab 40 koin: M0 terbaik tetap ≈ −0,03 s/d −0,07R, belum ada edge.
- **Batas posisi searah** (2026-11-18, `bot.maxSameDirection`, default 0 = mati atas permintaan user, `gate.ts directionGate`): pending + open per arah.
  Pemicu: 5 short alt kena SL bareng saat BTC pump +2,5%. Filter momentum BTC **tidak** dibuat: di lab M0, setup yang melawan
  momentum BTC 2–4h justru lebih bagus (reversal), jadi risikonya korelasi (variance), bukan expectancy. M0 dimatikan lagi.
- **TF POI + poiStack** (2026-11-18, `docs/entry-v2.md §17`): `bot.poiTimeframes` sekarang berlaku untuk M0/M1/M2a/M2b
  (M4/M5/M6 tidak), user set 4h + 1d; `smc.poiTimeframes` ditambah 1d. Tag `poiStack` (POI induk berdekatan ≤ `smc.poiStackPct`
  dengan POI aktif TF lain ≥ 1h) justru **lebih jelek** di lab (−0,15R vs −0,08R), jadi cuma info. Lab 40 koin: POI 1d +0,31R
  (OOS +0,41), 4h+1d +0,05R; M0 4h+1d +0,12R (IS +0,08, OOS +0,20), M0 POI 1d +0,37R. M1 tetap negatif di semua TF POI.
- **Konfluensi per model** (2026-11-19, `docs/entry-v2.md §18`): `bot.modelConfluence` (list wajib per model) menggantikan
  `requireConfluence` + `trendRequireConfluence` (dimigrasi sekali di `AppState`). Alasannya, M0 tidak pernah punya `fvg` dan M4 tidak pernah
  punya `prevOpposite`. Rekomendasi lab (`RECOMMENDED_MODEL_CONFLUENCE`, tombol di Settings): M0 `prevOpposite+slLiqClear`, M4
  `fvg+oiConfirm+slLiqClear` (lab 300 koin), M5 `btc1h+anomaly` (default lama M5 `oiConfirm+oiHold` OOS −0,23R). M1 negatif di semua kombinasi.
  Filter momentum sebelum fill (koin > 2R / BTC > 0,6% melawan) tidak ada edge di lab 300 koin, jadi tidak dibuat.
- **Order flow tanpa geser SL** (2026-11-19, `docs/entry-v2.md §19`): `exit.orderFlowMoveSl` default false. Order flow cuma menahan
  posisi (tanpa partial/trailing), SL tidak ditarik ke retest/wick. Lab 100 koin: M0 +0,26R → +0,35R, M2a +0,28R → +0,37R (IS dan OOS).
- **Patokan risk tetap** (2026-11-20): `bot.riskBaseUsdt` (0 = saldo saat ini). > 0 → 1R = `riskPerTradePct` % × patokan, tidak ikut
  naik-turun saldo (`sizing.ts planOrder riskBase`). Batas notional/leverage tetap pakai equity asli. User set ke modal 69,27 USDT.
- **Statistik sejak tanggal** (2026-11-18): `bot.statsSince` (ms, 0 = semua) memfilter statistik per model di halaman Bot
  berdasarkan waktu trade dibuka. Ada baris Total + DD maks (`tradeStats` di `@shared/bot`). User testing pakai risk 6,5%
  (SL M5/M6 lebar tidak lolos min notional 5 USDT dengan modal ±17 USDT) dan rem harian `risk.maxDailyLossPct` 25%.
- **Rotasi momentum = PAPER SAJA** (`docs/entry-v2.md §11`, halaman Rotasi, `src/main/rotation/`). Long/short top 60 volume,
  lookback 75 hari, 8 per sisi, rebalance mingguan. Tidak pernah kirim order. Lab realistis: OOS −41% s/d +5% tergantung
  hari rebalance, DD 44–62%. Jangan dijadikan bot live tanpa forward test yang meyakinkan.

## Screener (keputusan user)
- Halaman **Screener**: scan **semua simbol yang punya histori 1m** (lolos `isSymbolAllowed`), dari data
  tersimpan. Pakai `SmcService.context()` yang sama dengan chart/Claude, logika murni di
  `src/main/screener/screen.ts`, runner `ScreenerService` di **data worker** (yield per simbol).
- Kriteria per simbol+arah: setup OB valid aktif (pending/triggered), harga dekat POI aktif 1h/4h
  (≤ `nearPoiPct`, sisi yang benar), trend 4h/1h/15m searah, BOS 1h/4h ≤ `bosRecentHours`. Baris
  muncul kalau ada setup / dekat POI / BOS baru. Trend searah cuma flag/filter.
- Pemicu: tombol manual + otomatis 1 menit setelah tiap 15m close + sekali 90 detik setelah start.
  Auto-scan dilewati saat backfill manual. Hasil terakhir disimpan di setting `screener_last`.
- Notifikasi desktop untuk setup baru dari scan otomatis (`screener.notify`).
- Benchmark data asli (155 simbol): ±1,3 detik.
- Header tabel bisa diklik buat sort (naik → turun → balik ke ranking screener). Sel kosong selalu di bawah.

## Backtest v2 (2026-11-14) — menggantikan sebagian aturan di bawah
- Jalan di **utilityProcess sendiri** (`workers/backtestWorker.ts`, DB read-only, satu proses per run), bukan di main.
  Progress lewat event `backtest:progress`.
- `runBacktest` menghitung **semua model × semua rencana exit** (`simulate.ts defaultPlans`) sekaligus dengan
  fill/exit di **candle 1m**. Hasil per setup (`BtSetup.res[plan]`) dikirim ke UI. Filter/statistik/equity/Meta
  dihitung di renderer lewat `@shared/backtestStats` (tanpa run ulang).
- Tab **Meta**: kombinasi model × POI induk × exit, diurutkan berdasarkan avg R out-of-sample. "Kokoh" = positif di IS
  (≥ min trade) **dan** OOS. Tombol **Pakai** menyimpan **profil koin** (setting `coin_profiles`). Bot memakai profil
  itu untuk koin tersebut (model, POI, konfluensi, skor, dan rencana exit), menggantikan default global.
- Klik trade akan membuka Chart di waktu itu (`localStorage chart.focus`, dibaca sekali), plus garis entry/SL.

## Backtest (keputusan user, 2026-11-12)
- **Satu koin saja**, yaitu yang lagi dibuka di Chart (`localStorage chart.symbol`). Jangan scan semua koin.
  Jalan di main lewat IPC `backtest:run` (~1,5–2 dtk per koin, data 6 bulan). Logika murni ada di
  `src/main/backtest/engine.ts`, runner di `runBacktest.ts`, memakai `SmcService.history()` (semua candle).
- Ada dua ukuran: **A. setup** (POI hit → OB valid → limit, sampai TP/SL, dalam R) dan **B. reaksi POI**
  (dari garis POI, race +X% vs −X%, X = 0,5/1/2%, jendela `reactionHours`; sisi rugi dihitung duluan).
- **Lewat TP = batal**: `followSetup` memberi status `missed` kalau TP kena sebelum limit entry terisi,
  termasuk kalau entry dan TP kena di candle yang sama (konservatif). Berlaku juga di live/screener/chart.
- Fee: entry & TP maker 0,02%, SL taker 0,05% + slippage 0,02% (bisa diubah di form).
- Periode: out-of-sample = 60 hari terakhir, sisanya in-sample (4+2 bulan). Kalau histori < 3× itu,
  dibagi 2:1.
- Simulasi equity: risk `bot.riskPerTradePct` % equity per order, size = risk ÷ jarak SL, dibatasi
  `risk.maxLeverage`, 1 posisi per koin, berhenti sisa hari UTC kalau rugi harian ≥ `risk.maxDailyLossPct`.
  Belum memperhitungkan minimal notional order Binance.
- Hasil awal (default config, 4 koin besar, 6 bulan): sebelum fee kira-kira impas, setelah fee −0,1 s/d −0,6R
  per trade. Median jarak SL 0,2–0,28%, jadi fee ≈ 0,3–0,4R. Skor setup tidak berkorelasi dengan hasil.
  Reaksi POI 4h lebih kuat dari 15m.

## Confidence & skor (untuk Fase 7)
- User: **confidence berpengaruh besar untuk bot**. Setting `bot.minConfidence` (default 70, int 0–100,
  Settings → Bot entry) = syarat minimum `confidence` analisis Claude. Belum dipakai, karena bot belum ada.
- `confidence` itu **nilai self-report Claude** (prompt: "confidence 0–100"), bukan hasil hitungan kode.
  Belum ada rubrik di prompt dan validasinya cuma range (zod). Analisis juga nggak terikat ke setup id
  tertentu, dan cuma jalan saat news/manual untuk watchlist (bisa basi berjam-jam).
  → Bot wajib cek: bias == arah setup, umur analisis, `forcedSkip` = false.
- User: setting bot **berbasis risk**. `bot.riskPerTradePct` (default 1, 0,05–5) = % equity yang rela hilang
  per order kalau kena SL. Size = equity × risk% ÷ (jarak entry–SL + fee). `risk.maxPositionPct` **dihapus**
  (keputusan user): notional dibatasi `risk.maxLeverage` × equity.

## Bot Fase 7 (keputusan user, 2026-11-12)
- User minta **tanpa testnet**: paper → live. `bot.live` default false, **tidak bisa** diubah lewat
  `config:update` (patch schema meng-omit `live`). Cuma lewat IPC `bot:setLive` + ketik "LIVE" + kedua
  Binance key tersimpan. Saklar ada di halaman Bot.
- Kode: `src/main/bot/` (jalan di **data worker**, di sebelah screener & Claude). `gate.ts` (setup/akun/Claude),
  `sizing.ts`, `brokers.ts` (Paper/Live), `binanceTrade.ts` (REST signed), `botService.ts`, tabel
  `bot_trades` + `bot_events` (migration 0005).
- Kandidat = setup screener **pending** di koin **crypto** (`underlyingType COIN` + subtype `Crypto`, bukan
  TradFi/XAU/index) **top `bot.topVolume` (100) volume 24 jam** yang punya data lokal, POI dari
  `bot.poiTimeframes` (1h/4h = "POI HTF kena → OB valid 15m"), umur setup ≤ `maxSetupAgeMin`.
- **Confidence Claude wajib** (keputusan user): analisis harus dibuat setelah setup diketahui, umur ≤
  `maxAnalysisAgeMin`, bias searah, confidence ≥ `minConfidence`, bukan forcedSkip. Kalau belum ada,
  bot memanggil `analyst.runFor(symbols)` (trigger `bot`, kena batas biaya harian Claude).
- Order live: isolated margin, One-way Mode (Hedge Mode ditolak), limit entry **post-only (GTX)**, SL
  **STOP_MARKET closePosition** lewat **Algo Order API** (`/fapi/v1/algoOrder`). Binance menolak SL closePosition
  sebelum ada posisi (-4509), jadi (keputusan user 2026-11-14) SL dipasang **begitu fill terdeteksi** (tick 5 dtk,
  termasuk partial fill, dan saat restart kalau posisi belum ber-SL). Kalau SL gagal → sisa entry dibatalkan,
  posisi ditutup market. Akun wajib **Single-Asset Mode** (Multi-Assets menolak isolated, -4168). Trade error bisa
  di-**Retry** dari Riwayat: baris ditandai `retried`, setup dicek ulang lewat semua gate (bukan kirim ulang buta). TP = limit reduce-only setelah fill. Pending dibatalkan
  kalau lewat TP / expired / Kill Switch. Posisi terbuka tetap dijaga SL+TP saat Kill Switch.
- **Leverage = setinggi yang aman** (keputusan user 2026-11-14, `sizing.ts pickLeverage`): min(`risk.maxLeverage`,
  bracket simbol `/fapi/v1/leverageBracket`, batas likuidasi). Syarat: 1/L − mmr ≥ 1,5 × jarak SL + fee, jadi likuidasi
  isolated selalu jauh di belakang SL. Margin = notional ÷ L; rugi di SL tetap = risk%. Kalau margin butuh leverage
  di atas batas aman → setup dilewati.
- Satu posisi per koin, `risk.maxOpenPositions`, berhenti sisa hari UTC kalau rugi ≥ `maxDailyLossPct`,
  tidak entry di news window. Order di bawah min notional Binance dilewati, bukan diperbesar.
- Universe di-stream live (LiveSources.bot) supaya data screener segar. Event `kline` LiveService dipakai
  untuk deteksi fill/TP/SL paper dan "lewat TP".
- Mode live **belum pernah dites ke Binance beneran** (tidak ada testnet). Order pertama perlu diawasi user.
- `Setup.score` (deterministik, `detectSetups` §9): 3 + FVG ±2 + POI TF lebih tinggi +1 + searah trend
  TF POI +1 + candle sebelumnya berlawanan +1 → rentang 1–8. **Fix look-ahead (2026-11-11):** trend
  dulu dibaca dari candle HTF yang belum close. Sekarang pakai `trendKnownAt` (waktu close). Efeknya ke
  79/6799 setup di data lokal.

## Claude analis (Fase 6, keputusan user)
- Pakai **Claude Agent SDK** (Claude Code CLI), model **claude-opus-5-5**, effort medium.
- **Bukan per jam.** Dipicu actual news USD (rilis barengan digabung, debounce 90 detik) + tombol manual.
  `claude.intervalMinutes` default 0 (mati).
- **Cuma koin watchlist**, satu run untuk semua koin. Konteksnya ringkasan SMC yang sudah dihitung
  (±250 token/koin) + `smc-rules.md` di system prompt (kena cache).
- Dikunci: `tools: []`, 3 tool MCP read-only (`get_candles`, `get_smc_detail`, `get_economic_events`),
  `permissionMode: 'dontAsk'`, `settingSources: []`, `persistSession: false`, cwd kosong khusus,
  `maxTurns`, `maxBudgetUsd` per run, dan batas biaya harian.
- Output: JSON schema (`outputFormat`) + validasi zod per koin. Yang invalid/hilang → `skip`.
- API key Anthropic opsional di Settings. Kalau kosong, CLI pakai login Claude Code di mesin itu.
- CLI Claude Code **tidak dibundel**: pakai `claude` yang terinstal (lihat "Build Windows").

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
- **DNS Cloudflare** (keputusan user, ISP memblokir Binance lewat DNS): `src/main/net/dns.ts`
  `installCloudflareDns()` dipanggil di main, data worker, dan CLI backfill. Fungsi ini memasang undici global
  dispatcher dengan custom lookup: DoH 1.1.1.1 → 1.0.0.1 → UDP Cloudflare → DNS sistem (ada log). Fetch dan
  WebSocket bawaan Node ikut lewat sini. Matikan dengan env `SMC_SYSTEM_DNS=1`. Tombol **Test koneksi** di halaman
  Bot (`bot:testConnection`, `src/main/net/binanceCheck.ts`) bersifat read-only dan mengecek DNS, REST, WS, akun,
  dan position mode.

## Pertanyaan yang masih terbuka (tanyakan ke user)
1. Simpan harga sebagai integer berskala tick size untuk menghemat ~30–40% DB? Paling gampang
   diputuskan **sebelum** full backfill.
2. 1h/4h cuma 6 bulan (ikut 1m). Perlu download native 1h/4h 2 tahun?
3. ~~Jam daily/weekly~~ → selesai: **UTC** (materi tidak membahas sesi/jam).
4. ~~Q1–Q19 SMC~~ → selesai (lihat `docs/smc-rules.md`).

## SMC
- Sumber kebenaran aturan: `docs/smc-rules.md` (dari materi kursus user, gambarnya tidak disimpan di repo, + penjelasan user). Jangan menambah
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
  `%APPDATA%\smc-trading-assistant`. Urutan path DB (`src/main/userDataDir.ts`, dipakai app & CLI):
  env `SMC_DB_PATH` → `location.json` (diatur di **Settings → Lokasi database**) → `<userData>/data/trading.db`.
  Memindahkan DB (`src/main/storage.ts`): hentikan worker → checkpoint WAL → salin + verifikasi →
  catat lokasi baru → hapus file lama → app relaunch. Kalau gagal, lokasi lama tetap dipakai.

## Setup di mesin baru (PC)
```bash
corepack enable            # pnpm 11
pnpm install               # pnpm-workspace.yaml sudah mengizinkan build: electron, better-sqlite3, esbuild
# Kalau node_modules/electron/dist tidak ada (binary Electron belum terdownload):
node node_modules/electron/install.js
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

## Build Windows
- Dari Mac: `pnpm dist:win:portable` → `release/SMC Trading Assistant-<versi>-win.zip` (portable, tanpa
  installer; tanpa Wine). Installer NSIS `.exe` dari Mac butuh Wine, jadi build installer di Windows saja:
  `pnpm dist:win` di PC Windows, atau workflow GitHub Actions `.github/workflows/build-windows.yml`
  (manual dispatch / tag `v*`).
- better-sqlite3 v13 itu **N-API + prebuilt untuk semua OS** (`prebuilds/<os>-<arch>.node`, dipilih
  otomatis saat runtime), jadi `npmRebuild: false`. Jangan nyalakan lagi, karena cross-compile akan gagal.
- **Claude Code TIDAK dibundel** (±300 MB). App memakai `claude` yang terinstal (`findClaude()`: path di
  Settings → PATH → ~/.local/bin dll.). Build belum diberi code signing, jadi Windows SmartScreen akan
  memperingatkan.

## Gotchas
- better-sqlite3 v13 memakai N-API dengan binary prebuilt per OS (tidak perlu rebuild). `pnpm test` dan
  CLI tetap jalan lewat `ELECTRON_RUN_AS_NODE=1 electron ...` supaya runtime-nya sama dengan app.
- Pakai TypeScript 5.9 (bukan 7), demi kompatibilitas tooling.
- **Zod 4 tetap mengisi `.default()` di dalam `.partial()`**. Patch config wajib lewat `parseConfigPatch()`
  (cuma key yang dikirim yang dipakai). Dulu tombol Start bot mereset `riskPerTradePct` dll. ke default.
- Setelah mengubah `src/main/db/schema.ts`: `pnpm db:generate`. Tabel candle: edit SQL manual.
- Logger modul (`logger('x')`) boleh dibuat saat import; dia ikut root logger yang aktif saat menulis log.
- **Jangan `pkill` semua Electron proyek ini**, karena itu ikut mematikan `yarn dev`/`pnpm dev` milik
  user. Matikan hanya PID yang Claude jalankan sendiri.
- Klik UI otomatis untuk verifikasi: jalankan `electron . --remote-debugging-port=9333` lalu pakai
  CDP (`Runtime.evaluate`). osascript tidak punya izin accessibility di laptop kerja.
- Watchlist pakai id Binance (`BTCUSDT`), bukan format ccxt. Mapping ke ccxt baru di Fase 7.
- Komponen shadcn/ui ditulis manual di `src/renderer/src/components/ui` (pakai paket `radix-ui`).
