# Video README (`docs/media/`)

GIF (tampil langsung di README GitHub) + WebM (kualitas penuh), dirender dengan Chromium bawaan Electron: tanpa ffmpeg / Pillow.
GIF di-encode sendiri (palet tetap 64 warna, tiap frame cuma bagian yang berubah), WebM lewat `MediaRecorder` (real time).

1. Ekspor data studi kasus (DB read-only: candle 15m, cerita POI saat setup muncul, event bot) untuk id `bot_trades`:

   ```bash
   node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild scripts/videos/export.ts --bundle --platform=node \
     --format=cjs --alias:@shared=./src/shared --external:better-sqlite3 --external:electron --outfile=video_export.cjs
   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron video_export.cjs <trading.db> cases.json <id-untung> <id-impas> <id-rugi>
   rm video_export.cjs
   ```

2. Render (satu scene per proses; scene: `cara-kerja`, `siklus-order`, `kasus-0`, `kasus-1`, `kasus-2`):

   ```bash
   for s in cara-kerja siklus-order kasus-0 kasus-1 kasus-2; do
     node_modules/.bin/electron scripts/videos/render.cjs cases.json docs/media $s
   done
   ```

   `--preview=5,13,30` menyimpan PNG di detik itu saja (cek tampilan tanpa render penuh).

Teks pelajaran tiap kasus ada di `render.html` (`LESSON`), ditulis manual dari cerita POI dan event bot.
