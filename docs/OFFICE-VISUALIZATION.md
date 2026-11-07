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
  office/atlas.js  ── memuat 1 sprite sheet PNG lokal (furnitur, lantai, dinding, ikon) + peta frame JSON
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
- Server tidak merender apa pun; beban server hanya polling JSON setiap 3 detik selama halaman kantor terbuka.

## 3. File yang diubah/dibuat

| File | Perubahan |
|---|---|
| `scripts/build-office-atlas.mjs` | baru: generator sprite sheet PNG + JSON |
| `public/assets/office-atlas.png`, `.json` | baru: aset hasil generator |
| `public/js/office/atlas.js`, `scenes.js` | baru |
| `public/js/office/engine.js` | ditulis ulang (viewport, kamera, state baru, hit-test meja/ruang) |
| `public/js/office/sprites.js` | ditambah pose/ikon; API lama tetap (dipakai halaman lain) |
| `public/js/views/office.js` | pemilih kantor, panel interaktif, info bisnis |
| `public/css/app.css` | gaya panel & toolbar kantor |
| `src/routes/holding.js` | `/api/office` diperkaya; endpoint detail karyawan & koordinasi (tambahan, tidak mengubah respons lama) |
| `test/08-office.test.js` | baru: mapping state ⇄ data nyata, panel, koordinasi, aset PNG valid |
