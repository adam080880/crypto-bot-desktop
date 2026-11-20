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
