# Entry v2: rencana perombakan entry, backtest, dan bot

Status: **dikonfirmasi user (2026-11-14)**. 8B (mesin entry + exit) ✅, 8C (Backtest v2 + Meta + profil koin) ✅, 8D (bot) ✅, 8E (UX screener/chart/settings) belum. Keputusan user ada di bagian
"Keputusan" (paling bawah) dan mengalahkan isi draft di atasnya kalau bertentangan.

---

## 0. Diagnosis entry sekarang (kenapa WR 12–20%)

Data dari backtest sebelumnya (lihat CLAUDE.md → Backtest):
1. **Entry = "candle berbentuk OB muncul di dekat POI".** Sesudah POI kena, kode cuma mencari candle 15m
   berbentuk OB dalam 10 candle (`detectSetups`). Kode **tidak** mengecek apakah struktur LTF benar-benar berbalik,
   apakah ada sweep, atau apakah ada displacement. Akibatnya setup tetap muncul di POI yang sedang ditembus.
2. **SL kekecilan dibanding fee.** Median jarak SL 0,2–0,28%. Fee + slippage ±0,07% per trade, jadi ongkosnya
   **0,3–0,4R per trade**. Sebelum fee hasilnya kira-kira impas, setelah fee minus.
3. **TP selalu di liquidity berlawanan terdekat dengan minRR 2**, jadi RR rata-rata 4–5. Dengan RR segitu,
   WR 20% itu wajar dan sebenarnya hampir impas. **WR dan RR saling tukar**. WR 50–60% realistis kalau
   target ±1–1,5R (atau partial TP + BE), bukan 4R.
4. Skor setup tidak berkorelasi dengan hasil, jadi skornya belum berguna.

➡️ Yang dikejar di v2: **expectancy (avg R bersih) dan profit factor setelah fee**, dengan WR sebagai
informasi. Backtest v2 akan menampilkan WR untuk beberapa pilihan TP sekaligus, supaya kelihatan berapa WR
yang dibutuhkan di RR berapa.

---

## 1. Bahan dasar baru (fungsi murni, tidak repaint)

| Bahan | Definisi usulan |
|---|---|
| **Sweep** (liquidity diambil) | Wick menembus swing high/low (BSL/SSL) yang belum disapu, lalu candle yang sama **close kembali di dalam** (atau paling lambat `sweepReclaimCandles` = 2 candle berikutnya). Kalau close di luar dan bertahan = breakout, bukan sweep. |
| **CHoCH LTF** (flip struktur kecil) | Di TF entry, setelah sweep/POI kena: close menembus swing LTF terakhir yang berlawanan (long: close > swing high LTF terakhir). Ini sama dengan "BOS = pembalikan" versi materi, cuma dihitung di TF kecil dengan pivot lebih kecil (`ltfPivot` = 2). |
| **Displacement** | Leg yang menghasilkan CHoCH punya minimal satu candle dengan body ≥ `dispBodyAtr` × ATR(14) (default 1,2) **atau** meninggalkan FVG. |
| **POI kecil (anak)** | POI yang tercipta di TF entry oleh leg displacement itu, yaitu OB (bentuk + warna, §3), QM (§7), atau FVG. Yang dipakai adalah **OB paling ujung (asal leg)**, bukan OB pertama di dekat harga. |
| **Breaker** ❓ | OB yang ditembus close (invalid) setelah sweep lalu dipakai dari sisi sebaliknya. Konsep ICT, belum ada di materi. |
| **Trend BTC** | Hasil `analyzeStructure` BTCUSDT 4h dan 1h (`trendKnownAt`, tanpa look-ahead). |

Catatan istilah: **OB = Order Block (§3), bukan OCL Break.** Sekarang setup dengan POI OCL Break
ditampilkan sebagai "OCL_BREAK 1h → OB valid", dan label "OB valid" itu bikin kesannya OCL Break = OB. Di v2,
setiap setup menampilkan **POI induk** (mis. "OCL Break 1h") dan **POI anak** (mis. "OB 15m") secara terpisah.
Kode `OCL_BREAK` di UI akan ditulis "OCL Break".

---

## 2. Model entry (masing-masing bisa dinyalakan atau dimatikan, dan ditest terpisah)

Semua model menghasilkan `Setup` dengan field baru `model`, `parent` (POI induk), `child` (POI anak/entry),
dan `confluence[]`.

### M1. POI besar → POI kecil (refinement)
Ini yang lo maksud: "sentuh OB TF besar, tercipta QM di TF kecil, entry di QM itu".
1. POI induk aktif di 4h/1h (OB / RBS-SBR / QM / OCL Break / OCL HTF) kena.
2. Di TF entry, dalam `refineWindow` candle (default 16 × 15m = 4 jam) sejak kena:
   harga **tidak close tembus batas invalid induk**, lalu terjadi **CHoCH LTF searah POI** dengan displacement.
3. Entry = limit di POI anak yang tercipta oleh leg itu, dengan prioritas **QM LTF > OB LTF (dengan FVG) > OB LTF**.
4. SL = di luar ekstrem leg (titik terendah/tertinggi sejak POI kena) + buffer. Jadi SL di bawah titik
   reaksi di POI induk, bukan cuma di bawah wick satu candle.
5. Bedanya dengan sekarang: wajib ada **flip struktur LTF + displacement**, dan entry di POI asal leg.

### M2. Liquidity grab reversal (teknik lo)
"Di bawah SSL / di atas BSL ada OB. Market sapu liquidity, ambil OB-nya, baru terbang."
1. Ada swing low (SSL) yang belum disapu, dan **di bawahnya** dalam jarak ≤ `grabObDistPct` (default 1%)
   ada OB bullish aktif (HTF atau TF entry). Equal lows (§10) diberi nilai lebih.
2. Harga menyapu SSL dan menyentuh garis OB di bawahnya, lalu close kembali di atas garis OB.
3. Dua varian entry (dua-duanya dibacktest):
   - **M2a agresif:** limit di garis OB itu sendiri (dipasang begitu SSL tersapu). SL di luar wick OB.
   - **M2b konfirmasi:** tunggu CHoCH LTF setelah sweep, lalu entry di POI anak seperti M1.
4. Short = cerminan (BSL + OB bearish di atasnya).

### M3. Sweep → CHoCH → FVG (ICT "2022 model")
1. Sweep swing liquidity di TF entry atau HTF.
2. CHoCH LTF dengan displacement yang meninggalkan FVG.
3. Limit di FVG itu, pada edge dekat atau 50% (❓ default **50%**). SL di luar ekstrem sweep.
4. Ini **bertentangan dengan §4 materi** ("limit di OB, bukan di FVG"). Karena itu default-nya **mati**,
   cuma ada buat dibandingkan di backtest. ❓

### M4. Breaker / Unicorn ❓ (di luar materi)
OB yang dijebol setelah sweep jadi breaker. Entry saat retest breaker, terutama kalau overlap dengan FVG
("unicorn"). Diusulkan **diimplementasi sebagai model opsional** supaya backtest bisa menilai.

### Yang ditolak / tidak diusulkan
Killzone/sesi, fibonacci OTE: materi tidak memakai sesi, dan crypto jalan 24 jam. Bisa ditambah nanti
sebagai **filter** kalau lo mau dites. ❓ Premium/discount (entry long hanya di bawah 50% range HTF) diusulkan
jadi **filter opsional**, default mati.

---

## 3. Filter & konfluensi (berlaku untuk semua model)

| Filter | Default usulan |
|---|---|
| **Trend BTC** | Koin selain BTC: long hanya kalau trend BTC **1h dan 4h** bullish, short sebaliknya. Mode: `strict` (1h+4h) / `4h` / `off`. Untuk BTC sendiri dipakai trend 4h BTC. ❓ |
| Trend TF POI induk searah | flag + filter opsional (default mati, nanti backtest yang memutuskan) |
| **Jarak SL minimum** | SL ≥ `minSlPct` (default 0,35%) **atau** ≥ 0,5 × ATR(14) TF entry. Kalau lebih kecil, SL diperlebar ke angka itu, bukan setupnya dibuang. Tujuannya biar fee turun ke ≤ 0,2R. ❓ |
| News window | tetap seperti sekarang |
| FVG di leg | konfluensi (dicatat, tidak wajib) |

## 4. Exit (TP) — dibacktest berdampingan

| Mode | Isi |
|---|---|
| `fixedR` | TP di 1R / 1,5R / 2R / 3R (semuanya dihitung sekaligus di backtest) |
| `liquidity` | seperti sekarang: liquidity berlawanan terdekat, min RR |
| `partial` | 50% di 1R lalu SL ke BE + fee, sisanya ke liquidity |

Default bot = yang terbaik di backtest out-of-sample koin itu (lihat §5 profil), fallback `partial`. ❓

---

## 5. Backtest v2 + "POI meta" per koin

Masih **satu koin** (keputusan lama), tapi dalam satu run:
1. Semua model (M1–M4) × semua jenis POI induk × TF induk × arah × mode TP dihitung **sekali**. Hasil per trade
   dikirim ke UI, lalu **filter berjalan di UI tanpa run ulang** (checkbox model, POI, TF, arah, filter BTC,
   FVG, sweep, mode TP).
2. **Tabel "Meta"**: kombinasi (model × POI induk × TF) diurutkan berdasarkan **avg R bersih out-of-sample**,
   dengan syarat minimal `minTrades` (default 20) trade di in-sample **dan** positif juga di in-sample.
   Kolom: trade, WR, avg R, PF, max DD, untuk IS / OOS. Kombinasi yang cuma bagus di salah satu periode diberi
   tanda ⚠️ (kemungkinan overfit).
3. **Simpan sebagai profil koin**: tombol "Pakai kombinasi ini untuk {koin}" menyimpan setting `profiles[SYMBOL]`
   = model + POI + TF + mode TP yang diizinkan. Bot dan screener memakai profil itu kalau ada. Kalau tidak ada,
   dipakai default global. ❓
4. Tetap ada: reaksi POI (B), simulasi equity, IS/OOS.
5. Data **1m** dipakai untuk menentukan urutan SL/TP di candle yang sama (sekarang konservatif = rugi).
   Hasilnya jadi lebih jujur, tapi run lebih lama (±3–5 dtk per koin). ❓

## 6. UX (dari keluhan "muter-muter")

- **Backtest:** pilih koin langsung di halaman (combobox + koin terakhir), tidak perlu lewat Chart. Ada preset
  ("Default", "Konservatif", "Semua model"). Hasil dibagi ke tab: Ringkasan · Meta · Trade · Reaksi POI.
  Klik baris trade akan membuka Chart di waktu itu dengan setup, POI induk, dan anak tergambar.
- **Chart:** label setup jadi "M1 · OB 4h → QM 15m · 1,5R". Ada tombol "Backtest koin ini".
- **Screener:** kolom model + status trend BTC di header, filter per model, klik untuk ke chart.
- **Bot:** status tiap gate (setup / akun / BTC / Claude) kelihatan per kandidat, plus saklar "Butuh Claude".

## 7. Bot

- `bot.requireClaude` (default **false** sesuai permintaan lo). Kalau mati, gate Claude dilewati dan entry
  murni dari model + filter. `minConfidence` cuma dipakai kalau saklarnya nyala.
- `bot.models` = model yang boleh dieksekusi (default M1 + M2b), dibatasi juga oleh profil koin kalau ada.
- Filter trend BTC dan min SL berlaku di gate.
- Exit `partial` butuh order tambahan di live: TP1 reduce-only 50%, lalu setelah fill SL dipindah ke BE (cancel
  + pasang ulang algo order). Ini ditambah ke `LiveBroker` dan `PaperBroker`.

---

## 8. Urutan kerja (per fase, berhenti tiap fase)

| Fase | Isi | Selesai kalau |
|---|---|---|
| **8A** | Konfirmasi dokumen ini → update `smc-rules.md` §11–§14 | lo bilang go |
| **8B** | Bahan dasar (sweep, CHoCH LTF, displacement, ATR, breaker, trend BTC) + model M1–M4 + unit test | test lulus |
| **8C** | Backtest v2: multi-model, mode TP, resolusi 1m, meta, profil koin, filter di UI | lo jalankan di PC & cek angka |
| **8D** | Screener + bot: model, filter BTC, tanpa Claude, partial TP | paper jalan di PC lo |
| **8E** | UX: backtest, chart, screener, bot | — |

Angka WR 50–60% **tidak bisa gua janjikan**. Yang bisa gua janjikan: backtest yang jujur (fee, 1m, IS/OOS)
yang menunjukkan model + POI + TP mana yang benar-benar punya edge di tiap koin. Lo yang menjalankan backtest
di PC karena DB-nya ada di sana.

## ❓ Pertanyaan
1. **Target:** setuju yang dioptimasi itu avg R bersih / PF, dan WR 50–60% dicapai lewat TP lebih dekat
   (1–1,5R / partial)?
2. **Konsep baru di luar materi**, mana yang boleh: sweep ✅ (lo sendiri), CHoCH LTF ✅ (lo sendiri: "tercipta QM
   di TF kecil"), displacement, breaker/unicorn (M4), FVG entry (M3, lawan materi §4), premium/discount filter?
3. **Trend BTC:** pakai struktur (HH/HL, BOS materi) di 1h + 4h? Mode strict (dua-duanya searah) atau 4h saja?
   Dipakai sebagai filter wajib atau cuma skor?
4. **Min SL 0,35% / 0,5 ATR**, SL diperlebar (bukan setupnya di-skip): oke?
5. **Profil koin dari backtest** otomatis dipakai bot, atau cuma info dan lo yang klik "pakai"?
6. **Resolusi 1m** untuk SL/TP di candle yang sama, walaupun backtest jadi ±2–3× lebih lambat?
7. **Label OCL Break dibilang OB**: lo lihat di halaman mana? Gua tebak di label setup ("→ OB valid") dan
   kolom "setup OB valid" di Screener. Kalau ada tempat lain, kasih tahu.
8. Di sesi ini **boleh jalanin `pnpm test` dan `pnpm typecheck`?** Dua-duanya tidak menyentuh DB dan bukan
   dev/build. Kalau tidak boleh, gua cuma nulis kode + test dan lo yang jalankan.


---

## ✅ Keputusan user (2026-11-14)
1. **Tidak ada entry di FVG.** M3 dibuang. FVG cuma informasi tambahan (konfluensi/skor/filter), karena SL-nya
   kelebaran.
2. **Entry hanya di OB (Order Block), QM, atau breaker.** OB ≠ OCL Break. **OCL / OCL Break tidak pernah jadi
   titik entry.** OCL cuma boleh jadi alasan (POI induk), dan harus dari HTF (`oclParentTimeframes` 4h/1d/1w).
3. **Setiap POI harus dilihat asal-usulnya**: terbentuk karena **liquidity sweep** atau karena **nyentuh POI TF
   lebih besar** (`Poi.origin`). POI induk tanpa asal-usul tidak dipakai (`parentNeedsOrigin`). POI anak di M1/M2b
   otomatis punya asal (POI induk kena, plus sweep kalau ada). OB di M2a wajib punya asal sendiri.
4. Semua konsep di luar materi boleh dipakai (kecuali entry di FVG), termasuk breaker/unicorn, displacement,
   CHoCH LTF. POI baru hasil riset juga boleh (kandidat: mitigation block, rejection block), tapi harus dinilai
   lewat backtest dulu.
5. **Trend BTC 4h/1h dan Wyckoff (akumulasi / distribusi / manipulation = spring/UTAD) cuma nambah skor**, bukan
   syarat.
6. **Lebar SL ikut setup.** Size diatur dari `bot.riskPerTradePct`. Tidak ada SL minimum yang dipaksakan.
7. **Trailing bertingkat** (`exit`): 1R → SL ke BE (termasuk fee), 3R → TP sebagian (default 50%) + SL ke 1R,
   lalu trailing (best − 2R tiap 1R baru).
8. **Order flow untuk menahan posisi** (bagian dari trailing): setelah entry, reaksi brutal yang meninggalkan
   FVG lalu FVG itu diretest dan mantul, **atau** wick reaktif yang menolak area entry → posisi ditahan sampai TP
   / close manual. Ladder tidak mengambil partial, trailing berhenti, SL ke ujung retest/wick. Langkah BE tetap
   berlaku. Close yang menembus FVG berarti order flow patah dan trailing bertingkat jalan lagi.
9. Bot bisa entry **tanpa Claude** (`bot.requireClaude`, default mati), murni dari analisa ICT.
10. `pnpm test` / `pnpm typecheck` boleh dijalankan. **dev/build tidak.** Data uji = BTC/ETH/SOL dari
    data.binance.vision (disimpan di luar DB user).

## 9. Strategi di luar SMC (2026-11-14, permintaan user "ada strategi lain yang efektif?")
Lab: BTC/ETH/SOL 2 tahun, out-of-sample = 240 hari terakhir, fee + slippage, fill/exit di 1m.

| Kandidat | Hasil | Status |
|---|---|---|
| 1. SMC naik TF (entry 1h, POI 4h/1d) | M4 + FVG + trend, TP 1R: 181 trade, WR 56%, +0,06R (OOS +0,10R). M1 lebih jelek dari 15m | Bisa lewat config `smc.entryTimeframe: '1h'` (global) |
| 2. Killzone London/NY | Tidak ada edge (M1 di killzone −0,07R vs +0,03R di luar) | Konfluensi/filter `killzone` (`smc.killzonesUtc`, default 07–10 & 12–15 UTC), tanpa skor |
| 3. Funding rate + open interest | Belum: butuh downloader data baru (data.binance.vision `fundingRate` / `metrics`) | Belum dikerjakan |
| 4. Trend following 4h (Donchian) | Benchmark lab: +0,15–0,32R per trade, positif di IS dan OOS di hampir semua varian N20 + EMA200 | **M5** di app |
| 5. Rotasi momentum antar koin | Butuh model portofolio (beda arsitektur dari bot per setup) | Belum dikerjakan |

### M5 — trend breakout 4h (`setups.ts modelM5`)
- Close `smc.trendTimeframe` (4h) di atas high / di bawah low `trendChannel` (20) candle sebelumnya, di sisi EMA
  `trendEma` (200) yang benar, dan close sebelumnya masih di dalam channel (`trendFreshOnly`).
- Limit di harga close itu (± `trendEntryOffsetAtr` × ATR), SL `trendAtrMult` (3) × ATR = 1R, expiry
  `trendExpiryCandles` (16 × 15m). Close tembus SL sebelum fill = invalid.
- Exit **khusus** (`trendExit()`): tanpa BE, tanpa partial, tanpa TP. Tiap 0,25R best baru, SL = best − 1R. Bot pakai
  exit ini untuk M5 kecuali koin punya profil. Backtest punya plan `trend`.
- Konfluensi wajib bot / filter "Wajib ada" Backtest **tidak berlaku** untuk M5 (itu konsep SMC).
- Lewat kode app (tanpa aturan 1 posisi per koin): 627 trade, WR 46%, +0,08R (IS +0,08, OOS +0,10).
- Risiko: periode OOS kebetulan trend kuat, cuma 3 koin. Tes ulang di Backtest app untuk banyak koin sebelum live.
- Di live, kalau harga sudah balik ke bawah harga close breakout (long) saat bot lihat setup, bot melewatinya
  (limit post-only tidak bisa dipasang di atas harga).

## 10. Order flow futures: open interest + funding (2026-11-14)
Lab (BTC/ETH/SOL, 2 tahun, data.binance.vision `metrics` + `fundingRate`), lewat kode app (`flowreal`):

| Tag | Model | Ada tag | Tanpa tag |
|---|---|---|---|
| `oiConfirm` (OI 24 jam naik + harga 24 jam searah trade) | M5 trend | 363 trade, **+0,20R** (IS +0,19, OOS +0,20) | −0,07R (IS −0,06, OOS −0,08) |
| `oiFlush` (OI turun ≥ 1% dalam 4 jam) | M1 | 35 trade, **+0,33R** (IS +0,26, OOS +0,50) | −0,09R |
| `fundingContra` (funding di persentil ≤ 20% untuk long / ≥ 80% untuk short, ±90 settlement) | M5 / M1 | +0,24R / +0,11R | +0,06R / −0,03R |
| semua tag | M4 | tidak membantu (fundingContra malah −0,12R) | |

Studi event: funding tinggi justru diikuti harga lanjut naik (momentum, bukan sinyal kontra). Harga turun + OI turun
(flush) diikuti pantulan +0,65% dalam 72 jam. Ini **filter**, bukan strategi yang berdiri sendiri.

- `strategy/flow.ts` (murni): `flowAt` / `flowConfluence`. Hanya snapshot ≤ waktu setup diketahui (tanpa look-ahead).
  Data hilang = tanpa tag. Tag tidak menambah skor.
- Bot: `bot.requireConfluence` untuk M0–M4 dan `bot.trendRequireConfluence` (default `oiConfirm`) untuk M5. Profil koin
  menyimpan satu daftar (diisi dari filter model itu).
- **Penyimpanan (keputusan user: jangan simpan terus-terusan):** tabel `flow_oi` (snapshot 1 jam, **3 hari**) dan
  `flow_funding` (**35 hari**, ±90 settlement untuk persentil). `FlowSync` di data worker tiap jam :00:40, satu request
  OI + satu funding per simbol (limit Binance 1000 / 500 per 5 menit). Migration `drizzle/0006_flow.sql`.
- **Backtest** tidak memakai DB: worker download `metrics` harian + `fundingRate` bulanan dari data.binance.vision saat
  run (`flow/visionFlow.ts`, ±200 file kecil), ditambah REST untuk hari yang belum terbit. Tidak disimpan.
- Catatan: file `metrics` yang lebih baru urutan barisnya acak, jadi parser selalu mengurutkan.

### 10b. OI per 5 menit (permintaan user)
- OI sekarang snapshot **5 menit** (`openInterestHist period=5m`, `metrics` utuh). Tetap disimpan **3 hari**
  (±864 baris per koin). `FlowSync` jalan tiap 15 menit di :00:40 / :15:40 / :30:40 / :45:40, tepat sebelum scan
  screener. Satu request OI per koin per run. Funding diambil sekali per jam.
- Tag baru `oiHold`: OI 15 menit terakhir tidak turun lebih dari `smc.flowOiFadePct` (0,3%). Lab: M5 dengan OI turun
  saat breakout (short covering) −0,33R di IS dan OOS (113 trade).
- Lewat kode app, data 5 menit:

| | trade | WR | avg R | PF | IS | OOS |
|---|---|---|---|---|---|---|
| M5 + `oiConfirm` + `oiHold` | 319 | 49% | **+0,26** | 1,50 | +0,27 | +0,24 |
| M5 sisanya | 308 | 42% | −0,10 | 0,83 | −0,10 | −0,09 |
| M1 + `oiFlush` (5m) | 42 | 57% | +0,10 | | +0,14 | +0,01 |

  `oiFlush` di M1 melemah dengan data 5 menit (tadinya +0,33R di data per jam, sampel 35 trade), jadi tidak dijadikan
  default. Default `bot.trendRequireConfluence` = `oiConfirm + oiHold`.

## 11. Rotasi momentum antar koin, PAPER SAJA (2026-11-14)
Lab: candle 1d semua perpetual USDT-M, termasuk yang sudah delisting (778 koin), Sep 2024 – Okt 2026. Universe adil:
top 60 berdasarkan volume 30 hari *saat itu*, umur ≥ 60 hari. Fee 0,07% per sisi + funding. OOS = 240 hari terakhir.
- Versi pertama memakai daftar koin berdasarkan volume hari ini → survivorship bias (+1000%). **Hasil itu salah.**
- Long saja: rugi atau tidak konsisten (drawdown 60–97%).
- Long/short lookback 60–75 hari: in-sample selalu bagus, tapi OOS bergantung pada hari rebalance (L60 N5: Selasa +79%,
  Jumat −31%). Stop per posisi memperburuk hasil.
- Mesin paper app (`rotation/paper.ts`) memegang unit tetap sepanjang minggu (realistis). Lab menyamakan bobot setiap hari.
  Hasil mesin app, default L75 N8 top 60: Senin +209% / OOS −15%, Selasa +336% / OOS +5%, Jumat +230% / OOS −41%.
  Max drawdown 44–62%.

**Keputusan user:** halaman **Rotasi (paper)** saja, tanpa order.
- `RotationService` di data worker berjalan tiap 15 menit. Begitu close 1d baru tersimpan, posisi ditandai ke close itu
  dan funding dicatat (dari `flow_funding`). Rebalance tiap `rebalanceWeekday` 00:30 UTC dari close kemarin; kalau close
  kemarin belum tersimpan, rebalance menunggu tick berikutnya.
- Universe = crypto perpetual (`isCryptoPerp` dari exchangeInfo) yang punya candle 1d di DB. Ranking point-in-time
  (`rankUniverse`).
- State di setting `rotation_state`. IPC `rotation:get` / `rotation:command` (start/stop/reset/refresh), event
  `rotation:state`. Parameter dikunci selama forward test berjalan.

## 12. Radar pump + notifikasi Discord (2026-11-15)

**Event study** (346 koin futures yang pernah masuk top volume, candle 1h 2 tahun, OOS 8 bulan terakhir).
Target: gerak ≥ 20% dalam 24 jam. Peluang dasar 4,3% per jam per koin.

| Kondisi saat jam close | Lift IS / OOS | Catatan |
|---|---|---|
| Volume 24j ≥ 3× median 30 hari | 3,6× / 4,3× | pump 2–2,5× lebih sering dari dump |
| Funding ≤ −0,02% + volume ≥ 2× | 3,6× / 4,6× | ±3× lebih sering pump (short squeeze) |
| Funding ≤ −0,05% | 2,8× / 3,6× | |
| Kompresi range (range 24j ≤ 0,55× median) | 0,5× / 0,5× | koin sepi justru jarang meledak |
| Koin paling likuid (top 10%) | 0,8× / 0,3× | |

Pump tidak bisa dideteksi saat koin masih sepi. Yang terbaca adalah jam-jam awal setelah gerakan mulai.

**M6 otomatis (ditolak):** radar → tembus box 24 jam → SL 3× ATR → trailing, fee + slippage micin (entry 0,1%, SL 0,3%).
Long-only trailing lebar: IS +0,15R, OOS −0,11R. Funding + volume: IS +0,12R, OOS −0,03R. Tanpa 5 trade terbaik semua
negatif (ada trade +275R yang menopang). Flip setelah tembus palsu tidak menambah hasil. Tanpa slippage hasilnya cuma ±0.

**Ambang default** (frekuensi dihitung dengan jeda 24 jam per koin):

| Ambang | Lift IS / OOS | Notifikasi/hari (IS / OOS) |
|---|---|---|
| vol ≥ 3× atau funding ≤ −0,02% + vol ≥ 2× | 3,5× / 4,2× | 27 / 42 |
| vol ≥ 5× | 4,8× / 5,8× | 14 / 24 |
| **vol ≥ 8× atau funding ≤ −0,05% + vol ≥ 3× (default)** | **5,3× / 6,8×** | **12 / 18** |
| funding ≤ −0,05% + vol ≥ 3× saja | 4,6× / 5,5× | 6 / 7 |

**Keputusan user:** radar jadi **notifikasi saja** (Discord + desktop), TP manual. Bot tidak pernah entry dari radar.
- `src/main/radar/radar.ts` (`radarCheck`, murni) + `radarService.ts` (data worker, cron :02:30/:17:30/…, cuma candle 1h
  terakhir yang baru close, jeda `radar.cooldownHours` per koin, state di setting `radar_state`).
- Notifier `src/main/notify/` di main (secret `discord.webhookUrl`, antrian ±1 dtk, 429 → retry sekali). Event bot level
  `order`/`warn`/`error` diteruskan (`notify.botOrders` / `notify.botWarnings`), setup screener opsional (`notify.screener`).
- Rencana berikutnya: tag `anomaly` buat SMC (dicek di Backtest dulu), lalu bot jaga SL posisi manual M6 (butuh izin).

## 13. M6 bot (TP manual) + tag `anomaly` (2026-11-15)

**Keputusan user:** M6 tetap di-entry bot (risk ikut `bot.riskPerTradePct`, mode ikut bot), **long saja**, entry setelah
close 1h tembus box 24 jam (maks `m6WatchHours` = 72 jam setelah radar). SL 3× ATR(24) 1h, **tanpa TP**: user ambil
profit sendiri (tombol close di halaman Bot atau langsung di Binance), bot cuma trailing SL (best − `m6TrailGapR` 2R).
Tidak ada konfluensi wajib untuk M6. `bot.models` dapat M6 sekali lewat migrasi (`migr_bot_m6`).

**Lab kode app** (20 altcoin yang paling sering anomali, 2 tahun, fill di candle 15m, slippage 0,05%):

| Model / grup | IS avgR | OOS avgR | n |
|---|---|---|---|
| M6, plan m6 (tanpa TP) | +0,03 | **−0,21** | 138 / 37 |
| M5 koin normal | +0,01 | −0,13 | 3.688 |
| M5 koin anomali (vol ≥ 3×) | +0,21 s/d +0,37 | **+0,24 s/d +0,30** | 391 |
| M4 normal / anomali | +0,13 / +0,23–0,33 | +0,02 / +0,23 | |
| M1 bertingkat normal / vol 3–8× | −0,07 / +0,24 | −0,07 / +0,19 | |

M6 otomatis tetap negatif di OOS (sampel kecil). Hasilnya bergantung pada TP manual user.
Temuan utama: **setup di koin yang lagi "bangun" (volume ≥ 3×) lebih bagus, bukan lebih jelek**. Tag `anomaly`
(`smc.anomalyVolMult`, default 3) bisa diwajibkan per model di Settings/Backtest/profil koin. Default bot belum diubah.
Catatan: koin dipilih karena sering anomali (bias seleksi), dan M5 di lab ini tanpa filter OI.

## 14. Premium/discount, Bollinger, blacklist SL (permintaan user, 2026-11-16)
- Tag `pdZone`: entry di sisi yang benar dari dealing range HTF (`smc.pdTimeframe` 4h, high/low `pdLookback` 60 candle
  yang sudah close ≈ 10 hari). Long cuma kalau harga entry ≤ `pdLevel` (0,5 = equilibrium) = discount, short ≥ 0,5 = premium.
  Default **wajib** untuk model SMC (`bot.requireConfluence`, config lama ditambah sekali lewat `migr_bot_pdzone`).
  Tidak berlaku untuk M5/M6 (breakout memang selalu di premium). Profil koin dari Backtest punya daftar wajib sendiri.
- Tag `bbMomentum`: Bollinger (`bbTimeframe` 1h, 20, 2σ). Close di sisi band tengah searah trade, band tengah miring
  searah dalam `bbSlopeCandles` (3) candle, dan band melebar (lebar > 3 candle lalu). Filter saja, belum wajib, belum diuji di lab.
- Blacklist SL: koin dengan ≥ `bot.slBlacklistCount` (3) trade rugi (BE tidak dihitung) dalam `bot.slBlacklistHours` (168 jam)
  tidak dientry lagi sampai SL ke-N terbaru keluar dari jendela. Per mode (paper/live). Daftar tampil di halaman Bot.
- SBR/RBS dicek ulang: break = **close** (body) lewat level body swing; wick saja tidak dihitung (test di `detectors.test.ts`).

## 15. BTC dominance `btcDom` (permintaan user, 2026-11-17)
- Sumber: kontrak index Binance `BTCDOMUSDT`, diambil langsung dari REST klines publik (`src/main/flow/btcDom.ts`).
  **Tidak disimpan** di DB, tetap ada di `data.excludeSymbols`, jadi tidak di-backfill, di-screen, atau ditrade.
- Live: `btcDomFeed` per proses (data worker + main), 1000 candle `smc.btcDomTimeframe` (default 4h). Fetch ulang baru
  dilakukan setelah ada candle baru yang close (dicek tiap 20 detik di worker). Kalau fetch gagal, data lama tetap dipakai.
  Backtest: worker download rentang data koin + 300 candle warm-up.
- Tag `btcDom` (filter, tanpa skor): trend struktur BTCDOM (BOS/CHoCH, `trendKnownAt`, tanpa look-ahead) **turun** →
  long altcoin oke, **naik** → short altcoin oke. Untuk `BTCUSDT` sendiri dibalik (BTCDOM naik → long BTC).
- USDT.D sengaja **tidak** dibuat. Menurut user arahnya selalu 1:−1 dengan BTC, jadi sudah diwakili `btc4h` (bisa dijadikan
  konfluensi wajib). Histori total market cap gratis juga tidak tersedia (CoinGecko global chart berbayar).
- Belum diuji di lab.

## 16. M0: liquidity POI, liquidity di belakang SL, OCL Break (permintaan user, 2026-11-18)
- `poiLiq` (tafsiran A, sesuai materi "wick panjang = liquidity nyisa"): dari POI kena sampai OB valid terkonfirmasi,
  tidak ada candle entry-TF yang tembus ekstrem POI (wick OB / ekstrem candle origin). **M0 wajib `poiLiq`** (`smc.m0RequirePoiLiq`).
- `slLiqClear` (tafsiran B, ICT): tidak ada swing high/low yang belum disapu dalam `smc.slLiqZoneR` (1R) di belakang SL.
  Tag filter untuk semua model, tidak wajib.
- OCL Break bukan POI M0 lagi, kecuali TF di `smc.m0OclBreakTimeframes` (default `1w`, yang tidak dianalisis untuk setup,
  jadi praktis cuma pantauan di chart).
- Lab 40 koin top volume × 6 bulan, M0 saja, fill/exit 1m, fee, exit bertingkat + order flow (`ladderOF`):
  | Filter | n | avg R | IS | OOS |
  |---|---|---|---|---|
  | semua M0 | 7881 | −0,10 | −0,07 | −0,17 |
  | tanpa OCL Break | 6084 | −0,12 | −0,10 | −0,17 |
  | OCL Break saja | 1797 | −0,06 | +0,02 | −0,20 |
  | `poiLiq` | 5157 | −0,10 | −0,09 | −0,13 |
  | tanpa `poiLiq` | 927 | −0,21 | −0,14 | −0,34 |
  | `slLiqClear` / tanpa | 3114 / 2970 | −0,10 / −0,14 | | |
  | `btc4h` + `poiLiq` + `slLiqClear` | 1366 | −0,07 | −0,07 | −0,05 |
  | sama, minSlAtr 1,5 | 700 | −0,03 | −0,02 | −0,06 |
  | `pdZone` | 3236 | −0,19 | −0,15 | −0,27 |
- Kesimpulan: `poiLiq` konsisten membantu (IS & OOS). `slLiqClear` dan SL lebih lebar sedikit membantu. Membuang OCL Break
  **tidak** membantu di lab (dibuang atas keputusan user). `pdZone` justru memperburuk M0. **Tidak ada kombinasi M0 yang
  positif** di IS dan OOS.

- **Update 2026-11-20 (user, kasus ZAMA "OCL 1d → OB 15m"):** OCL biasa (belum break) **tidak** jadi POI lagi untuk semua model
  termasuk M0 (`smc.oclParentTimeframes` = [], masih digambar di chart). Penggantinya OCL Break HTF: `smc.m0OclBreakTimeframes`
  = 4h/1d/1w (bot tetap dibatasi `bot.poiTimeframes`). Dimigrasi sekali di `AppState` (`migr_ocl_break_htf`).

## 17. TF POI induk + poiStack (2026-11-18)

User: POI 15m terlalu noise, mau POI yang ada di berbagai TF.

- `bot.poiTimeframes` (POI induk yang boleh dipakai bot) sekarang berlaku untuk **M0, M1, M2a, M2b**. Dulu cuma M1/M2b, jadi
  M2a banyak memakai POI 15m. M4 (breaker), M5, dan M6 tidak dibatasi. `smc.poiTimeframes` ditambah `1d` (tanpa itu M1/M2
  tidak pernah membuat setup dari POI 1d).
- Tag `poiStack` (filter, tanpa skor): POI induk berjarak ≤ `smc.poiStackPct` (default 0,3%) dari POI aktif searah di TF lain
  (≥ 1h, bukan OCL Break) saat POI kena. `stackedTfs()` di `setups.ts`.

Lab 40 koin top volume × 6 bulan, fill 1m + fee, exit ladderOF (avg R):

| Grup | n | avg R | IS | OOS |
|---|---|---|---|---|
| Semua (M0/M1/M2a/M2b) | 10.472 | −0,105 | −0,110 | −0,093 |
| POI 15m | 6.297 | −0,120 | −0,125 | −0,109 |
| POI 1h | 2.982 | −0,135 | −0,125 | −0,157 |
| POI 4h | 914 | −0,028 | −0,073 | +0,066 |
| POI 1d | 279 | **+0,312** | +0,257 | +0,414 |
| poiStack | 3.847 | −0,147 | −0,161 | −0,120 |
| tanpa poiStack | 6.625 | −0,080 | −0,081 | −0,078 |
| M0 POI 4h+1d | 693 | +0,118 | +0,078 | +0,201 |
| M0 POI 4h+1d + btc4h | 378 | +0,108 | +0,105 | +0,116 |
| M1 POI 4h+1d | 410 | −0,084 | −0,099 | −0,052 |
| M2a POI 4h | 83 | +0,153 | −0,165 | +0,529 |

Kesimpulan: TF POI induk adalah filter terkuat sejauh ini (1d > 4h >> 1h ≈ 15m). POI yang bertumpuk dengan POI TF lain justru
lebih jelek (level yang jelas = liquidity yang disapu), jadi `poiStack` tidak dijadikan syarat. M0 dengan POI 4h/1d jadi
kombinasi SMC pertama yang positif di IS dan OOS. M1 tetap negatif.


## 18. Konfluensi wajib per model (lab + permintaan user, 2026-11-19)

Lab: Backtest v2 (kode app) di 60 koin top volume 30 hari, data 12 Mei – 19 Nov 2026 (6 bulan, OOS = 60 hari terakhir),
plus OI/funding dan BTCDOM. Exit sama dengan bot: SMC pakai bertingkat + order flow + TP liquidity, M4 TP 1R, M5/M6 trailing.
POI M0–M2b 4h/1d. R bersih fee. Semua kombinasi 1–3 tag diuji (±2000). Yang diambil hanya yang positif di IS **dan** OOS,
n ≥ 100, dan tersebar di banyak koin.

| Model | Tanpa syarat | Rekomendasi | Hasil (IS / OOS) |
|---|---|---|---|
| M0 | +0,16R (n 1002) | `prevOpposite` + `slLiqClear` | +0,23R (+0,18 / +0,31), +`btcDom` → +0,30R (+0,28 / +0,34) |
| M1 | −0,07R | — | tidak ada kombinasi yang berarti, matikan |
| M2a | +0,09R (IS −0,20) | `trendParent` (n 39) | `pdZone` justru merusak |
| M2b | n 9 | — | data kurang |
| M4 | +0,01R | `fvg` + `btc1h` + `slLiqClear` | +0,27R (+0,24 / +0,32), 56 koin |
| M5 | +0,05R | `btc1h` + `anomaly` | +0,23R (+0,24 / +0,22). `oiConfirm` + `oiHold` (default lama) rusak: OOS −0,23R |
| M6 | +0,23R (OOS −0,01) | — | n kecil |

Tiap model menempelkan tag yang berbeda: M0 tidak pernah punya `fvg`, M4 tidak pernah punya `prevOpposite`. Karena itu satu
list SMC untuk semua model tidak bisa dipakai. Hasilnya `bot.modelConfluence` (list wajib per model) menggantikan
`requireConfluence` dan `trendRequireConfluence`. Config lama dimigrasi sekali (`migr_bot_model_conf`): list SMC lama disalin ke
M0–M4 dan list M5 ke M5, jadi perilaku bot tidak berubah. Tombol **Isi rekomendasi lab** di Settings → Bot mengisi
`RECOMMENDED_MODEL_CONFLUENCE`. Catatan: M0/M5 bergantung pada beberapa trade trailing besar. Tanpa 5% trade terbaik, M0
rekomendasi ≈ +0,03R dan M5 ≈ +0,02R. WR ±40%.

**Lab 300 koin (2026-11-19, sama periode).** Rekomendasi M0 tetap bagus di top 100 (+0,26R vs +0,19R tanpa syarat) tapi di
peringkat 100–300 sama saja dengan tanpa syarat (+0,14R). M4 `fvg+btc1h+slLiqClear` +0,17R di kedua kelompok, tapi
`fvg+oiConfirm+slLiqClear` lebih kuat: +0,27R (IS +0,27 / OOS +0,28), n 653, 260 koin, jadi rekomendasi M4 diganti ke situ.
M2a `trendParent` +0,09R. M1 ±0. M5 `btc1h+anomaly` lemah di koin kecil (+0,05R); `btc1h+btcDom+wyckoff` +0,19R stabil
(n 3300). M6 tidak ada kombinasi positif. User: M1/M5/M6 mati, `bot.topVolume` 300.

**Filter momentum sebelum fill ditolak.** Dari 45 trade live (16–19 Nov), SL banyak terjadi saat short setelah koin naik > 2R
dalam 4 jam atau BTC naik > 0,6% dalam 2 jam. Di lab 300 koin pola itu tidak berlaku: setup M0 yang akan di-skip justru +0,13R
vs +0,11R untuk yang diambil, model lain juga datar. Jadi itu efek periode, bukan aturan. Sejalan dengan lab 18 Nov.

**Campur tangan manual (simulasi trade live, ExitTracker sama dengan bot).** TP manual terlalu cepat: +12,4R aktual vs +20,2R
kalau dibiarkan. Cancel di Binance: +6,7R hilang. "Lewat TP = batal" impas kalau limit tetap ditunggu sampai expired 24 jam
(+0,4R di 75 order), jadi aturan itu tetap. BE menyelamatkan ±3,5R dibanding SL awal vs TP saja.

## 19. Order flow tanpa geser SL (lab + permintaan user, 2026-11-19)

Pemicu: AAVE short M0 (entry 110,05, SL 110,95). Sesudah ±1R, wick reaktif menggeser SL ke 110,37, lalu ke-sentil −0,36R.
User: order flow cukup jadi validasi untuk **menahan** posisi (tanpa partial, trailing berhenti), SL jangan ikut digeser.

Lab 100 koin, 6 bulan, filter bot (POI 4h/1d + konfluensi wajib), avg R:

| Model | SL ke retest (lama) | SL tetap, BE jalan | SL tetap + tanpa BE selama hold | SL tetap, tanpa TP (trailing) |
|---|---|---|---|---|
| M0 (n 763) | +0,26 (IS +0,27 / OOS +0,25) | **+0,35** (IS +0,33 / OOS +0,38) | +0,35 | +0,49 (OOS +0,37) |
| M2a (n 74) | +0,28 | **+0,37** (IS +0,28 / OOS +0,44) | +0,28 | +0,71 (n kecil) |

→ `exit.orderFlowMoveSl` (default **false**). Order flow tetap menahan posisi, BE/tight-BE tetap jalan. Varian tanpa TP belum
dipakai (OOS M0 tidak lebih baik dan n M2a kecil). Trade terbuka dari sebelum perubahan juga ikut aturan baru setelah restart.

## 20. M7 MSNR (Malaysian SnR) + lab strategi lain (permintaan user, 2026-11-20)
Aturan dari sumber publik (LuxAlgo, indikator TradingView), **bukan materi kursus**. Detektor `modelM7` + `snrLevels` di `setups.ts`,
config `smc.msnr*`, exit `msnrExit` (TP di level, tanpa ladder/trailing).
- Level A/V = puncak/lembah **close** 4h (line chart, pivot 2 kiri-kanan). **Fresh** sampai kena wick pertama.
- Storyline = close harian (dari 4h) di atas EMA20 yang naik (3 hari) → long di level V; di bawah EMA20 yang turun → short di level A.
- Limit dipasang saat close 15m masuk ≤ `msnrNearAtr` × ATR(14) 4h dari level yang masih fresh. SL `msnrSlAtr` (1) × ATR di balik
  level, TP = level fresh berlawanan terdekat (min `msnrMinRR` 1,5). Limit expired 24 jam; selama level masih fresh, pendekatan
  berikutnya memasang limit baru.
- Lab cepat (script terpisah, 150 koin, 6 bulan, fill wajib tembus 0,1%): +0,22R (IS +0,12 / OOS +0,43), 6 dari 7 bulan positif.
- **Lewat mesin app** (detector + `simulateSetup`, fill/exit 1m, fee, plan `liq`), 150 koin: n 11.836, WR 30%, **+0,10R**
  (IS −0,01 / OOS +0,32). Long −0,03R, short +0,19R. Per bulan: Mei +0,33, Jun +0,01, Jul +0,06, Agu −0,13, Sep −0,05, Okt +0,17,
  **Nov +0,84** (dump BTC). `btc4h`: +0,18R (IS +0,04 / OOS +0,40), Jul −0,12. Jarak pemasangan 1/3/6 ATR hasilnya sama.
- Kesimpulan: **belum ada edge yang stabil**; profit kebanyakan dari short saat pasar turun (Nov). M7 terdeteksi di chart/screener/
  backtest, **tidak** masuk `bot.models` otomatis. Konfluensi rekomendasi M7 kosong.
- Strategi lain di lab yang sama (150 koin, 15m, fee): breakout range Asia → London −0,05 s/d −0,09R; reversal harian cross-section
  (long 5 terburuk / short 5 terbaik 24 jam) −0,05R; ikut lonjakan volume 1h −0,04 s/d −0,15R (OOS −0,3 s/d −0,4); mean reversion
  Bollinger 1h ±0 s/d −0,04R. Semua tidak dibuat.

## 21. Lab POI (ML + statistik) dan M8 POI HTF searah trend (permintaan user, 2026-11-22)
- **Dataset POI** (script scratchpad, bukan repo): setiap POI app (OB, RBS/SBR, QM, OCL, OCL Break) 15m/1h/4h/1d di 300 koin,
  **sentuhan pertama** saja (2,25 jt). Trade: limit di garis POI, SL di ujung POI + 0,1 × ATR (min max(0,3 %, 0,3 × ATR)), TP 2R,
  fill/exit 1m, fee. Dua look-ahead ketemu dan dibuang: (1) sentuhan setelah candle pembatal *dibuka* dibuang padahal batalnya
  baru diketahui saat candle itu close; (2) `detectOcls` mengganti label OCL yang nanti jebol jadi OCL Break di seluruh histori
  (sudah di-fix di app, lihat CLAUDE.md). Setelah fix, OCL biasa 1d turun dari +0,15R jadi −0,05R.
- **ML (LightGBM, walk-forward bulanan):** model selalu lari ke fitur kondisi pasar (`btc24`), tidak konsisten positif per bulan.
- **Statistik per sifat POI:** 15m rugi semua jenis; QM dan OB paling jelek di semua TF; TF makin besar makin bagus.
  Yang konsisten IS dan OOS: searah BTC 4h (+0,01 vs −0,09R), trend 1d koin searah (+0,01 vs −0,08R), origin tap POI HTF
  (+0,01 vs −0,05R). Volume/taker buy/kecepatan balik/POI numpuk hampir tidak berpengaruh.
- **M8** (`modelM8`, config `smc.m8*`, exit `m8Exit`): POI 4h/1d RBS/SBR/OCL Break belum pernah disentuh, BTC 4h + trend 1d koin
  searah, SL ≥ 1 %. Limit dipasang saat close 15m ≤ 1R dari garis, expired 32 candle (8 jam); selama POI belum disentuh dipasang
  lagi. TP tetap 2R tanpa BE/trailing. Lab statistik: +0,08R (IS +0,05 / OOS +0,12), 5/7 bulan positif. **Lewat detektor app**,
  100 koin (status 15m + fee): n 6.514, WR 37 %, +0,09R (IS +0,03 / OOS +0,17); RBS +0,25R, SBR ±0, OCL Break +0,07R; per bulan
  Mei +0,26, Jun −0,05, Jul −0,14, Agu +0,15, Sep +0,01, Okt +0,02, Nov +0,63. Puluhan kombinasi dites dan holdout ikut terpakai.
- **Shadow paper** (`bot.shadowModels`, default `['M8']`): setup model ini selalu masuk akun paper walaupun bot live, tidak pernah
  kirim order, tidak memakai slot/rem harian live, tanpa profil koin. Statistiknya tampil terpisah di halaman Bot.

## 22. Tag liquidity per model (permintaan user, 2026-11-22)
Dari dataset POI (§21), ML sebagai gerbang entry **tidak stabil**. Model dilatih untuk membandingkan POI di hari yang sama, dan
"top 30 %" pilihannya hanya lebih bagus di 3 dari 5 bulan. Jadi temuannya dibuat **tag konfluensi biasa** (`liquidityAround` di
`setups.ts`, filter, tanpa skor):
- `liqHtfBehind`: ada swing 4h/1d yang belum disapu di antara SL dan 1R di balik SL.
- `liqInPoi`: ≥ `smc.liqInPoiMin` (5) swing yang belum disapu (semua TF) di antara entry dan SL.
- `cleanApproach`: dalam 24 jam terakhir, maksimal 1 swing dalam 3R di depan entry yang disapu (harga datang langsung).
Sapuan baru dihitung setelah candle penyapunya close.

Backtest mesin app (100 koin, ±6 bulan, fill/exit 1m, fee, exit sama dengan bot, maks 1 trade/koin/model/hari):
| Model | Dasar (konfluensi bot) | Tag yang membantu (IS dan OOS) |
|---|---|---|
| M0 (POI 4h/1d) | +0,24R, 7/7 bulan | `cleanApproach` +0,32R (IS +0,26 / OOS +0,40); `liqHtfBehind` tidak (OOS turun) |
| M1 | −0,07R | `liqHtfBehind` +0,07R (IS +0,11 / OOS +0,02); `cleanApproach` lebih jelek |
| M2a / M2b | −0,12 / −0,02R | tidak ada; `cleanApproach` jauh lebih jelek (model ini butuh sweep) |
| M4 | +0,16R, 6/7 bulan | tidak relevan (`slLiqClear` sudah wajib, kebalikan `liqHtfBehind`) |
| M7 | +0,09R | `liqHtfBehind` +0,13R (IS +0,09 / OOS +0,19) |
| M8 | +0,12R | `liqHtfBehind` +0,15R, `liqInPoi` +0,17R, `liqHtfBehind + cleanApproach` +0,19R (6/7 bulan) |

Teori "liquidity di belakang SL = magnet ke SL" tidak terbukti untuk POI HTF. Rekomendasi (`RECOMMENDED_MODEL_CONFLUENCE`,
migrasi sekali `migr_liq_tags`): M0 + `cleanApproach`, M1 + `liqHtfBehind`, M7 `liqHtfBehind`. M8 tanpa syarat, karena forward
test shadow mencatat tag-nya untuk dibandingkan.

## 23. Inducement, M9, dan kombinasi terbaik semua model (permintaan user, 2026-11-23)
Definisi di `docs/smc-rules.md §11`. Dua lab:

**Lab statistik** (100 koin, 191 rb sentuhan pertama POI 1h/4h/1d, limit di garis, SL ujung POI, TP 2R, fee; "vs pasar" = R
dikurangi rata-rata hari itu): umpan (`baitTaken`) dan IDM ketat konsisten **lebih bagus dari POI lain di hari yang sama**
(+0,05 s/d +0,15R), paling jelas di POI **OB dan QM** (QM tanpa umpan −0,22R → dengan umpan +0,01R; OB −0,17 → −0,07R).
Di SBR/OCL Break dan di filter M8 tidak membantu. Extreme POI 4h +0,13R (n 260), kecil.

**Backtest mesin app** (100 koin, ±6,5 bulan, fill/exit 1m, fee, semua model × 8 exit × 0–2 tag, ±30 rb kombinasi).
Kombinasi yang dipilih dari IS saja kebanyakan anjlok di OOS (M1: IS +0,60 → OOS −0,26), jadi yang dipakai cuma yang
n besar, positif di IS dan OOS, dan banyak bulan positif. Dalam kondisi bot (POI 4h/1d untuk M0–M2):

| Model | Sebelum | Dipasang (migrasi `migr_lab_1123`) |
|---|---|---|
| Exit SMC (M0/M1/M2) | bertingkat + TP liquidity | **tanpa TP** (`exit.tpMode` trail): M0 +0,02 → +0,07R, M2a +0,27 → +0,49R (n 85) |
| M0 | +0,02R | + `baitTaken`: +0,10R (IS +0,01 / OOS +0,20, 6/7 bulan, n 271) |
| M4 | TP 1R +0,17R | `breakerTpR` 0 (exit global) + `fvg`+`slLiqClear`+`cleanApproach`: **+0,44R** (IS +0,42 / OOS +0,47, 7/7 bulan, n 450). `oiConfirm` dilepas (tidak bisa dites dengan exit ini) |
| M8 (shadow) | TP 2R +0,12R | TP 3R +0,16R (IS +0,10 / OOS +0,24) |
| M9 (shadow, baru) | TP 2R ±0R (OOS −0,10) | exit tanpa TP + `cleanApproach`: +0,23R (IS +0,26 / OOS +0,19, 6/7 bulan, n 6.202) |

Lainnya (tidak diubah): M7 + `btc4h` +0,20R; M5 `btc1h`+`anomaly` TP liquidity +0,32R; M8 + `anomaly` TP 3R +0,41R (n 536);
M1 tetap negatif/tidak stabil. Semua hasil masih backtest dengan banyak kombinasi → tetap pantau live/shadow.

**Koreksi user (2026-11-23): POI B M9 = order block, bukan RBS/SBR.** `smc.m9Kinds` jadi OB + QM (migrasi `migr_m9_ob`).
Per jenis (`cleanApproach` + trailing, 100 koin): OB +0,17R (IS +0,35 / OOS −0,03, n 1.246), QM +0,32R (+0,31/+0,33, 7/7 bulan,
n 281), RBS (dibuang) +0,24R (+0,24/+0,26, n 4.675, 75 % trade M9 lama). OB+QM gabungan +0,20R (OOS +0,02).


## 24. CISD / SMT / IFVG + konfluensi OR (permintaan user, 2026-11-23)

Tag baru (definisi di `docs/smc-rules.md §11`, kode `strategy/confirm.ts`): `cisd`, `smt` (1h vs BTC; BTC vs ETH), `ifvg`.
Konfluensi **OR** per model: `bot.modelConfluenceAny` (minimal satu tag ada, di atas list wajib), profil koin `anyConfluence`,
filter Backtest "Salah satu (OR)". Migrasi sekali `migr_or_1123` mengisi list OR dari lab ini.

Lab 100 koin (mesin app, exit bot, scope POI bot, Mei–Nov; IS = Mei–Agu, OOS = Sep–Nov, dedup per koin/model/hari/arah/TF).
Kombinasi OR 1–3 tag diuji di atas list wajib yang sekarang (n IS ≥ 100, n OOS ≥ 60):

| Model | Wajib sekarang | + OR yang dipasang | Catatan |
|---|---|---|---|
| M0 | +0,10R [+0,01 / +0,20] n 271 | `bbMomentum / ifvg / smt`: +0,21R [+0,12 / +0,31] n 197, 6/7 bln | top-3 dipilih dari IS |
| M4 | +0,29R [+0,39 / +0,17] n 2.434 | `anomaly / manipulation / smt`: +0,39R [+0,43 / +0,36] n 1.037, 7/7 | IS-pick `manipulation` [+0,51 / +0,29] |
| M5 | +0,15R [+0,12 / +0,18] | `btc4h / smt`: +0,22R [+0,24 / +0,19] | M5 tidak di bot.models |
| M8 | +0,16R [+0,10 / +0,25] n 5.319 | `anomaly`: +0,40R [+0,43 / +0,37] n 527, 6/6 | IS-pick #1 |
| M9 (OB+QM) | +0,19R [+0,36 / −0,02] n 1.859 | `bbMomentum / liqHtfBehind`: +0,27R [+0,32 / +0,19] n 806 | **IS-pick gagal di OOS**, ini dipilih pakai OOS → optimistis |

Tidak dipasang: M1 (tidak ada yang kokoh), M2a/M2b (n kecil), M7 (IS-pick `pdZone` OOS turun ke +0,10R).
Efek tag sendiri: `cisd` muncul di 73–100 % setup (hampir tidak menyaring), `smt` 7–25 % (M0 +0,48R n 41, M4 +0,42R n 480,
tapi M9 −0,00R), `ifvg` campur. Tanpa list wajib (OR saja) selalu lebih jelek dari wajib + OR.

## 25. QM versi internet + M10 QM konfirmasi (permintaan user, 2026-11-23)

**QM:** bentuk di kode sudah sama dengan QM/QML internet (left shoulder → reaction → head lebih jauh → MSB → entry di level
left shoulder, SL di balik head). Disesuaikan: MSB (break L1) wajib **close body** (`smc.qmRequireCloseBreak`, default true).
Lab 100 koin: ±20 % QM hilang. M9 POI QM + aturan bot: +0,26R → **+0,42R** (IS +0,39 / OOS +0,47, 7/7 bulan, n 291 → 216).
M0/M1 QM: beda kecil/campur.

**M10** (POI HTF kena → QM entry TF, `modelM10`, `docs/smc-rules.md §11`): lab 100 koin, trailing:
tanpa filter −0,03R (POI 4h/1d −0,05R, IS −0,14 / OOS +0,07). Wajib `btc4h + slLiqClear`: +0,15R (IS +0,11 / OOS +0,20,
4/7 bulan, n 254), banyak kombinasi diuji → lemah. OR terbaik `btc4h` (IS −0,01). Default `modelConfluence.M10` = btc4h +
slLiqClear (migrasi `migr_m10`), **tidak** masuk `bot.models`.

## 26. Timeframe "aneh" 3m / 45m / 2h / 3h + M10 di 1m/3m/5m (permintaan user, 2026-11-23)

User: "institusi kadang gerak di menit aneh". **Disimpan di DB** seperti TF turunan lain (migration `0008_candles_odd`, cascade
3m←1m, 45m←15m, 2h/3h←1h; semua bucket rata UTC tengah malam). Data lama diisi sekali dari candle yang sudah ada saat worker start
(`Backfiller.deriveAddedTimeframes`, tanpa download). Chart, forming candle live, config POI (smc/bot/M8/M9) bisa pakai TF baru.
`rebuildDerived` sekarang mulai dari bucket masing-masing target (45m tidak rata dengan 4h).

Lab 100 koin (mesin app, POI TF aneh di-resample dari 1m, avg R [IS / OOS] bulan+):

| Model | TF standar | TF aneh |
|---|---|---|
| M0 (+ wajib bot, trailing) | 1h +0,26 [+0,53/−0,08], 4h +0,08 [+0,02/+0,13] | 45m +0,01, 2h −0,03, 3h +0,08 (n 61) → **tidak lebih bagus** |
| M8 (TP 3R) | 4h +0,18 [+0,11/+0,27], 1d +0,09 | 45m +0,11 [+0,03/+0,22], 2h +0,11, **3h +0,16 [+0,05/+0,29]** → mirip 4h |
| M8 + `anomaly` (config bot) | 4h+1d +0,40R n 519 | + 3h: +0,31R n 873; + 2h + 3h: +0,26R n 1.319 (total R lebih besar, per trade turun) |
| M9 (+ cleanApproach) | 1h +0,24, 4h +0,22 | 45m +0,02, 2h +0,03, 3h −0,09 → **lebih jelek** |
| M10 (POI → QM LTF) | QM 1m −0,15R, 3m −0,06R, 5m +0,19R (OOS −0,09) | semua TF POI negatif −0,10 s/d −0,15R |

**10m** (user: "TF yang bikin TradingView berbayar", disimpan juga, dari 5m), lab 100 koin yang sama:

| Pemakaian 10m | Hasil |
|---|---|
| Entry TF M0 (OB valid 10m, ganti 15m), POI 4h+1d + wajib bot | **−0,16R** [−0,18 / −0,14] 2/7 vs entry 15m **+0,13R** [+0,09 / +0,16] 5/7 |
| POI M0 (+ wajib bot) | +0,04R [+0,04 / +0,04] n 251 (tanpa filter −0,11R) |
| POI M8 (TP 3R) | +0,13R [+0,06 / +0,20] 6/7, n 8.849 (≈ 45m/2h, di bawah 4h +0,18R) |
| POI M9 (+ cleanApproach) | −0,09R |
| QM konfirmasi M10 | −0,17 s/d +0,10R (POI 4h + wajib bot +0,10R n 222), umumnya negatif |

Kesimpulan: TF aneh tidak memberi edge tambahan, kecuali **M8**, yang tetap positif di 45m/2h/3h (nambah jumlah trade, avg R per
trade turun). M10 versi 1m/3m/5m rugi (SL kecil → fee besar); versi QM 15m sebelumnya −0,05R. Tidak ada yang dipasang otomatis.

## 27. Cerita POI lapis 3: fakta mana yang benar-benar menaikkan peluang (2026-11-23)

Lab 100 koin (mesin app, `lab3.ts` di scratchpad): tiap setup M0/M2a/M8/M9 dicatat bersama 24 fitur angka dari cerita POI induknya
(`StoryFeatures`, dihitung saat setup diketahui). Label = kena 2R sebelum SL; exit = exit bot.

- **Skor peluang gabungan gagal:** logistic dilatih di IS, setup OOS dibagi 5 menurut peluang → tidak naik konsisten (M0, M8, M9).
  Filter "peluang ≥ P60" tidak lebih bagus dari tanpa filter di OOS. Tidak dipasang.
- **Fakta tunggal yang konsisten IS dan OOS:**
  - M0 (semua setup): nggak ada liquidity di balik SL +0,35 / +0,26R, ada BOS +0,15 / +0,39R. Tapi **di atas filter bot M0 tidak
    menambah** (OOS negatif / n kecil) → tidak dipasang.
  - **M8:** tanpa target B −0,68 / −0,83R; displacement ≥ median (0,95× ATR) +0,26 / +0,13R. Di atas OR `anomaly` (config bot):
    +0,40R → **+0,58R** [IS +0,54 / OOS +0,64] 6/6 bulan, n 527 → 353. Tanpa `anomaly` +0,16R → +0,35R (n 2.379).
  - M9: semua efek kecil.
- Dipasang: tag `dispStrong` + `liqTarget` (`strategy/story.ts legDisplacement` / `drawTarget`, sama persis dengan lab: 124/124 cocok),
  wajib M8 (migrasi `migr_m8_story`). M4 belum punya cerita (POI induknya OB lawan yang jebol).

## 28. Lab 300 koin: exit di target B, M8 di 200 koin baru, tag cerita baru (2026-11-23)

300 koin top volume (100 koin lama + **200 koin baru** yang belum pernah dipakai memilih aturan), mesin app, exit bot.

- **Exit di target B** (TP di pool dengan tarikan terbesar dari cerita POI, polos atau bertingkat): **tidak lebih bagus**.
  Filter bot: M0 exit bot +0,25R vs B +0,21R; M8 TP 3R +0,23R vs B +0,14R; M9 B negatif; M2a B +0,35R vs +0,30R (n 257,
  terlalu kecil untuk ganti exit). Tidak dipasang.
- **M8 `liqTarget + dispStrong` lolos di koin baru:** 200 koin baru +0,21R → +0,29R (7/7 bulan). OR `anomaly` tidak menambah di
  koin baru (dengan +0,34R n 1.594 vs tanpa +0,30R n 11.417) → **dilepas** (trade ±7× lebih banyak, avg R sama).
- **Tag baru** (`slPoolClear`, `pdPremium`, rumus sama dengan cerita POI, cocok 664/664 dan 656/664 dengan lab):
  - M0 (filter bot) + `slPoolClear` (tidak ada pool ≤ 1R di balik SL POI): **+0,83R** [lama +0,70 / baru +1,08] vs +0,12R, n 97.
  - M9 (filter bot) + `pdPremium` (POI di sisi mahal: long di premium / short di discount): **+0,33R** [+0,37 / +0,45 / baru
    +0,29] 6/7 bulan vs −0,05R, n 1.060. Kebalikan aturan ICT klasik (beli di discount): di data ini ikut momentum lebih bagus.
    (M2a juga +0,69R vs −0,07R tapi n 120 dan IS kosong → belum dipasang.)
- Dipasang lewat migrasi `migr_story300`: M0 + `slPoolClear`, M9 + `pdPremium`, M8 OR kosong.

## 29. Konsep dari internet: OTE, Power of 3 / Judas, harga open, CVD (2026-11-23)

Riset internet (sumber kebanyakan blog broker / penjual indikator tanpa bukti; satu-satunya uji kuantitatif, Judas swing di 18
tahun emas, = 50 %). Dibuat sebagai fitur (`strategy/extra.ts`, test `extra.test.ts`) lalu dites di 300 koin (IS / OOS 100 koin
lama + 200 koin baru), di atas filter bot baru (§28):

| Konsep | Hasil |
|---|---|
| **Entry di sisi murah open harian UTC** (long di bawah open) | **M9 + pdPremium: +0,33R → +0,54R** [+0,78 / +0,72 / baru +0,42], 6/7 bulan, n 537 vs sisanya +0,12R → tag `dayOpenCheap`, wajib M9 |
| OTE 62–79 % | M9 +0,54R tapi IS lama sama dengan tanpa filter; lainnya campur → tidak |
| Power of 3 / Judas (lawan range Asia 00–07 UTC disapu dulu) | tidak konsisten di model mana pun (sesuai uji emas di internet) → tidak |
| Open mingguan | M4 sisi mahal +0,39R vs +0,34R tapi IS lama turun → tidak |
| CVD divergence di POI | **jelek** di M0/M4/M9 (bukan sinyal reversal); M9 tanpa divergence +0,39R (kecil) → tidak ditumpuk |
| NWOG/NDOG, kluster likuidasi | tidak berlaku (crypto 24/7) / tidak ada data histori → tidak dites |

Filosofi M9 sekarang: POI di sisi mahal range 4h (ikut momentum) **dan** entry di "diskon" harian (pullback intraday).
`dayOpenCheap` cocok 296/296 dengan lab. Migrasi `migr_story300` (§28) juga memasang ini.

**Batas SL M8 (2026-11-23, user: "telat banget, udah naik", KITE):** M8 beli RBS 4h di pucuk kenaikan dengan SL 13 % di bawah
(ekstrem asal POI jauh). Lab 300 koin, M8 + tag cerita, per lebar SL: 1–3 % +0,22–0,24R, **3–12 % +0,36–0,42R**, **≥ 12 % +0,15R**
(koin baru +0,07, 20 % dari trade M8). `smc.m8MaxSlPct` (0 = tanpa batas): setup dengan SL lebih lebar dilewati. Dipasang **8** (user: SL lebar bikin slot / modal
nyangkut berhari-hari, opportunity cost; 8–12 % lemah di IS, +0,12R).

**Revisi 2026-11-23 sore (user):** M0 sepi (0 order sejak `slPoolClear` wajib), jadi `slPoolClear` dipindah ke list OR M0
(`bbMomentum / ifvg / smt / slPoolClear`). Lab 300 koin dengan kode sekarang (M0 POI 4h/1d, exit trailOF): wajib = +0,83R
tapi n 97 dalam 7 bulan dan OOS −0,09R; di OR = **+0,25R** (IS +0,22 / OOS +0,27 / koin baru +0,25), n 632 (±90/bulan).
3 bulan terakhir per 30 hari: +0,09 / +0,34 / −0,15R. **M2a dimatikan** (`bot.models` = M0, M8, M9): 3 bulan lab −0,43 / −0,44 /
+1,34R per trade, live −7R sejak 14 Nov. Diubah langsung di config (tanpa migrasi), default `RECOMMENDED_*` ikut.

## 30. M11 OB HTF + OCL Break di TF turunan (permintaan user, 2026-11-25)

User: "OB 4h, 2h kebentuk OB juga, 1h kebentuk OCL Break" → lab14/15 → model. **M11** (`modelM11`, mesin sama dengan M8 lewat
`htfPoiModel`): OB `smc.m11PoiTimeframes` (default **1d**, pilihan user) yang pertama kali disentuh, dan di dalam candle OB itu lahir
OCL Break searah di TF turunan (`M11_KID_TFS`: 1d → 4h/2h, 4h → 2h/1h), sudah diketahui dan belum invalid saat order dipasang
(`oclKidOf`). Sisanya ikut setting M8: dekat ≤ `m8NearR`, BTC 4h + trend 1d searah, SL di balik ujung OB + 0,1 ATR (1–8 %), TP
max(`m8TpR`, target B), expiry `m8ExpiryCandles`. Wajib default (migrasi `migr_m11`): `liqTarget` + `dispStrong`. **Tidak** di
`bot.models` (user: backtest dulu).

Lab (scratchpad, fee + 1m, TP max(3R, B)):
- `lab15` (OB 4h/1d, entry di sentuhan pertama, 300 koin, DB 1 tahun): OB + BTC 4h + trend 1d +0,15–0,20R (n ±17 rb, 8–9/12 bulan).
  Resep M8 penuh: OB 4h/1d + OCL Break +0,22R (n 787) vs tanpa OCL Break +0,04R; OB 1d + OCL Break +0,70R (n 122, menang 30 %).
- `lab16` (mesin app, `detectSetups` M11, 300 koin, Des 2025–Nov 2026): semua setup **+0,32R** (n 875, 10/12 bulan, Des–Mei +0,34 /
  Jun–Nov +0,30), dengan `dispStrong + liqTarget` +1,09R tapi n 76 dan 5 trade terbesar = 48 dari 83R.
  **Tapi di 100 koin teratas (universe bot) ≈ +0,05R** (n 276); profitnya dari 200 koin kecil (+0,44R).
- Replay portofolio bareng M8 (40 slot, 1 posisi/koin): M11 kebanyakan muncul di koin yang lagi dipegang M8. Top 100: M8 saja
  +540R vs M8 + M11 +506–533R (tidak menambah). 300 koin: M8 + M11 tanpa tag +635R vs +527R (110 trade M11 masuk, +0,41R).
