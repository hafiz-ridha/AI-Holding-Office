# AI Virtual Office — Visualisasi Pixel Art (v2)

## 1. Audit frontend saat ini (sebelum perubahan)

| Aspek | Temuan |
|---|---|
| Framework | Tidak ada. Vanilla JS ES modules, tanpa bundler/build step. CSS tunggal (`public/css/app.css`). |
| Routing | Hash router di `public/js/app.js` (`#/office`, `#/business/:id`, …); tiap view mengekspor `render(root, params, ctx)`; `ctx.poll()` berhenti saat tab tersembunyi/berpindah halaman. |
| Kantor v1 | `public/js/office/engine.js` + `sprites.js`: satu peta gabungan (Holding Management, Meeting Room, Shared Services, pod per bisnis), furnitur digambar prosedural dengan `fillRect`, karakter prosedural per palet avatar. |
| API yang dipakai | `GET /api/office` (karyawan + state turunan dari tugas, bisnis), `GET /api/businesses/:id`, `/activity`, `GET /api/tasks/:id`. |
| Kekurangan | Hanya satu peta (tidak bisa memilih kantor bisnis), tidak ada state THINKING/ERROR, tidak ada panel detail karyawan (provider, model, token, riwayat), klik meja/ruang meeting belum ada, tidak ada viewport/zoom (peta selalu diskalakan ke lebar layar), furnitur bukan sprite sheet. |

## 2. Desain v2

```
Browser (semua rendering di klien; server hanya mengirim JSON kecil)
  views/office.js  ── pemilih kantor: [Kantor Pusat] [Wins Court] [Coffee] … (dari DB, tanpa hardcode)
        │                panel samping: detail karyawan / meja / koordinasi meeting / info bisnis
        ▼
  office/engine.js ── kamera viewport (pan/zoom), rAF ≤30 FPS (≈4 FPS saat diam), pause saat tab/elemen tak terlihat
  office/scenes.js ── generator tata letak: HQ (ruang per fungsi) & kantor bisnis (dibangun lazy saat dibuka)
  office/sprite-atlas.js ── memuat 1 sprite sheet PNG lokal (?v=hash isi) + peta frame dari modul atlas-data.js (dihasilkan skrip)
  office/sprites.js── karakter prosedural dari palet avatar (tetap bisa diubah di AI Employees)
        ▲
  GET /api/office                      state nyata per karyawan (+ lokasi meeting, bisnis yang dikunjungi)
  GET /api/office/employees/:id        panel: bisnis, status, tugas aktif, riwayat, provider/model, token, hasil
  GET /api/office/coordination?...     panel ruang meeting: koordinasi aktif & riwayat (dari task_logs)
```

### State visual ⇄ data nyata (tidak ada animasi palsu)

| State | Sumber data backend | Visual |
|---|---|---|
| IDLE | tidak ada tugas aktif | berdiri di samping meja (napas pelan), monitor mati |
| PENDING (bagian IDLE) | ada tugas `pending/assigned` menunggu antrean | duduk santai + ikon jam pasir |
| THINKING | panggilan AI sedang berjalan untuk fase `planning` (Group CEO/Business Manager menganalisis) | duduk di meja + bubble berpikir |
| WORKING | panggilan AI sedang berjalan untuk subtugas/tugas langsung | duduk mengetik, monitor menyala |
| WALKING | transisi posisi saat state berubah | animasi jalan menuju tujuan |
| MEETING | fase `synthesizing` (pemimpin + karyawan yang hasilnya digabung) | duduk di meja rapat ruang yang relevan |
| COMPLETED | tugas selesai ≤15 detik terakhir | lompat kecil + tanda centang |
| ERROR | tugas gagal ≤30 menit terakhir, atau tugas tertunda karena AI tidak tersedia | ikon peringatan merah |

Animasi berjalan hanya berdasarkan perubahan state dari server. Tidak ada karakter yang mengetik atau berjalan acak tanpa tugas.

### Kantor

- **Kantor Pusat (Holding)**: CEO Office, Meeting Room, Business Managers (satu meja per manager, bendera warna bisnis),
  Finance, Secretary/Reception, Research Library, Developer Lab, HR, Marketing Hub, Lounge.
  Shared Services ditempatkan sesuai peran. Peran baru/kustom masuk ke ruang Shared Services umum.
- **Kantor bisnis** (satu per bisnis aktif, otomatis dari DB): ruang Business Manager dengan papan nama bisnis,
  area kerja tim (meja bertambah sesuai jumlah staf), meja rapat bisnis, dan meja tamu tempat Shared Services muncul
  **hanya saat** sedang mengerjakan tugas untuk bisnis tersebut.
- Meeting holding tampil di Meeting Room pusat; meeting bisnis tampil di meja rapat kantor bisnis.
  Karyawan yang sedang rapat di kantor lain ditandai "rapat di …" di mejanya.

### Performa

- Satu file PNG terkompresi (`public/assets/office-atlas.png`) dibuat oleh `scripts/build-office-atlas.mjs`
  (tanpa dependency; encoder PNG memakai `zlib` bawaan Node). Disajikan lokal dengan cache browser.
- Latar (lantai, dinding, furnitur) dirender sekali per kantor pada resolusi logis ke offscreen canvas, lalu
  hanya area viewport yang di-blit per frame. Karakter/ikon di luar viewport tidak digambar.
- Kantor bisnis baru dibangun saat dibuka pertama kali (lazy) dan disimpan di cache halaman.
- Server tidak merender apa pun; beban server hanya polling JSON setiap 2 detik selama halaman kantor terbuka.

## 3. File yang diubah/dibuat

| File | Perubahan |
|---|---|
| `scripts/build-office-atlas.mjs` | baru: generator sprite sheet PNG + JSON |
| `public/assets/office-atlas.png`, `.json` | baru: aset hasil generator |
| `public/js/office/sprite-atlas.js` (dulu `atlas.js`), `atlas-data.js`, `scenes.js` | baru |
| `public/js/office/engine.js` | ditulis ulang (viewport, kamera, state baru, hit-test meja/ruang) |
| `public/js/office/sprites.js` | ditambah pose/ikon; API lama tetap (dipakai halaman lain) |
| `public/js/views/office.js` | pemilih kantor, panel interaktif, info bisnis |
| `public/css/app.css` | gaya panel & toolbar kantor |
| `src/routes/holding.js` | `/api/office` diperkaya; endpoint detail karyawan & koordinasi (tambahan, tidak mengubah respons lama) |
| `test/08-office.test.js` | baru: mapping state ⇄ data nyata, panel, koordinasi, aset PNG valid |

## 4. Visual Enhancement (v3) — hanya frontend

Backend, database, task engine, logika karyawan, multi-business, integrasi AI/Telegram, dan autentikasi **tidak diubah**.
Semua data berasal dari endpoint yang sudah ada.

### Fase & hasil uji

| Fase | Isi | Diuji dengan |
|---|---|---|
| 1. Lantai, dinding, furnitur | Wallpaper per fungsi ruangan (+ jendela bertirai di bidang dinding kosong), 7 tekstur lantai, karpet 9-slice, papan nama kayu, kusen pintu + keset, bayangan, furnitur khusus per ruangan (CEO: rak buku, lemari trofi, papan KPI; Finance: brankas, lemari arsip; Developer Lab: server rack, panel status; Research: rak buku, meja riset, globe; HR, Marketing, Lounge, dst.). Penempatan dengan cek tabrakan. | `scene.collisions()` kosong di semua kantor; tes `10-office-visual` (5 tes) |
| 2. Karakter & animasi status | Napas + sesekali menoleh (IDLE), mengetik + monitor berkedip + ikon gear (WORKING), bubble tiga titik + ikon AI (THINKING), jalan 4 arah mengikuti grid dengan kecepatan tetap, rapat (pemimpin berdiri), lompat + centang (COMPLETED), ikon peringatan (ERROR), **RESTING** di sofa Lounge. | uji tugas nyata lewat mock provider: lounge → meja → kerja → selesai |
| 3. Interaksi | Tooltip hover, panel karyawan melayang bergaya pixel-art, semua ruangan bisa diklik dengan panel sesuai fungsi, meja → panel pekerjaan. | 16 panel ruangan (HQ + bisnis) dirender tanpa error |
| 4. Visualisasi tugas langsung | Status bar atas, badge jumlah karyawan aktif per ruangan, notifikasi (mulai kerja, selesai, gagal/tertunda, rapat dimulai, approval baru). | notifikasi muncul dari perubahan state nyata |
| 5. Lingkungan & kamera | Siang/malam (pagi, siang, sore, malam; jam browser), cahaya jendela, lampu ruangan menyala malam hari, tanaman bergoyang, jam dinding sesuai waktu, LED server, panel status Developer Lab mengikuti status sistem, minimap, zoom/drag/reset/fit, suara opsional (default mati). | render 4 periode, minimap, ponsel/tablet |

### RESTING (tidak ada di backend)

Diturunkan di browser dari data nyata: karyawan berstatus IDLE yang aktivitas tugas terakhirnya tercatat ≥ 20 menit lalu
(`updated_at` tugas terakhir sebagai pelaksana atau manager, dari `GET /api/tasks?limit=100` yang disegarkan tiap 60 detik,
ditambah perubahan status yang terlihat selama halaman terbuka). Mereka duduk santai di kursinya sendiri (20–45 detik) lalu
sesekali jalan-jalan sebentar di ruangannya. Karyawan tanpa aktivitas tercatat (instalasi baru) berstatus IDLE.

### IDLE: jalan-jalan acak di ruangan sendiri

Setiap ruangan punya grid jalan 8 px (dihitung sekali per kantor): sel diblokir bila kaki karakter menyentuh meja,
furnitur, tanaman, atau meja rapat. Karyawan IDLE memilih titik acak yang terjangkau (24–150 px) di ruangannya, berjalan
lewat jalur terpendek (BFS, hanya horizontal/vertikal, kecepatan tetap), berhenti 3–9 detik sambil menoleh, sesekali
kembali ke samping mejanya. Rute karena tugas/rapat memakai grid yang sama di dalam ruangan, lalu pintu–koridor–lorong.
Karyawan tidak pernah keluar dari ruangannya tanpa tugas atau rapat nyata. Lounge/Pantry kini hanya dekorasi.
Terverifikasi di browser: semua pintu bebas; setiap tempat berdiri & kursi terjangkau (juga tata letak banyak baris).

### Panel ruangan → endpoint

| Ruangan | Isi | Endpoint |
|---|---|---|
| CEO Office | ringkasan grup, kinerja bisnis, tugas aktif, approval menunggu | `/api/overview`, `/api/businesses`, `/api/tasks?status=active&kind=top`, `/api/approvals?status=pending` |
| Meeting Room | rapat aktif & riwayat (jadwal rapat tidak dicatat sistem, jadi tidak ditampilkan) | `/api/office/coordination` |
| Business Managers | bisnis, status manager, kinerja, laporan terakhir | `/api/businesses`, `/api/office` |
| Group Finance | pendapatan, pengeluaran, arus kas bersih bulan ini per bisnis, tugas keuangan | `/api/businesses/:id/finance`, `/api/tasks?employee_id=` |
| Secretary & Reception | dokumen terbaru, jadwal laporan harian Telegram, tindak lanjut (approval, antrean) | `/api/businesses/:id/documents`, `/api/telegram`, `/api/approvals`, `/api/tasks?status=pending` |
| Research Library | laporan, tugas riset, jumlah dokumen per bisnis, tugas berkata kunci "kompetitor" | `/api/reports`, `/api/tasks` |
| Developer Lab | tugas pengembangan, RAM/heap/uptime, antrean, status API/provider/Telegram, error AI & tugas gagal | `/api/overview`, `/api/health`, `/api/usage`, `/api/tasks?status=failed` |
| HR | daftar karyawan, kinerja (dari 100 tugas selesai terakhir), beban kerja (antrean), tautan rekrutmen | `/api/office`, `/api/tasks?status=completed` |
| Marketing Hub | tim, tugas berkata kunci "kampanye", tugas marketing (kalender konten tidak ada di sistem) | `/api/tasks` |
| Shared Services | aktivitas departemen bersama, tugas lintas bisnis | `/api/tasks?employee_id=` |
| Lounge / Pantry | jumlah per status, karyawan yang tidak bertugas, info kantor | `/api/office` |
| Kantor bisnis | ringkasan bisnis (ruang manager), tim & tugas aktif (area kerja), Shared Services yang berkunjung (meja tamu) | `/api/businesses/:id`, `/api/tasks?business_id=` |

Panel ruangan disegarkan tiap 10 detik (bukan tiap 2 detik) karena menggabungkan beberapa endpoint; ringkasan
`/api/overview` untuk status bar di-cache 10 detik.

### File v3

| File | Perubahan |
|---|---|
| `scripts/build-office-atlas.mjs`, `public/assets/office-atlas.*` | 165 frame (9,8 KB PNG): wallpaper ×7 gaya, lantai ×7, karpet ×3 warna, furnitur per ruangan, ikon gear/AI/rest, kilau |
| `public/js/office/scenes.js` | furnishing per ruangan dengan cek tabrakan, papan nama, karpet, kursi Lounge + lorong, `findCollisions()` |
| `public/js/office/engine.js` | render v2, RESTING, indikator, tooltip/hover, klik ruangan, rute grid, siang/malam, ambient, minimap, nama tanpa tumpang tindih |
| `public/js/office/sound.js` | baru: suara WebAudio opsional (tanpa file audio) |
| `public/js/views/office.js` | status bar, tooltip, panel melayang, notifikasi, RESTING, kontrol minimap/suara |
| `public/js/views/officePanels.js` | baru: panel per ruangan |
| `public/css/app.css` | gaya pixel-art (status bar, panel, tooltip, notifikasi, minimap) |
| `test/10-office-visual.test.js` | baru: tanpa tumpang tindih (3 skenario ukuran), meja deterministik, semua frame tersedia |

## 5. Halaman depan, cuaca & tata letak (v4)

| Bagian | Isi |
|---|---|
| Tata letak | Kanvas mengisi seluruh lebar di kiri kolom Obrolan/Detail, tingginya mengikuti viewport (sejajar dengan kolom obrolan). Minimap mati secara default. Klik ruangan/meja/karakter membuka kartu melayang di dalam kantor. |
| Halaman depan | 10 tile di atas gedung: langit (3), jalan (2), trotoar (1), parkiran (4). Pintu masuk utama di ujung atas lorong kiri; karyawan baru masuk dari sini. |
| Parkiran | Zona motor bergaris: dua baris skuter parkir tegak lurus saling membelakangi lorong (atas tampak belakang, bawah tampak depan), beberapa slot kosong, helm di jok/spion. Zona mobil: bay parkir paralel di sisi gedung, satu pickup double cabin lifted kuning (sudut 3/4 depan, sesuai referensi owner; pixel art orisinal tanpa logo), jalan masuk dari jalan raya (trotoar dipotong, tidak ada lampu/pohon di atasnya). Taman dengan pohon & semak. |
| Waktu | Jam browser: gradasi langit pagi/siang/sore/malam, matahari 06–18 dan bulan 18–06 bergerak sesuai jam, bintang, jendela gedung kota menyala malam hari, lampu jalan menyala saat sore/malam/hujan. Cache langit diperbarui tiap menit. |
| Cuaca | **Otomatis**: Open-Meteo (`api.open-meteo.com`, gratis, tanpa key) untuk kota yang dicari via `geocoding-api.open-meteo.com`; kode WMO → cerah/berawan/hujan/badai; diperbarui tiap 15 menit, data > 3 jam dianggap tidak tersedia. **Manual**: cerah/berawan/hujan/badai. Disimpan di `localStorage` browser. Efek: awan bergerak, hujan + cipratan + genangan, kilat saat badai (hanya di luar gedung), halaman lebih gelap saat mendung/hujan, cahaya jendela berkurang. |
| Performa | Hujan dirender 15 FPS hanya saat halaman depan terlihat (≤170 garis, tanpa state partikel; posisi dari fungsi acak deterministik). Langit & pencahayaan di-cache. |

Perubahan server (bukan logika bisnis): CSP `connect-src` mengizinkan dua domain Open-Meteo agar browser dapat mengambil
cuaca otomatis. `Permissions-Policy: geolocation=()` tetap; lokasi dipilih lewat nama kota, bukan GPS.
