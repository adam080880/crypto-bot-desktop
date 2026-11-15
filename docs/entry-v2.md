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
