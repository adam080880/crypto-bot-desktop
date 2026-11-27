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
- **OCL bukan POI, OCL Break HTF iya** (2026-11-20, `docs/entry-v2.md §16`): `smc.oclParentTimeframes` [] (OCL biasa cuma di chart),
  `smc.m0OclBreakTimeframes` 4h/1d/1w. Membatalkan keputusan 2026-11-18 (OCL Break M0 cuma 1w).
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
- **M7 MSNR** (2026-11-20, `docs/entry-v2.md §20`): level A/V fresh dari close 4h, storyline EMA20 harian, TP level fresh berikutnya.
  Aturan dari internet (bukan materi). Mesin app 150 koin: +0,10R (IS −0,01 / OOS +0,32), profit kebanyakan short di Nov. Tidak masuk
  bot otomatis. Lab strategi lain (breakout sesi, reversal harian, lonjakan volume, mean reversion BB) semuanya negatif.
- **Taker buy volume + jumlah trade** (2026-11-20, migration `0007_candle_flow`): kolom `buy_volume` (base) + `trades` di semua tabel
  candle (`Candle.bv` / `Candle.nt`), diisi dari zip vision, REST, dan WS kline (`V`, `n`), dijumlah saat resample (null kalau ada menit lama).
  Data lama = NULL sampai user jalankan `pnpm data:backfill --all --flow` (download ulang zip 1m ±5 GB, cuma isi 2 kolom, sync_state
  tidak berubah). Baca lewat `CandleRepo.rangeFlow` (`range`/`latest` sengaja tidak memuatnya). Untuk riset pump/akumulasi.
  Lab pertama (513 koin, 6 bln, micin 0,3–50 jt/hari, pump ≥ 15%/4j): volume/jumlah trade naikkan peluang gerak besar ±5×, tapi pump
  dan dump sama-sama (rasio tetap ±2:1). Taker buy/CVD tinggi tidak menaikkan peluang pump, cuma sedikit menurunkan dump. Koin sepi: pump
  0,16%/jam, dengan filter terbaik 0,28%. Belum ada prekursor yang bisa dipakai.
- **Fix look-ahead OCL** (2026-11-22, `strategy/ocl.ts`): OCL yang nanti jebol dulu diganti label jadi OCL Break di seluruh
  histori, jadi di backtest "OCL biasa" cuma berisi yang tidak pernah jebol. Sekarang keluar 2 entri: OCL biasa (invalid di
  candle break) + OCL Break. Live tidak kena. Di lab, OCL biasa 1d turun dari +0,15R jadi −0,05R setelah fix. Lab lama yang
  memakai OCL biasa sebagai POI (mis. "POI 1d +0,31R" 2026-11-18) kemungkinan ikut kegelembungkan.
- **Lab 2026-11-21/22 (semua di scratchpad, bukan repo):** (1) sweep equal low/high 1m → reclaim: ±0R sebelum fee, yang
  ngaruh cuma kedalaman sweep (SL lebar = fee kecil). (2) "M8" sweep LTF di dalam POI 1d/1w fresh (100 koin, 431 rb event):
  sama persis dengan sweep di luar POI, tidak ada edge. (3) ML LightGBM dari fitur mentah (15m market dan 1h limit,
  100–300 koin, walk-forward): model menghafal arah pasar per bulan (fitur BTC), tidak konsisten positif. (4) Dataset POI
  (2,25 jt sentuhan pertama, 300 koin, limit di garis POI, SL ujung POI, TP 2R): 15m rugi semua, QM dan OB paling jelek,
  makin besar TF makin bagus. Yang konsisten: searah BTC 4h, trend 1d searah, origin tap POI HTF. Kombinasi terbaik
  (POI 4h/1d RBS/SBR/OCL Break + BTC 4h + trend 1d searah + SL ≥ 1%): +0,08R, IS +0,05 / OOS +0,12, 5/7 bulan positif,
  tapi puluhan kombinasi dites dan holdout ikut terpakai → perlu forward test paper.
- **M8 POI HTF searah trend + shadow paper** (2026-11-22, `docs/entry-v2.md §21`): `modelM8` (POI 4h/1d RBS/SBR/OCL Break
  pertama kali disentuh, BTC 4h + trend 1d searah, SL ≥ 1 %, TP 2R). `bot.shadowModels` (default M8) = selalu paper walaupun bot
  live, tidak pernah order live, cek 1 posisi/koin dan slot dipisah per mode, profil koin tidak dipakai. App 100 koin: +0,09R. **Dimatikan 2026-11-24** (user: bikin bingung): `shadowModels` default [] + migrasi sekali `migr_no_shadow`;
  halaman Bot saat live cuma nampilin trade live; sisa trade paper dibersihkan tiap tick (`dropStrayPaper`: limit dibatalkan, posisi ditutup di harga terakhir).
- **Tag liquidity** (2026-11-22, `docs/entry-v2.md §22`): `liqHtfBehind` / `liqInPoi` / `cleanApproach` (`liquidityAround`). ML
  sebagai gerbang entry tidak stabil, jadi dibuat tag biasa. Wajib (migrasi sekali `migr_liq_tags`): M0 + `cleanApproach`,
  M1/M7 + `liqHtfBehind`. Efeknya beda per model (`cleanApproach` merusak M1/M2). M0 POI 4h/1d di backtest +0,24R (7/7 bulan),
  padahal live −0,06R/trade (lihat poin berikut).
- **Live vs backtest M0 (2026-11-22):** (1) **Look-ahead di backtest:** M0 dan `tappedHtf` membandingkan `poi.invalidT` (waktu
  BUKA candle pembatal) dengan waktu OB/candle, jadi setup yang POI-nya jebol oleh candle HTF yang masih berjalan dibuang (padahal
  live tidak tahu). Fix: pakai `closeTime(invalidT)`, test `m0.test.ts`. Efek: **M0 POI 4h/1d +0,25R → +0,02R** (7/7 → 3/7 bulan),
  M0 + filter bot +0,01R, + `cleanApproach` +0,03R. Semua angka M0 lama (lab 11-18 "4h+1d +0,12R", "POI 1d +0,37R") kegelembungkan.
  M7/M8/M4 tidak kena. (2) **Label exit:** posisi yang flat di harga selain SL/TP dulu dicatat 'tp'/'sl'; sekarang `exitReason`
  (`brokers.ts`) → `external`, data lama di-relabel sekali (`migr_exit_reason`): 25 trade live `external`. (3) Live memakai jendela
  1000 candle (`POI_LOOKBACK`), backtest semua candle: beberapa setup hanya muncul di salah satu (efek kecil, belum di-fix).
- **Inducement + M9 + kombinasi terbaik** (2026-11-23, `docs/smc-rules.md §11`, `docs/entry-v2.md §23`): user minta konsep di luar
  materi dimasukkan ("materi masih basic"). Tag `baitTaken` (umpan = POI searah tanpa origin di depan POI, sudah kena), `idmSwept`
  (IDM ketat), `extremePoi`, `decisionalPoi` (`strategy/inducement.ts`). **M9** umpan → POI di belakangnya (shadow paper, exit
  tanpa TP, wajib `cleanApproach`). Migrasi sekali `migr_lab_1123` (user: "yang bagus langsung jalanin"): `exit.tpMode` trail,
  `smc.breakerTpR` 0 (M4 ikut exit global), `m8TpR` 3, M0 + `baitTaken`, M4 `fvg+slLiqClear+cleanApproach`, M9 `cleanApproach`,
  `shadowModels` + M9. Pilihan kombinasi dari IS saja banyak yang gagal di OOS → yang dipakai hanya n besar + IS dan OOS positif.
  POI B M9 = **order block** (OB/QM, bukan RBS/SBR; koreksi user, migrasi `migr_m9_ob`). Lab: OB +0,17R (OOS −0,03), QM +0,32R, RBS +0,24R.
- **Lab 2026-11-24 (scratchpad, semua gagal setelah fee):** M11 reaksi impulsif (dibuang dari repo), M12 contrarian sweep level
  jelas + OI flush (−0,22 s/d −0,46R), M13 scalper limit di garis OB 4h/1d + SL wick candle abu-abu + TP 1m (−0,11 s/d −0,18R,
  +0,05R sebelum fee; round number di dalam zona OB sedikit lebih baik tapi tetap negatif), 7 metode institusi (round number
  Osler, value area, absorption, exhaustion, AVWAP, reversal harian: −0,05 s/d −0,11R), order book depth Binance (Kavajecz:
  imbalance / tembok / vakum, top 10 & 40 volume: korelasi ≤ 0,04, tidak konsisten). Data depth 40 koin (25 Mei–23 Nov, 5 menit)
  disimpan di `D:\cryptodb\bookdepth\*.npz` (±177 MB) + script di `_scripts/` (`pull.sh` → `proc.py` → `depth.py` → `an.py`).
- **Lab cocokologi + akademis (2026-11-24)**, funding 2 tahun di `D:\cryptodb\funding\zip` + script `_scripts/cal.py`: mati semua =
  fase bulan, hari/jam/sesi, turn of month, intraday momentum (Shen-Urquhart), drift jam funding, lead-lag BTC→alt 1m, carry funding,
  MAX/lottery, CME gap (+0,04–0,07R, lemah). **Kandidat:** (1) momentum cross-section mingguan (lookback 7 hari, decile, koin likuid
  ≥ 10 jt/hari, L/S +1,8 %/minggu, positif di semua hari rebalance/lookback/decile, 21/24 bulan) tapi sisi long = lotre (median −4 %,
  digendong beberapa pump), yang kokoh **short loser** (+2–4 %/minggu, menang 60 %, beda vs market −0,3 s/d −1,9 %/minggu di 4/4
  semester). Nov 2026 −30 %. (2) Short koin baru listing (hari ke-2/3, hold 14–30 hari, stop 50 %): +2,5–4,5 %/trade setelah fee +
  funding (funding −1 s/d −2 %/trade), 4/4 semester, tapi cuma 11–13/23 bulan positif. Belum dibuat jadi model.
- **TP M8 = max(3R, target liquidity B)** (2026-11-24, `smc.m8TpToTarget` default true, `m8Exit` → tpMode `liquidity`, `finalize`
  isi `tpLiquidity` M8 dari `drawTarget`). Lab 300 koin Jun–Nov: +0,24R → +0,30R (IS/OOS/holdout naik semua). TP 50 % di 3R + sisa
  ke target +0,26R, runner tanpa target lebih jelek. Replay 500 USDT / 1 % / 40 slot: +297R → +483R, DD −53 % → −39 %; di 10 slot
  TP 3R malah lebih bagus (selisih belum kokoh). Masalah utama = 40 posisi barengan (DD besar), bukan exit.
  **Replay 1 tahun** (lab DB terpisah `D:\cryptodb\lab_1y.db`, 1m 360 hari 300 koin, Jan–Nov 2026, 1R tetap, 40 slot): TP C +643R
  (10/11 bulan positif, avg +0,185R, DD maks −94R, 30 hari terburuk −60R), TP 3R +531R (9/11, DD −128R). Jan–Mei (di luar periode
  pemilihan aturan) C +345R, positif semua bulan.
- **M8 penyebab SL + setelan baru** (2026-11-27, config live via CDP, bukan migrasi): SL M8 kebanyakan karena BTC balik arah
  setelah fill (lab: BTC melawan > 3 %/24j → SL 93 %; live 33/39 SL di 25–26 Nov, short saat BTC naik), bukan TF/jenis POI.
  Replay 1 tahun 300 koin (R, tanpa batas margin): batas searah (`maxSameDirection`) memangkas untung lebih dari DD → tidak dipakai.
  Dipasang (user): M8 wajib + `liqInPoi` + `cisd` (40 slot +567R DD −100 vs +520R DD −146; per setup IS/OOS dua-duanya naik),
  `m8PoiTimeframes` 4h/1d (3h dibuang: 3h & 4h sering zona sama → rebutan slot; menang di ≤ 50 slot, kalah di 60),
  `risk.maxOpenPositions` 30. Catatan: replay modal 100 dengan 1R = 1 USDT bangkrut di Des 2025 (DD setahun 100–150R).
- **Golden ratio / OTE** (2026-11-27, permintaan user): tag `ote` = entry di `smc.oteLow`–`oteHigh` (0,618–0,786) kaki terakhir
  `oteLookback` 30 candle `oteTimeframe` 4h (`premium.ts legRetrace`: long = low terendah sebelum high tertinggi jendela → high).
  Lab M8 setelan sekarang: per trade +0,48R vs ±0,23R (IS & OOS naik), tapi sebagai tag wajib trade kepotong 60–70 % → hasil turun.
  Dipakai sebagai **risk lebih besar**: `bot.oteRiskMult` 1,5 × risk untuk model `bot.oteRiskModels` (default M8), lewat `riskPctFor`.
  Replay 30 slot 1R = 0,5: +255 → +285 USDT/thn, DD −39,5 → −41,1; 1 bulan terakhir +134,8 → +146,5 (1R = 1). Slot cadangan OTE tidak membantu.
- **OB sah saat close → dibalikin ke `move`** (2026-11-25, `smc.obConfirm`, `docs/smc-rules.md` Q6): sempat dibuat opsi `close` (OB
  fresh begitu candle OB close, low/high ekstrem dari `pivot` candle kiri), lalu **default balik ke `move`** (aturan lama) karena OB jadi
  muncul di sideways dan lab tidak lebih bagus. `close` tetap ada sebagai opsi config. Yang tetap dipakai: FVG OB baru dihitung setelah
  terbentuk (`fvgKnownAt`, `obFvgAt`, dulu sedikit look-ahead). Angka di bawah dengan aturan `close`:
  Lab 300 koin 6 bln (`lab12`): tanpa filter bot hasil per setup ≈ sama (setup M0 2,2×, M1/M9 +0,01–0,02R). Dengan filter bot
  (dipilih di aturan lama) M0 trailOF +0,22 → +0,01R (OOS +0,22 → −0,25), M9 +0,44 → +0,26R, M2a +0,28 → +0,14R, M4 sama (+0,31).
  OB + alasan (`lab13`, 200 koin, limit di garis OB saat pertama disentuh, SL ujung wick, TP 1–3R): semua −0,05 s/d −0,14R setelah
  fee, sebelum fee ≈ 0 (+0,01–0,02R). Origin sweep / tap POI HTF / dua-duanya tidak beda dari OB tanpa alasan; TF besar cuma lebih murah fee.
  POI bertingkat (`lab14`, 300 koin, OB 4h/1d + POI searah di TF turunan yang lahir di dalam candle OB: 4h → 2h|1h, 1d → 4h|2h):
  OB 4h semua −0,06R; pola user OB 2h + OCL Break 1h ≈ 0 (+0,004R TP 2R, IS/OOS/HO semua ≈ 0, 5/7 bln); OCL Break 2h + OCL Break 1h
  +0,06R (TP 3R +0,10, n 1,2 rb, 5/7). OB 1d bertingkat dua + searah BTC 4h & trend: +0,06R (TP 3R +0,10, n 745, 6/7, IS −0,03).
  Lebih baik dari OB kosongan tapi belum kokoh (banyak kombinasi dites).
  + resep M8 (`lab15`, SL story, TP max(3R, B), hold 30 hari): yang ngangkat = **BTC 4h + trend 1d searah** (OB 4h/1d
  +0,14–0,18R, n ±10 rb, 4–6/7 bln; tanpa itu −0,06 s/d −0,18R), OCL Break turunan cuma beda jelas di 1d (+0,18 vs +0,03).
  Resep M8 penuh: OB 1d + OCL Break turunan +1,03R tapi n 75 (5/7), OB 4h + OCL Break +0,15R (n 347, IS ≈ 0). Belum masuk bot.
  Ulang di DB 1 tahun (`y15_*`, Des–Nov): OB 4h/1d + BTC 4h + trend 1d +0,15–0,20R (n ±17 rb, 8–9/12 bln, Des–Mei juga +).
  Resep M8 penuh: OB 4h/1d + OCL Break turunan +0,22R (n 787, 7/12, Des–Mei +0,17) vs tanpa OCL Break +0,04R. 1d saja +0,70R
  (n 122/thn, menang 30 %, 5 trade terbesar = 50 dari 86R → ekor tebal).
- **M11 OB HTF + OCL Break turunan** (2026-11-25, `docs/entry-v2.md §30`, `modelM11` / `oclKidOf`, mesin M8 `htfPoiModel`):
  OB `smc.m11PoiTimeframes` (default 1d, pilihan user) + OCL Break searah di 4h/2h yang lahir di dalam candle OB, setting lain ikut M8.
  Wajib `liqTarget + dispStrong` (migrasi `migr_m11`), **tidak** di `bot.models` (user: backtest dulu). Mesin app 1 tahun 300 koin:
  +0,32R (n 875, 10/12 bln), tapi top 100 koin (universe bot) ≈ +0,05R dan sering bentrok dengan posisi M8 → tidak menambah di replay.
  Setelah OB balik ke `move` (`y16m`): 261 setup/thn +0,39R (7/12), filter bot 68 trade +1,44R (9/12, menang 32 %), top 100 koin
  −0,14R (n 91), top 100 + filter +0,61R tapi cuma 21 trade/thn.
- **OB "terjun dari atas + nyentuh POI"** (`lab17`, 2026-11-25, 300 koin 6 bln, 707 rb OB 15m/1h/4h, limit garis OB, SL wick):
  semua negatif setelah fee (15m −0,20, 1h −0,12, 4h −0,07R, 0/7 bln). Aturan user (wick terendah ≥ 20 candle + jatuh ≥ 3 ATR + tap
  POI HTF) 15m −0,16 / 1h −0,10 / 4h −0,09R; sebelum fee ≈ sama dengan OB sideways (+0,03 vs +0,02, 4h malah −0,03 vs +0,04). Perbaikan
  setelah fee cuma dari SL yang lebih lebar. Versi ketat (≥ 50 candle, ≥ 5 ATR) juga negatif.
- **Chart pattern** (`lab18`, 2026-11-25, DB 1 tahun 300 koin, 1,1 jt trade): deteksi otomatis dari zigzag pivot 3/5 di 1h/2h/4h/1d
  (H&S/IHS, double top/bottom, rectangle, triangle asc/desc/sym, wedge, flag), entry breakout (market) vs retest (limit di garis),
  SL balik swing terakhir, TP 2R/3R/measured move, fee. Tanpa filter semua ≈ 0 (−0,09 s/d +0,05R). **Arah buku tidak lebih bagus dari
  arah kebalikannya** (breakout +0,09 vs +0,09R kalau searah BTC 4h + trend 1d; ASC tembus bawah +0,22 vs tembus atas +0,05). Yang
  ngangkat cuma searah BTC 4h + trend 1d (+0,09–0,13R; melawan dua-duanya −0,11 s/d −0,14R), sama seperti OB/POI → pattern = pemicu
  entry biasa, tidak ada informasi sendiri. Belum dibuat model.
- **CRT / Candle Range Theory** (`lab19`, 2026-11-25, DB 1 tahun 300 koin, 3,8 jt trade): C1 range 1h/4h/1d, C2 sapu satu sisi dan
  close balik ke dalam → entry market setelah close C2 (`c2`), limit di level yang disapu selama C3 (`lim`), atau di dalam C2 begitu
  LTF close balik ke dalam (`intra`); TP sisi seberang C1 / tengah / 2R / 3R. **Semua negatif:** 1h −0,17 s/d −0,29R, 4h −0,09 s/d −0,17R,
  1d −0,06 s/d −0,09R (0–2/13 bln). Close C2 jauh dari sisi yang disapu / sweep dalam cuma mengurangi rugi (SL lebih lebar = fee kecil).
  Jam open candle 4h (sesi NY dll.) tidak ngaruh. Searah BTC 4h + trend 1d: terbaik 1d `c2` TP 2R +0,06R (6/13 bln), 4h ≈ −0,01R. **Weekly** (`lab19w`, C2 close di
  periode 1m 1 tahun, 4,1 rb event `c2`, SL median 15 % jadi fee kecil): tetap negatif −0,06 s/d −0,16R (`c2` sisi seberang −0,10R,
  nyampe 47 %, jarak median 0,96R), searah trend 1w malah lebih jelek (−0,18R). Tidak dibuat model.
- **OB versi LuxAlgo** (2026-11-25, `smc.obConfirm` `'lux'` + `obSwingLength` 10, `detectLuxOrderBlocks`, dari source ICT Concepts
  yang dikirim user): close tembus swing high 10 candle → candle dengan body bawah terendah sejak swing itu = bullish OB (warna/bentuk
  tidak dilihat), garis = body atas, SL tetap balik wick, breaker = body tembus kotak. Default tetap `move`. Lab20 (DB 1 tahun, 300 koin,
  OB 1h/2h/4h/1d, sentuhan pertama, limit di garis, resep lab15): OB lux ±45 % jumlah `move`, SL lebih lebar, menang 2R +1 poin.
  Searah BTC 4h + trend 1d: 2h +0,19R / 4h +0,21R (move +0,09 / +0,14). Resep M8 penuh: 4h lux +0,27R (n 2,7 rb, 9/12 bln, Des–Mei
  +0,13, top 100 +0,13) vs move +0,07R; 2h lux +0,19R vs −0,05R; 1d lux lebih jelek (+0,05 vs +0,40R, n kecil). Sebelum fee lux tetap
  lebih bagus ±0,02–0,04R (TP 2R). Belum dipakai model mana pun.
  **Replay** (`lab21`, mesin app, M8 dengan POI OB 2h/4h saja, top 100 koin, 40 slot): M8 saja +540R (DD −119R), M8 + OB lux +398R
  (OB lux −0,05R/trade, rebut slot M8), M8 + OB move +461R. 20 slot: 240 / 219 / 224R. OB lux saja +0,02–0,04R/trade → **tidak menambah**.
  **Per model** (`lab22`, top 100, 1 tahun): tanpa filter lux cuma mengurangi rugi (M0 −0,10 → −0,06R, M2a −0,17 → −0,12R, trailOF),
  M1/M4/M9 ≈ sama, M2b lebih jelek; dengan filter bot (dipilih di aturan move) lux lebih jelek di M0/M1/M4/M9. Liquidity LuxAlgo
  (`smc.m2Liquidity` `'lux'`, `detectLuxLiquidity`: ≥ 3 swing zigzag pivot 5/1 dalam ±ATR(10)/2,5) untuk M2a: r2 −0,23 → −0,09R tanpa
  filter, tetap negatif; dengan filter lebih jelek. M2b n kecil. Default tetap `move` + `swing`.
  **Pencarian konfluensi adil** (`l22conf.py`, prosedur sama untuk semua aturan: exit × filter POI TF × ≤ 3 tag wajib dipilih di
  Des–Mei, diuji Jun–Nov, top 100): kombinasi IS terbaik rata-rata gagal di OOS untuk dua aturan (hanya 22–58 % kombinasi IS+ juga OOS+).
  OOS pilihan terbaik: move M0 +0,23 / M2a +0,13 / M2b +0,88 (n 62) / M4 +0,12R; lux M0 −0,06 / M1 +0,23 (top-10 −0,20) / M2a −0,02 /
  M4 −0,04 / M9 −0,16R. Paling konsisten: M2b OB+liquidity lux (77 % IS+ → OOS+, n kecil) dan M4 move (58 %). Lux tidak lebih baik.
- **Risk per model** (2026-11-25, `bot.modelRiskPct`, `riskPctFor`): % risk khusus per model (user: buat M11 yang jarang), kosong =
  `riskPerTradePct`, patokan sama (`riskBaseUsdt`). Input di Settings → Bot entry, ringkasan di halaman Bot.
- **OPG 24–25 Nov** (M8 live RBS 4h, +2,9R, puncak 4,9R): OCL 1d biasa tempat RBS 4h mantul (0,1293) sudah disentuh 14/11 → bukan
  sentuhan pertama, jadi tidak tertangkap. OCL Break 1d 0,1364 (entry sama, TP B 0,1638) terdeteksi M8 tapi gugur karena tidak `dispStrong`.
  Lab 1 tahun M8 OCL Break 1d + liqTarget tanpa `dispStrong`: +0,35R (n 1.083, kedua paruh +), top 100 koin +0,30R (n 358, 6/12 bln).
- **Statistik sejak tanggal** (2026-11-18): `bot.statsSince` (ms, 0 = semua) memfilter statistik per model di halaman Bot
- **CISD / SMT / IFVG + konfluensi OR** (2026-11-23, `docs/entry-v2.md §24`, `strategy/confirm.ts`): tag `cisd` / `smt` (1h vs BTC,
  BTC vs ETH, `SetupInput.smtRef`) / `ifvg`. `bot.modelConfluenceAny` = list OR per model (minimal satu, di atas list wajib), migrasi
  `migr_or_1123`: M0 `bbMomentum/ifvg/smt`, M4 `anomaly/manipulation/smt`, M5 `btc4h/smt`, M8 `anomaly`, M9 `bbMomentum/liqHtfBehind`
  (M9 dipilih pakai OOS → optimistis). Lab script `allbt.ts`: model tanpa TP (`breakerTpR`/`m9TpR` 0) = rencana `trailOF`.
- **QM close-break + M10** (2026-11-23, `docs/entry-v2.md §25`): break L1 QM wajib close body (`smc.qmRequireCloseBreak`), M9 QM
  +0,26R → +0,42R. **M10** = POI HTF kena → QM 15m (head di POI) → limit di level QM. Lab lemah (best btc4h+slLiqClear +0,15R),
  tidak di bot.models. Tombol Refresh di halaman Bot (`bot:refresh`: equity tanpa cache, sinkron order/posisi).
- **TF 3m / 45m / 2h / 3h di DB** (2026-11-23, `docs/entry-v2.md §26`, migration `0008_candles_odd`): turunan seperti 5m/15m/1h/4h,
  diisi sekali dari data lama saat worker start (`deriveAddedTimeframes`). Lab: tidak lebih bagus dari TF standar, kecuali M8 (3h ≈ 4h).
  **10m** juga disimpan (dari 5m, migration yang sama). M10 = QM di 1m/3m/5m/10m (`smc.m10Timeframes`): rugi di lab. `TF_RANK` = `TF_MS`.
- **Cerita POI** (2026-11-23, `docs/smc-rules.md §12`, `strategy/story.ts`, panel di Chart, IPC `smc:stories`): lapis 1 anatomi
  (kenapa terbentuk, dorongan, fresh/umpan, konteks) + lapis 2 peta liquidity & draw A → B. Deterministik. Lapis 3 (probabilitas
  dari data): skor gabungan gagal OOS; tag `dispStrong` + `liqTarget` wajib M8 (+0,40 → +0,58R, `docs/entry-v2.md §27`). M8 juga POI 3h
  (`migr_m8_3h`). Job isi TF baru kasih jeda event loop per chunk (dulu worker macet 3–4 dtk/koin → REST timeout).
- **Lab 300 koin + konsep internet** (2026-11-23, `docs/entry-v2.md §28–29`, 200 koin baru sebagai holdout): exit di target B tidak
  lebih bagus; M8 tag lolos di koin baru, OR `anomaly` dilepas; tag baru `slPoolClear` (wajib M0), `pdPremium` + `dayOpenCheap`
  (wajib M9; ikut momentum range 4h + entry di bawah open harian). OTE / Judas / open mingguan / CVD tidak konsisten (CVD divergence
  malah jelek). Migrasi `migr_story300`.
  berdasarkan waktu trade dibuka. Ada baris Total + DD maks (`tradeStats` di `@shared/bot`). User testing pakai risk 6,5%
  (SL M5/M6 lebar tidak lolos min notional 5 USDT dengan modal ±17 USDT) dan rem harian `risk.maxDailyLossPct` 25%.
- **Rotasi momentum = PAPER SAJA** (`docs/entry-v2.md §11`, halaman Rotasi, `src/main/rotation/`). Long/short top 60 volume,
  lookback 75 hari, 8 per sisi, rebalance mingguan. Tidak pernah kirim order. Lab realistis: OOS −41% s/d +5% tergantung
  hari rebalance, DD 44–62%. Jangan dijadikan bot live tanpa forward test yang meyakinkan.

## Dashboard (2026-11-26, permintaan user)
- Halaman **Dashboard** = rekap trade **live saja** (bukan paper), langsung query DB lewat IPC `dashboard:get` (`BotRepo.dashboard`,
  handler di main, harga posisi = close 1m terakhir di DB). Logika murni di `@shared/dashboard` (test `dashboard.test.ts`), chart SVG di
  `components/DashCharts.tsx`. Tanpa export CSV (user: cukup di GUI).
- Filter: periode (hari ini / 7 / 30 hari / bulan ini / semua / rentang tanggal bebas, berdasarkan **waktu close**, hari UTC), model, arah.
  Isi: equity, PnL/R periode, W/BE/L + WR, DD, floating posisi buka (+ hasil kalau semua kena SL, margin, limit nunggu), PnL kumulatif,
  PnL harian/mingguan/bulanan, "paling efektif" (kelompok per model / POI / TF / jenis / arah / koin / alasan exit / hari / jam), daftar trade
  selesai, kesehatan bot (bot, kill switch, blokir entry, WS, sync, saldo, error, blacklist, warning terbaru).

## Screener (keputusan user)
- Halaman **Screener**: scan **semua simbol yang punya histori 1m** (lolos `isSymbolAllowed`), dari data
  tersimpan. Pakai `SmcService.context()` yang sama dengan chart/Claude, logika murni di
  `src/main/screener/screen.ts`, runner `ScreenerService` di **data worker** (yield per simbol).
- Kriteria per simbol+arah: setup OB valid aktif (pending/triggered), harga dekat POI aktif 1h/4h
  (≤ `nearPoiPct`, sisi yang benar), trend 4h/1h/15m searah, BOS 1h/4h ≤ `bosRecentHours`. Baris
  muncul kalau ada setup / dekat POI / BOS baru. Trend searah cuma flag/filter.
- Pemicu: tombol manual + otomatis 1 menit setelah tiap kelipatan `screener.scanEveryMin` menit (default **5**, user 2026-11-23: "per 3-5 menit"; dulu 15) + sekali 90 detik setelah start.
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
- **3m/5m/15m/45m/1h/2h/3h/4h di-resample dari 1m** dan disimpan sebagai tabel sendiri, dihitung bertingkat
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
pnpm data:backfill --all --flow  # isi taker buy volume + jumlah trade ke data lama (migration 0007)
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
