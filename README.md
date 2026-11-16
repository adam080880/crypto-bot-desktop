# SMC Trading Assistant

**Kontributor ide:** [Rizalphlv](https://github.com/Rizalphlv) · [adam080880](https://github.com/adam080880)

Aplikasi desktop (Electron) untuk membantu trading crypto di **Binance USDT-M Futures**: deteksi konsep
SMC/ICT, screener, backtest, bot (paper/live), radar pump, kalender news USD, dan Claude sebagai analis.

> *English:* a desktop assistant for Binance USDT-M futures — SMC/ICT pattern detection, screener,
> backtester, paper/live bot, pump radar with Discord alerts, and USD economic news. UI is in Indonesian.

> [!WARNING]
> **Bukan saran keuangan.** Trading futures pakai leverage bisa menghabiskan modal. Mode **live** mengirim
> order beneran ke akun Binance kamu. Hasil backtest tidak menjamin hasil ke depan. Hampir semua model di
> sini **belum punya edge yang konsisten setelah fee** (lihat [Hasil riset](#hasil-riset-jujur)).
> Pakai dengan risiko sendiri, mulai dari mode **paper**.

## Fitur

| Halaman | Isi |
|---|---|
| **Chart** | Candle 1m–1w (lightweight-charts), overlay SMC (structure, BOS, OB, FVG, RBS/SBR, OCL, QM, liquidity), setup aktif, posisi bot live dengan R berjalan, tombol close/cancel, buka trade lama dari Bot/Backtest |
| **Screener** | Scan semua koin yang punya histori: setup aktif, harga dekat POI 1h/4h, BOS baru, trend searah. Otomatis tiap 15 menit |
| **Backtest** | Satu koin, semua model × semua rencana exit sekaligus, fill/exit di candle 1m, fee + slippage, split in-sample / out-of-sample, tab Meta untuk menyimpan profil per koin |
| **Bot** | Paper atau live. Risk per trade dalam % equity, SL wajib, leverage aman di bawah likuidasi, exit bertingkat, hasil win / BE / loss terpisah |
| **Rotasi** | Forward test rotasi momentum long/short. **Paper saja**, tidak pernah kirim order |
| **Kalender** | Event USD (jadwal + forecast + actual dari BLS/FRED), bias USD → crypto, news window |
| **Claude Analyses** | Analisis berkala koin watchlist lewat Claude Agent SDK (opsional, read-only tools) |
| **Radar pump** | Koin dengan volume 24 jam ≥ 8× median atau funding negatif + volume tinggi → notifikasi Discord/desktop |

## Apa itu SMC (versi app ini)

**SMC (Smart Money Concepts)** / **ICT** adalah cara membaca chart dengan asumsi harga bergerak ke tempat
banyak order menunggu (liquidity), lalu bereaksi di zona tempat pemain besar dulu masuk (POI, *point of
interest*). App ini **tidak** memakai definisi ICT umum mentah-mentah. Aturannya diambil dari materi kursus
yang dipelajari penulis, ditulis ulang di [`docs/smc-rules.md`](docs/smc-rules.md), lalu dijadikan kode yang
bisa dites. Semua detektor ada di `src/main/strategy/`.

| Konsep | Arti di app ini |
|---|---|
| **Market structure** (HH, HL, LH, LL) | Trend naik = rangkaian Higher High + Higher Low; trend turun = Lower High + Lower Low. Trend dianggap lanjut selama low (naik) / high (turun) terakhir tidak ditembus |
| **BOS** (Break of Structure) | Close menembus swing yang menjaga trend → **trend berbalik**. (Di ICT umum ini disebut CHoCH; app memakai istilah materi) |
| **CHoCH LTF** | Flip struktur kecil di TF entry (15m) setelah harga menyentuh POI besar. Dipakai sebagai konfirmasi |
| **Order Block (OB)** | Candle di swing low/high yang wick-nya lebih panjang dari candle sebelumnya **dan** warnanya searah (OB bullish = candle hijau dengan wick bawah panjang). Wick panjang = sisa liquidity. Garis entry = ujung body |
| **OB valid** | "POI kena POI": setelah OB/POI pertama kena, terbentuk OB baru di dekatnya. Itulah yang dipakai untuk limit |
| **FVG** (Fair Value Gap) | Celah tiga candle yang wick-nya tidak saling menutup. **Hanya konfluensi**, app tidak pernah entry di FVG |
| **RBS / SBR** | Resistance yang ditembus close jadi support (RBS), atau sebaliknya (SBR) |
| **OCL / OCL Break** | Dua candle searah berurutan (level = close candle pertama); OCL Break = candle lawan arah yang close melewati body itu. Hanya dipakai sebagai POI induk dari TF besar |
| **QM** (Quasimodo) | Pola "tiga gunung": gunung kedua menembus gunung pertama, entry saat harga kembali ke body gunung pertama |
| **Liquidity** | Wick OB yang belum tersapu + swing high/low (BSL/SSL) dan equal high/low yang belum disapu |
| **Sweep** | Harga menembus liquidity lalu balik. Banyak model mensyaratkan POI terbentuk karena sweep (*origin*) |

Detektor hanya memakai candle yang sudah close (tidak repaint), dan **fungsi yang sama** dipakai chart,
screener, backtest, dan bot. Jadi hasil backtest = perilaku live.

## Model entry

Setiap model menghasilkan *setup*: arah, harga entry (limit), SL, dan rencana exit. Model bisa dinyalakan
satu per satu di **Settings → Bot entry**, dan dibandingkan di halaman **Backtest**.

| Model | Kapan entry | SL | Exit default |
|---|---|---|---|
| **M0** baseline | POI kena → OB valid terbentuk → limit di OB valid | Di luar wick OB | Bertingkat |
| **M1** POI besar → POI kecil | POI induk 1h/4h kena → CHoCH 15m dengan displacement → limit di POI kecil yang tercipta (prioritas QM > OB dengan FVG > OB) | Di luar ekstrem leg sejak POI kena | Bertingkat |
| **M2a** liquidity grab | Ada OB tepat di balik SSL/BSL yang belum disapu → limit langsung di OB itu | Di luar wick OB | Bertingkat |
| **M2b** grab + konfirmasi | Seperti M2a, tapi tunggu sweep + CHoCH 15m dulu, lalu entry di POI kecil seperti M1 | Di luar ekstrem leg | Bertingkat |
| **M4** breaker | OB 1h/4h yang dijebol setelah sweep berubah fungsi → limit saat harga retest | Ujung lain OB | **TP 1R** |
| **M5** trend 4h (bukan SMC) | Close 4h tembus high/low 20 candle dan di sisi benar EMA200 → limit di close itu | 3× ATR | Trailing saja, tanpa BE/TP |
| **M6** radar pump (bukan SMC) | Radar bunyi (volume 24j ≥ 8× median, atau funding ≤ −0,05% + volume ≥ 3×) → close 1h tembus box 24 jam → limit di close itu. Long saja | 3× ATR 1h | **Tanpa TP: ambil profit manual**, SL trailing |

SL semua model SMC (M0–M4) minimal 1× ATR(14) TF entry; kalau lebih sempit, SL dilebarkan dan ukuran posisi
otomatis mengecil (risk per trade tetap).

**Exit bertingkat** (`src/main/strategy/exit.ts`, dipakai backtest dan bot): di 1R SL ke break-even bersih
fee; kalau SL < 1% dari harga, BE baru di 2R dan mengunci +0,5R. Di 3R tutup 50% dan SL ke 1R, lalu trailing.
Kalau ada *order flow* (FVG searah yang diretest dan mantul, atau wick penolakan di area entry), posisi ditahan.

**Konfluensi** (tag, bisa diwajibkan per model): FVG, searah trend TF POI, sweep, POI HTF, trend BTC 4h/1h,
Wyckoff, killzone, open interest naik searah (`oiConfirm`), OI tidak turun (`oiHold`), funding lawan crowd, dan
`anomaly` (volume 24 jam ≥ 3× median). Skor setup cuma info, di backtest tidak berkorelasi dengan hasil.

**Pengaman sebelum order** (`src/main/bot/gate.ts`): koin crypto top 100 volume, satu posisi per koin, batas
posisi terbuka, berhenti sisa hari kalau rugi harian ≥ batas, tidak entry di news window USD, setup harus baru,
harga belum lewat TP/entry, dan (opsional) analisis Claude searah dengan confidence ≥ batas.

## Instalasi

Butuh **Node 22+** dan **pnpm** (lewat corepack).

```bash
corepack enable
pnpm install
# kalau binary Electron belum terdownload:
node node_modules/electron/install.js
pnpm test && pnpm typecheck
pnpm dev
```

### Data historis

Harga diambil dari endpoint **publik** Binance (tanpa API key): zip bulanan/harian `data.binance.vision`
(dicek SHA-256) lalu REST untuk sisa terbaru. 1m disimpan 6 bulan; 5m/15m/1h/4h di-resample dari 1m;
1d/1w 2 tahun.

```bash
pnpm data:backfill --test       # 5 simbol + estimasi ukuran
pnpm data:backfill --estimate   # proyeksi ukuran DB/waktu
pnpm data:backfill --all        # semua simbol (~10 GB, ±1 jam) — bisa Ctrl+C lalu dilanjutkan
pnpm data:backfill --verify     # cocokkan hasil resample dengan kline asli Binance
```

### Build

```bash
pnpm dist:mac             # macOS
pnpm dist:win             # installer Windows (jalankan di Windows)
pnpm dist:win:portable    # zip portable Windows dari Mac
```

Build belum di-sign, jadi Gatekeeper/SmartScreen akan memperingatkan. Claude Code CLI **tidak dibundel**;
fitur analis memakai `claude` yang terinstal di mesin kamu.

## Keamanan & privasi

- Semua key (Binance, Anthropic, BLS, webhook Discord) diisi di **Settings** dan disimpan terenkripsi dengan
  enkripsi OS (`safeStorage`) di database lokal. Tidak ada key di kode atau file config.
- Mode **live** tidak bisa dinyalakan lewat update config biasa: harus lewat saklar di halaman Bot, ketik
  `LIVE`, dan kedua key Binance harus tersimpan. Default selalu **paper**.
- Order live: margin isolated, One-way mode, entry limit post-only, SL `STOP_MARKET` lewat Algo Order API
  dipasang begitu fill terdeteksi. Kalau SL gagal dipasang, posisi langsung ditutup.
- **Kill Switch** (tray / halaman Bot) membatalkan semua limit yang menunggu; posisi terbuka tetap dijaga SL.
- Lokasi data: `~/Library/Application Support/smc-trading-assistant/` (macOS), `%APPDATA%\smc-trading-assistant`
  (Windows). Bisa dipindah dari Settings → Lokasi database.
- Kalau ISP memblokir DNS Binance, app memakai DNS Cloudflare (DoH). Matikan dengan env `SMC_SYSTEM_DNS=1`.

## Notifikasi Discord

1. Discord: edit channel → **Integrations → Webhooks → New Webhook → Copy Webhook URL**.
2. App: **Settings → API Keys → Discord webhook URL** → Simpan → **Kirim tes** (kartu "Notifikasi & radar pump").

Yang dikirim: radar pump, order bot (entry, fill, SL geser, close), peringatan/error bot, dan opsional setup
screener. URL webhook itu rahasia, jangan dibagikan.

## Hasil riset (jujur)

Backtest lab 2 tahun dengan fee + slippage, fill di candle 1m (detail di [`docs/entry-v2.md`](docs/entry-v2.md)):

- Model SMC (M1/M2b) kira-kira **impas sampai sedikit rugi** setelah fee. Breaker 15m jelas rugi (−0,25R/trade),
  jadi breaker dibatasi ke 1h/4h dengan TP 1R (+0,08R in-sample dan out-of-sample, 3 koin).
- **M5 trend 4h + filter open interest** adalah satu-satunya yang positif konsisten di lab (±+0,26R/trade).
- Setup di koin yang sedang "ramai" (volume 24 jam ≥ 3× median) hasilnya lebih baik. Tag `anomaly` bisa
  diwajibkan per model.
- Pump tidak bisa dideteksi saat koin masih sepi. M6 otomatis rugi di out-of-sample, jadi TP-nya manual.
- Rotasi momentum: out-of-sample −41% s/d +5% tergantung hari rebalance → paper saja.

Sampelnya terbatas (beberapa koin, 2 tahun). Validasi sendiri di halaman Backtest sebelum memakai uang
sungguhan.

## Arsitektur

```
src/main/        proses utama: DB (SQLite, drizzle), sync, strategi, bot, notifikasi, IPC
  workers/       dataWorker = satu-satunya penulis data pasar (sync, WebSocket, screener, bot, radar)
                 backtestWorker = satu proses per run backtest
  strategy/      detektor SMC + model entry + exit (fungsi murni, ada unit test)
src/renderer/    UI React + Tailwind + shadcn/ui, akses lewat window.api (kontrak di src/shared/ipc.ts)
src/shared/      tipe, config (zod), statistik backtest
docs/            PLAN.md (fase), smc-rules.md (aturan SMC), entry-v2.md (model, exit, hasil lab)
```

Stack: Electron, TypeScript 5.9, React, better-sqlite3 (N-API), drizzle-orm, zod, lightweight-charts v5,
croner, Claude Agent SDK.

## Kontribusi

Issue dan PR dipersilakan. Sebelum PR: `pnpm typecheck && pnpm test`. Perubahan aturan strategi sebaiknya
disertai unit test dan hasil backtest (in-sample + out-of-sample, termasuk fee).

## Lisensi

[MIT](LICENSE). Bebas dipakai, diubah, dan disebarkan, termasuk untuk komersial, asal menyertakan
pemberitahuan lisensi. Perangkat lunak ini diberikan **apa adanya, tanpa jaminan apa pun**.
