# Aturan SMC — hasil ekstraksi dari materi kursus

Status: **DIKONFIRMASI user (2026-11-11)**: Q5 = warna candle ngaruh; semua ❓ lain pakai usulan default.
**Sudah diimplementasikan** di `src/main/strategy/` (fungsi murni + unit test). Semua angka ada di
config `smc` (`src/shared/config.ts`).

Sumber: 12 gambar materi kursus SMC (Materi 1–3) milik pihak lain, **tidak disertakan di repo** (hak cipta).
Aturan di bawah ditulis ulang dengan kata-kata sendiri.
Aturan di bawah **hanya** dari materi + penjelasan tambahan user di chat. Konsep yang tidak ada di
materi (CHoCH, premium/discount, killzone, sesi, BSL/SSL klasik ICT) **tidak** dipakai kecuali user
minta (lihat bagian "Tidak ada di materi").

Yang ditandai **❓** belum bisa jadi aturan pasti. Setiap ❓ punya **usulan default**: kalau user
setuju, itu yang diimplementasikan. Nilai angka dibuat configurable.

## Notasi
Untuk candle ke-`i`: `o, h, l, c`.
- `bodyHi = max(o, c)`, `bodyLo = min(o, c)`
- `upWick = h − bodyHi`, `loWick = bodyLo − l`
- **Close menembus level X ke atas** = `c > X`. "Kena / hit" = harga menyentuh level (wick boleh).
- Semua detektor adalah fungsi murni: `candles[] → zona/sinyal[]`, dipakai sama persis untuk live
  dan backtest. Detektor hanya memakai candle yang **sudah close** (tidak repaint).

---

## 1. Market Structure (HH, HL, LH, LL)
**Sumber:** Materi 1

**Definisi dari materi:** market structure adalah kelanjutan trend bullish atau bearish, untuk
melihat arah trend jangka panjang/pendek tergantung timeframe. Trend dianggap lanjut **selama tidak
break low-nya (bullish) atau high-nya (bearish)**.
- Bullish: rangkaian **HH** (Higher High) dan **HL** (Higher Low).
- Bearish: rangkaian **LH** (Lower High) dan **LL** (Lower Low).
- (Di gambar ada typo: "LH itu Higer Low", dan beberapa low di chart bullish ditulis "LH". Yang
  dimaksud jelas HL / Lower High.)

**Aturan deteksi:**
1. Cari **swing high/low** (pivot). Swing high di `i` jika `h[i]` > high `k` candle di kiri dan `k`
   candle di kanan. Swing low sebaliknya. Pivot baru terkonfirmasi setelah `k` candle berikutnya close.
2. Swing dilabeli relatif terhadap swing sejenis sebelumnya:
   - high > high sebelumnya → **HH**, selain itu → **LH**
   - low > low sebelumnya → **HL**, selain itu → **LL**
3. Trend = **bullish** selama belum ada close di bawah HL terakhir; **bearish** selama belum ada close
   di atas LH terakhir (perubahannya dibahas di §2).

❓ **Q1. Ukuran swing (`k`).** Materi tidak menentukan swing mana yang dihitung. Usulan default: `k = 3`
   untuk semua TF (configurable per TF). Swing dengan pergerakan kecil tetap dihitung.

---

## 2. Break of Structure (BOS) = pembalikan trend
**Sumber:** Materi 1 – BOS

**Definisi dari materi:** kalau market sudah membentuk structure bullish/bearish lalu terjadi break,
trend **berbalik arah**. Contoh di gambar: "Terjadi break antara HH karena tidak bisa mempertahankan
area HH-nya, maka berubah menjadi LH" (bullish → bearish), dan sebaliknya untuk LH → HL
(bearish → bullish).

> Catatan istilah: di materi, BOS berarti **pembalikan trend** (di ICT umum ini disebut CHoCH).
> Break searah trend (HH baru) di materi cukup disebut "trend lanjut". Program memakai istilah materi.

**Aturan deteksi:**
- **Bullish → bearish (BOS bearish):** trend bullish, market gagal membuat HH baru (swing high
  terakhir jadi **LH**), lalu ada **close di bawah HL terakhir**. Level break = HL tersebut.
- **Bearish → bullish (BOS bullish):** trend bearish, gagal membuat LL baru (swing low terakhir jadi
  **HL**), lalu ada **close di atas LH terakhir**.

❓ **Q2. Break pakai close atau cukup wick?** Usulan default: **close** (body menembus level).
❓ **Q3. Apakah LH (gagal HH) wajib terbentuk dulu?** Bagaimana kalau harga langsung close di bawah HL
   dari HH? Usulan default: **tidak wajib**. Close di bawah HL terakhir sudah dianggap BOS bearish.

---

## 3. Order Block (OB) — POI utama
**Sumber:** Materi 2 – OB, penjelasan user di chat

**Definisi dari materi:**
- **Short:** "carilah satu candle **paling tinggi** sebelum candle itu turun, dengan lidi/wick
  **lebih panjang dari wick candle sebelumnya**."
- **Long:** "carilah satu candle setelah candle itu terbang [dari titik terendah] dengan lidi/wick
  **lebih panjang dari wick candle sebelumnya**."
- "Perhatikan wick-nya lebih panjang dari candle sebelumnya, maka itu adalah OB atau support."
- OB juga berfungsi sebagai support/resistance (tidak ada bedanya).
- **User:** OB dilihat dari bentuk candle. Wick candle terakhir lebih panjang = **ada liquidity yang
  tersisa di situ**.

**Aturan deteksi (bullish OB, bearish kebalikannya):**
Candle `i` adalah **bullish OB** jika:
1. `i` adalah **swing low** (titik terendah lokal, lihat §1), dan
2. wick bawahnya lebih panjang dari candle sebelumnya: `loWick[i] > loWick[i−1]` **dan**
   `l[i] < l[i−1]` (lidinya menjulur lebih jauh), dan
3. **warna candle searah dengan arah OB: bullish OB = candle hijau (`c > o`)**, bearish OB = candle
   merah (`c < o`). Dikonfirmasi user. Di semua diagram materi, candle OB bullish berwarna hijau
   dengan wick bawah panjang (menolak turun lalu close naik), dan candle OB bearish berwarna merah
   dengan wick atas panjang. OB valid di Materi 3 juga begitu. Jadi:
   - bullish OB: `c[i] > o[i]` dan wick **bawah** panjang
   - bearish OB: `c[i] < o[i]` dan wick **atas** panjang
4. setelah itu harga naik meninggalkan OB (lihat Q6).

**Zona OB bullish:**
- **Garis OB / level entry = `bodyLo[i]`** (di gambar garis OB ditarik di ujung body, bukan di ujung wick).
- **Zona wick = `[l[i], bodyLo[i]]`.** Ini sisa **liquidity** menurut user (lihat §10).
- Bearish OB: candle **swing high** dengan `upWick[i] > upWick[i−1]` dan `h[i] > h[i−1]`; garis
  OB = `bodyHi[i]`, zona wick = `[bodyHi[i], h[i]]`.

**Status OB:**
- **fresh**: belum disentuh lagi sejak terbentuk.
- **hit**: harga kembali menyentuh garis OB (`l ≤ bodyLo[i]` untuk bullish).
- **invalid**: ada close yang menembus ujung wick OB (`c < l[i]` untuk bullish).

❓ **Q4. "Wick lebih panjang" itu berarti apa?** (a) panjang wick-nya lebih panjang, (b) ujung wick-nya
   menjulur lebih jauh, atau (c) dua-duanya. Usulan default: **(c) dua-duanya**.
✅ **Q5. Warna candle OB → ngaruh** (jawaban user): bullish = hijau, bearish = merah (poin 3 di atas).
❓ **Q5b. Candle sebelum OB harus berlawanan warna?** Di diagram materi, sebelum OB bullish ada candle
   merah dan sebelum OB bearish ada candle hijau. Usulan default: **tidak wajib**, tapi memberi
   +1 skor kalau ada.
❓ **Q5c. Kalau candle doji** (body sangat kecil, misal < 10% range)? Usulan default: **tidak dihitung
   sebagai OB**.
❓ **Q6. Seberapa jauh harga harus meninggalkan OB** supaya OB dianggap sah? Usulan default:
   OB sah kalau dalam 5 candle setelahnya ada close di atas `h[i]` (bullish) / di bawah `l[i]` (bearish).
❓ **Q7. Entry & SL.** Materi bilang "limit entry di OB". Usulan default: limit di garis OB (ujung
   body), **SL di luar ujung wick + buffer kecil** (0,1% atau 0,1×ATR).

---

## 4. Fair Value Gap (FVG) — data pendukung OB
**Sumber:** Materi 2 – FVG

**Definisi dari materi:** gap/ruang di antara **tiga candle** yang wick-nya tidak tertutup.
- FVG **hanya data pendukung**: limit entry **di OB, bukan di FVG**, karena FVG pasti tertembus
  (FVG tertembus lalu harga mengambil OB-nya).
- **OB tanpa FVG = OB low probability.** Biasanya market menembus OB itu. "FVG adalah pondasi
  dari suatu rumah."
- Di gambar, **candle 1 FVG = candle OB**.

**Aturan deteksi** (candle `j`, `j+1`, `j+2`):
- **FVG bullish:** `l[j+2] > h[j]`, zona = `[h[j], l[j+2]]`
- **FVG bearish:** `h[j+2] < l[j]`, zona = `[h[j+2], l[j]]`
- FVG dianggap "milik" sebuah OB jika terbentuk saat harga meninggalkan OB itu (lihat Q8).
- Status: fresh, lalu **filled** begitu harga masuk ke zona gap.

❓ **Q8. FVG harus mulai persis dari candle OB, atau boleh beberapa candle setelahnya?** Usulan default:
   candle pertama FVG = candle OB, atau maksimal 2 candle setelahnya.
❓ **Q9. Ukuran minimum FVG?** Gap yang sangat kecil bisa jadi noise. Usulan default: minimal 0,05% dari
   harga (configurable).

---

## 5. RBS & SBR (Resistance become Support / Support become Resistance)
**Sumber:** RBS, SBR

**Definisi dari materi:**
- **RBS:** area yang sebelumnya **resistance** lalu **tertembus**, berubah menjadi **support**.
  Dipakai sebagai area entry **buy**; market sering respect. Kalau ada FVG, probabilitasnya naik.
- **SBR:** kebalikannya. Support tertembus jadi resistance, dipakai sebagai area entry **sell/short**.
- Tanpa FVG: probabilitas turun, bisa direspect bisa juga ditembus.

**Aturan deteksi (RBS; SBR kebalikannya):**
1. Level resistance `R` = swing high (lihat Q10).
2. **Break:** ada candle yang **close di atas `R`**. Mulai saat itu `R` menjadi zona **RBS**.
3. **Retest/hit:** harga turun kembali menyentuh `R` dari atas.
4. **Invalid:** ada close di bawah `R` setelah break.
5. RBS dapat tanda "+FVG" kalau candle break-nya membentuk FVG bullish (definisi §4).

❓ **Q10. Level resistance diambil dari mana?** (a) ujung wick swing high, (b) ujung body swing high,
   atau (c) bebas termasuk garis OB. Di gambar garisnya kelihatan di area body/close. Usulan default:
   **(b) ujung body (`bodyHi`) swing high**.

---

## 6. OCL (Open Close Candle) & OCL Break
**Sumber:** Materi 2 – OCL + contoh "OCLBREAK BUY" dari user
(2026-11-11)

**Definisi:**
- **OCL:** candle `i` close lalu candle `i+1` **berwarna sama** melanjutkan dari situ. Level = `close[i]`,
  area OCL = body candle `i`. Pasangan hijau = OCL bullish (support/buy), pasangan merah = OCL
  bearish (resistance/sell). **Ukuran body tidak dipakai sebagai syarat.**
- **OCL Break Buy** (kata user): "jika body candle bullish berhasil menembus dan closing melewati area
  OCL Bearish". Artinya, setelah OCL bearish ada candle **hijau** yang `close > open[i]` (melewati seluruh
  body candle merah). POI buy ada di level `close[i]`. **OCL Break Sell** kebalikannya.
- Break harus terjadi "oleh candle setelahnya": maksimal `oclBreakMaxCandles` (default 5) candle.
- Hit = harga kembali ke level. Invalid = close menembus level berlawanan arah POI. OCL biasa yang
  ditembus close tanpa memenuhi syarat break dianggap invalid.
- Market biasanya mengambil OCL **terdekat** dengan harga, jadi di chart cuma yang terdekat yang digambar.
- **Timeframe (user, 2026-11-11):** OCL biasa **hanya untuk HTF (1d, 1w)**. Di 4h ke bawah **hanya OCL
  Break** yang dipakai. Setting `oclPlainTimeframes`.

✅ Q11 dijawab user lewat contoh gambar (definisi lama "body ≥ 60%" dibuang).

---

## 7. QM (Quasimodo)
**Sumber:** Materi 2 – QM

**Definisi dari materi:** QM yang bagus berbentuk **tiga gunung**. Gunung ketiga "pasti akan nurut"
dan menjadi area entry. Garis QM ditarik di level **gunung satu**. Contoh real: harga kembali ke garis
QM lalu turun (sell).

**Penjelasan user (2026-11-11):** gunung pertama diukur dari **body**, bukan wick. Body gunung kedua
biasanya **menembus wick** gunung pertama. Di gunung ketiga, QM kena di **titik body gunung pertama**
(seperti garis OB).

**Aturan deteksi (QM sell; QM buy kebalikannya):**
1. Swing high `H1` (gunung 1), swing low `L1`, swing high `H2 > H1` (gunung 2).
2. **Body `H2` menembus wick `H1`:** `bodyHi[H2] > h[H1]`. Setting `qmRequireBodyBreak`, default
   **wajib**. Bisa dimatikan karena di penjelasan user disebut "biasanya".
3. Setelah `H2`, harga turun membentuk low `L2 < L1` (struktur patah). **Break L1 wajib pakai close body** (ada candle
   yang close di bawah low L1 sebelum L2 terkonfirmasi), bukan wick doang (`smc.qmRequireCloseBreak`, default wajib).
4. **Level entry sell = `bodyHi[H1]`** (body gunung 1). Kena saat harga naik kembali ke level itu (gunung 3).
5. Invalid jika ada close di atas wick `H2`.

✅ **Q12** (`L2 < L1` wajib): ya. ✅ **Q13** dijawab user: level QM pakai **body**, bukan wick.

**Cocok dengan versi internet (riset 2026-11-23, "QM/QML"):** urutan left shoulder (H1) → reaction low (L1) → head (H2 > H1)
→ MSB (L2 < L1) → entry limit di level left shoulder (QML), SL di balik head, invalid kalau head ditembus. Mirip head and
shoulders, tapi neckline (L1) **sudah jebol sebelum** right shoulder, jadi entry-nya limit di right shoulder (bukan breakout
neckline). Yang disesuaikan dari internet: MSB harus konfirmasi close body (sama seperti BOS §2). Yang tetap ikut materi/user:
level di **body** H1 (internet campur wick/body) dan body H2 wajib nembus wick H1 (lebih ketat dari internet).

---

## 8. Konfirmasi Entry: POI hit POI → OB valid
**Sumber:** Materi 3 bullish,
bearish,
RBS H4 → OB valid M15, penjelasan user

**Definisi dari materi:**
- "OB hit OB dan menciptakan OB baru", atau "POI hit POI menciptakan POI baru".
- OB pertama yang di-marking kena (hit), lalu dari situ terbentuk **OB baru = OB valid**.
  **Limit entry di OB valid.** OB biasa (yang pertama) diabaikan.
- Ada atau tidak ada FVG bebas. Market biasanya tetap respect OB valid, tapi kalau ada FVG lebih bagus.
- Bisa lintas timeframe: **RBS H4 (sudah kena) → OB valid M15** lalu langsung limit entry.
- **User:** OB valid adalah candle yang **wick terakhirnya lebih panjang**, artinya masih ada
  liquidity di bawah/atas body-nya.

**Aturan deteksi (bullish; bearish kebalikannya):**
1. Ada POI bullish aktif `P` di TF tinggi (OB bullish / RBS / QM buy / OCL; lihat Q14).
2. Harga **hit** `P` (wick menyentuh garis `P`) tanpa close menembus batas invalid `P`.
3. Di TF entry, sejak hit itu terbentuk **OB bullish baru** (§3) yang wick-nya menyentuh/dekat zona
   `P` dan body-nya tetap di atas garis `P` → ini **OB valid**.
4. **Sinyal:** limit buy di garis OB valid (`bodyLo`), SL di luar wick OB valid (§3 Q7).
   Kalau ada FVG dari OB valid, beri tanda "+FVG" (prioritas lebih tinggi).
5. OB valid kedaluwarsa kalau invalid (close menembus wick-nya) atau tidak di-retest dalam N candle.

❓ **Q14. Pasangan timeframe.** Contoh di materi: H1→H1 (OB valid di TF yang sama) dan H4→M15. Usulan
   default: **POI di 4h & 1h, OB valid di 15m** (+ opsi TF sama). Configurable.
❓ **Q15. OB valid harus candle yang menyentuh POI itu sendiri, atau boleh OB baru dalam beberapa
   candle setelah hit?** Di diagram, candle yang menyentuh = candle OB valid. Di contoh real ada
   jeda beberapa candle. Usulan default: OB valid boleh terbentuk sampai **10 candle TF entry** setelah hit.
❓ **Q16. Filter arah trend.** Apakah buy hanya saat structure (§1) bullish di TF POI? Materi tidak
   bilang. Usulan default: **tidak difilter**. Arah trend ditampilkan sebagai info dan skor.
❓ **Q17. Take profit.** Materi tidak membahas TP. Contoh kotak di gambar RR-nya sekitar 1:2 sampai
   1:4. Usulan default: TP di swing berlawanan terdekat / liquidity terdekat (§10), **minimal RR 1:2**.
   Kalau tidak tercapai, setup di-skip.

---

## 9. Hierarki POI & skor
Dari materi: OB valid > OB biasa. POI dengan FVG > tanpa FVG. Market mengambil POI **terdekat**.
OB tanpa FVG = low probability.

Usulan skor (untuk ranking kandidat, bukan auto-order):
| Faktor | Skor |
|---|---|
| OB valid (konfirmasi §8) | +3 |
| Punya FVG | +2 |
| POI dari TF lebih tinggi (4h/1h) | +1 |
| Searah trend TF POI (§1) | +1 |
| OB tanpa FVG | −2 |

❓ **Q18.** Setuju skor ini, atau ada urutan lain dari pengalaman lo?

---

## 10. Liquidity (permintaan user)
**Sumber:** penjelasan user di chat ("wick terakhir lebih panjang = ada liquidity yang nyisa").
Materi tidak punya bab khusus liquidity.

**Usulan aturan:**
- **Wick liquidity (dari definisi user):** zona wick OB dan OB valid, misalnya `[l[i], bodyLo[i]]`
  untuk bullish. Zona ini dianggap **liquidity yang belum diambil** sampai harga menembus ujung wick
  (`l < l[i]`). Setelah itu ditandai **swept**.
- **Ditampilkan di chart** sebagai area arsir tipis di bawah/atas garis OB. Statusnya: aktif → swept.

❓ **Q19. Selain wick OB, mau juga tampilkan liquidity swing** (swing high/low yang belum disapu,
   termasuk equal high/low)? Ini konsep ICT umum, **tidak ada di materi**. Usulan default: **ya,
   tampilkan tapi pisah layer** (bisa dimatikan), dan **tidak dipakai di skor** kecuali lo minta.

---

## 11. Inducement — riset sendiri, DI LUAR materi (user 2026-11-23: "materi masih basic, kita improve sendiri")
**Sumber:** pengalaman user + konsep SMC/ICT umum dari internet (LuxAlgo, TradingView education, innercircletrader.net).
Semua di bawah ini **tag konfluensi (filter, tanpa skor)** + satu model (M9). Hasil lab di `docs/entry-v2.md §23`.
Kode: `src/main/strategy/inducement.ts` (`InducementIndex`), tag ditambahkan di `finalize` (`setups.ts`).

- **Umpan / bait (definisi user):** POI searah yang terbentuk **tanpa origin** (tidak menyapu liquidity, tidak menyentuh POI
  TF lebih besar), terletak **di depan** POI B (harga ketemu duluan, ≤ `smc.idmWindowAtr` × ATR TF B), dan sudah **disentuh**
  setelah B aktif, ≤ `smc.baitDays` hari sebelumnya. Menurut user, POI B di belakang umpan = POI high probability.
  Tag `baitTaken`. Catatan: harga yang datang ke B dari atas pasti melewati semua POI di antaranya, jadi saat B kena,
  `baitTaken` = "ada POI tanpa origin di depan B dalam jendela itu".
- **IDM ketat (strict inducement):** pullback internal pertama (pivot `ltfPivot` di TF B) dari leg yang meninggalkan B, di depan
  garis B, sudah dikonfirmasi lalu **disapu** sebelum keputusan. POI yang kena tanpa pullback seperti itu = dia sendiri
  pullback pertama (= inducement-nya). Tag `idmSwept`.
- **Extreme POI:** tidak ada POI searah aktif lain (TF ≥ 1h) di **belakang** B dalam `idmWindowAtr` ATR. Tag `extremePoi`.
- **Decisional POI:** IDM ketat sudah disapu dan tidak ada POI searah aktif (≥ 1h) di antara B dan IDM. Tag `decisionalPoi`.
- **M9 umpan → POI di belakangnya:** POI B (`smc.m9PoiTimeframes` 1h/4h/1d, jenis `smc.m9Kinds` OB/QM = order block, bukan RBS/SBR) belum disentuh,
  umpan di depannya sudah kena (≤ `baitDays`) → limit di garis B saat close 15m ≤ `m9NearR` × risk, SL di balik ujung B
  (+0,1 ATR, sama seperti M8), exit bertingkat + trailing tanpa TP (`m9TpR` 0). Default shadow paper.

### M10: POI HTF kena → QM konfirmasi di TF kecil (user 2026-11-23: "POI 1d/4h, lalu kebentuk QM di 1m / 3m / 5m")
POI induk sama seperti M0 (bot: 4h/1d) kena, lalu dalam `smc.m10WindowMin` (240 menit) terbentuk QM (§7, break pakai close)
di **1m / 3m / 5m** (`smc.m10Timeframes`, 3m = resample 1m, pivot `smc.m10Pivot`) yang head-nya terbentuk setelah POI kena dan
masuk ke POI (≤ `obValidNearPct`). Diambil QM yang paling cepat terkonfirmasi dari semua TF itu. Limit di level QM (body gunung 1),
SL di balik head + `slBufferPct`, invalid kalau close tembus head. Bot baru melihatnya di close 15m berikutnya (screener jalan
per 15m), jadi entry bisa telat maksimal ±15 menit dibanding kalau dipantau langsung di 1m.

### Konfirmasi setelah POI kena (user 2026-11-23: "gas implement cisd, smt, ifvg"), `strategy/confirm.ts`
Semua berupa **tag filter** (tanpa skor). Dihitung saat setup diketahui (`known`), cuma memakai candle yang sudah close.
- **CISD** (`cisd`, change in state of delivery): di TF entry (15m), close menembus **open candle pertama dari run candle
  lawan terakhir**. Long: ada run candle merah, lalu candle yang close di atas open candle merah pertama run itu. Short dibalik.
  Tiap run cuma dihitung sekali. Harus terjadi **setelah POI kena** dan maksimal `smc.confirmLookback` (16) candle sebelum `known`.
- **SMT divergence** (`smt`): di 1h, koin dibandingkan dengan BTC (BTC dibandingkan dengan ETH). Dalam `smc.smtWindowH` (6) jam
  terakhir, **cuma salah satu** yang menembus low (long) / high (short) `smc.smtRangeH` (24) jam sebelumnya. Arahnya bebas
  (koin sweep & BTC tahan, atau sebaliknya). Data bolong → tidak dinilai.
- **Inverse FVG** (`ifvg`): FVG di TF entry yang **di-close tembus** (body close lewat sisi jauhnya) berbalik fungsi. FVG bearish
  yang di-close di atas = IFVG bullish (dan sebaliknya), dicek sampai 96 candle setelah FVG terbentuk. Jendelanya sama dengan CISD.
- Model yang limit-nya dipasang **sebelum** POI kena (M8/M9) hampir tidak pernah dapat CISD/IFVG, karena konfirmasinya belum ada
  saat order dipasang.

### Konfluensi OR (user 2026-11-23: "jangan wajib semua, tambahin konsep or")
Tiap model punya dua list: `bot.modelConfluence` (**wajib**, semua harus ada) dan `bot.modelConfluenceAny` (**salah satu**,
minimal satu ada; kosong = tidak ada syarat). Profil koin punya `anyConfluence`. Backtest punya filter chip "Salah satu (OR)".

Kandidat berikutnya (belum dibuat): BPR, mitigation/rejection block, OTE.

---

## Ditampilkan di chart (setelah implementasi)
- Label swing HH/HL/LH/LL dan marker BOS (§1–2)
- Kotak OB & **OB valid** (garis entry di ujung body) + zona wick **liquidity** (§3, §8, §10)
- Kotak FVG (§4), garis RBS/SBR (§5), OCL/OCL Break (§6), garis QM (§7)
- Status per zona: fresh / hit / invalid / swept. Zona yang invalid otomatis disembunyikan.
- Toggle per layer.

## Tidak ada di materi (tidak diimplementasikan kecuali diminta)
CHoCH sebagai istilah terpisah, premium/discount & fibonacci, killzone/sesi, liquidity BSL/SSL
klasik (opsional lewat Q19), mitigation/breaker block, aturan TP/SL resmi (lewat Q7/Q17).

**Waktu:** materi tidak membahas sesi atau jam buka harian, jadi semua candle tetap pakai **UTC**
(sesuai Binance). Pertanyaan terbuka "UTC vs New York" di CLAUDE.md dianggap **selesai: UTC**.
