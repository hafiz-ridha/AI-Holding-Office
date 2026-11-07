# AI Virtual Holding

Kantor virtual AI ringan dan self-hosted untuk **mengelola beberapa bisnis sekaligus**. Group CEO AI membagi
instruksi pemilik ke Business Manager tiap bisnis dan ke Shared Services. Hasil pekerjaan dilaporkan ke dashboard
dan Telegram, dan semua aktivitas tampil di kantor pixel art 2D.

- Satu container Node.js 24 + SQLite. Tidak ada LLM lokal, Redis, atau PostgreSQL.
- Hanya 2 dependency runtime: `fastify` dan `@fastify/static`.
- Hasil pengukuran: RSS ±67 MB saat idle dan ±79 MB puncak saat bekerja (lihat [docs/TESTING.md](docs/TESTING.md)).

Dokumentasi:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): arsitektur, diagram, dependency, keamanan.
- [docs/AUDIT-HOLDING.md](docs/AUDIT-HOLDING.md): audit & strategi migrasi ke struktur holding.
- [docs/DEPLOY-AAPANEL.md](docs/DEPLOY-AAPANEL.md): instalasi, update, backup/restore, troubleshooting di aaPanel.
- [docs/TESTING.md](docs/TESTING.md): hasil uji fungsional, keamanan, restart, dan RAM.

## Fitur

| Area | Isi |
|---|---|
| Holding | Bisnis tanpa hardcode (tambah/ubah/nonaktifkan dari dashboard), logo, industri, Business Manager, tim, task board, knowledge base, keuangan, laporan, aktivitas |
| Organisasi | Owner → Group CEO → Business Manager → staf bisnis; Shared Services (Group Finance, Secretary, Researcher, Developer, HR). Semua karyawan adalah profil yang berbagi satu AI router |
| Orkestrasi | Holding task → Business task → Employee subtask. Group CEO dapat menjawab langsung bila sederhana (hemat API) |
| Isolasi data | `business_id` pada tugas, percakapan, memori, dokumen, laporan, keuangan, log; diuji otomatis terhadap kebocoran antarbisnis |
| AI provider | 16 preset cloud gratis/kredit + 9Router + custom OpenAI-compatible; fallback, cooldown, batas request & token, model default per tingkatan |
| Telegram | Laporan harian holding (sekali per hari, tahan restart), notifikasi tugas/error/persetujuan, perintah `/overview /companies /business <slug> /report /tasks /finance /approvals /task /pause /resume` |
| Kantor virtual | Pixel art top-down orisinal: Kantor Pusat (CEO Office, Meeting Room, Business Managers, Finance, Secretary, Research, Developer, HR, Marketing, Lounge) + satu kantor per bisnis (otomatis dari database). State IDLE/THINKING/WORKING/WALKING/MEETING/COMPLETED/ERROR (+ RESTING dari riwayat tugas) mengikuti data tugas nyata; klik karakter, meja, atau ruangan untuk detail; status bar, notifikasi, siang/malam, minimap |
| Keamanan | Login scrypt, sesi HttpOnly, CSRF, rate limit, CSP ketat (koneksi keluar dari browser hanya ke Open-Meteo untuk cuaca otomatis), API key terenkripsi AES-256-GCM, whitelist Telegram, audit log, persetujuan owner untuk tindakan berisiko (AI tidak pernah mengeksekusi tindakan) |

## Menjalankan secara lokal

Butuh Node.js 24+.

```bash
npm ci
```

```bash
cp .env.example .env
```

Isi `APP_SECRET` (≥32 karakter) dan `ADMIN_PASSWORD` di `.env`, lalu:

```bash
node --env-file=.env --disable-warning=ExperimentalWarning src/server.js
```

Buka http://localhost:3000. Jalankan tes:

```bash
npm test
```

```bash
npm run test:system
```

## Deploy (Docker / aaPanel)

Cara tercepat di VPS (sebagai root, Docker sudah terpasang dari aaPanel App Store):

```bash
curl -fsSL https://raw.githubusercontent.com/hafiz-ridha/AI-Holding-Office/main/scripts/deploy-aapanel.sh -o deploy.sh
```

```bash
bash deploy.sh install --domain office.example.com
```

Update berikutnya cukup `bash deploy.sh update`; ada juga `backup`, `status`, `logs`, `restart`, `stop`.

Cara manual:

```bash
cp .env.example .env && mkdir -p data && sudo chown -R 1000:1000 data
```

```bash
docker compose up -d --build
```

Container hanya mendengarkan di `127.0.0.1:3000`; arahkan reverse proxy aaPanel (HTTPS) ke alamat itu.
Langkah lengkap ada di [docs/DEPLOY-AAPANEL.md](docs/DEPLOY-AAPANEL.md).

## Provider AI yang didukung

Semua diatur dari menu **AI Providers → Katalog provider AI cloud**: klik *+ Tambah*, tempel API key, lalu klik *Test connection*.

| Kategori | Provider |
|---|---|
| Gratis permanen | OpenRouter (model `:free`), Google Gemini, Groq, Mistral AI, SambaNova Cloud, Cohere (trial non-komersial), Cloudflare Workers AI, Z.AI (GLM Flash), Fireworks AI, Alibaba Model Studio (Qwen), LLM7.io, OVHcloud AI Endpoints |
| Kredit / trial | NVIDIA NIM, Cerebras, Hugging Face Inference Providers, Vercel AI Gateway |
| Self-hosted | 9Router (gateway OpenAI-compatible milik Anda) |
| Lainnya | Custom OpenAI-compatible (Together, DeepInfra, dsb. bila Anda punya akun berbayar) |

Batas free tier berubah sewaktu-waktu. Setiap provider punya batas request/menit dan request/hari yang bisa diubah,
dan router otomatis pindah ke model/provider cadangan saat kena 429 atau kuota habis. GitHub Models tidak disertakan
karena free tier-nya dihentikan pada 30-07-2026.

Urutan pemilihan model: model khusus karyawan → model default tingkatan (Group CEO / Business Manager /
Shared Services / staf bisnis) → model default provider default → model fallback → provider cadangan →
tugas ditunda (pending) dengan notifikasi. Jumlah percobaan dibatasi, sehingga tidak ada retry tanpa batas.

## Cara menambahkan bisnis baru

1. **Business Directory** → **+ Tambah bisnis** → isi nama, industri, deskripsi, warna, logo (PNG/JPEG/WebP ≤300 KB).
2. Pilih **Business Manager** (karyawan berperan *Business Manager*) dan centang karyawan yang menangani bisnis itu.
3. Buka bisnis → tab **Knowledge base** (unggah .txt/.md/.csv/.json) dan tab **Keuangan** (catatan atau impor CSV).
4. Bisnis langsung muncul di kantor virtual, laporan Telegram, dan perintah `/business <slug>`.

## Cara menambahkan karyawan AI

**AI Employees** → **+ Tambah karyawan**:

- Isi nama, jabatan, peran (*role key*), dan unit (Shared Services atau Unit bisnis).
- Pilih bisnis yang ditangani, lalu isi kepribadian, system prompt, dan avatar.
- Opsional: provider/model khusus.

Peran menentukan akses data. Misalnya angka keuangan hanya terlihat oleh peran finance, Business Manager, dan Group CEO.
Karyawan tidak memanggil AI kecuali sedang mengerjakan tugas.

## Laporan Telegram

1. Buat bot di @BotFather, salin token.
2. Menu **Telegram**: isi token, Chat ID, dan User ID yang diizinkan. Kirim `/start` ke bot untuk melihat ID Anda. Atur jam laporan (zona waktu default Asia/Jakarta).
3. Klik **Kirim pesan tes**.

Perintah yang tersedia:

| Perintah | Fungsi |
|---|---|
| `/overview` | Ringkasan holding |
| `/companies` | Daftar bisnis + slug |
| `/business <slug>` | Laporan satu bisnis |
| `/report [slug]` | Laporan harian holding / bisnis |
| `/tasks [slug]` | Tugas aktif |
| `/finance` | Keuangan bulan ini per bisnis |
| `/approvals` | Persetujuan yang menunggu |
| `/task <instruksi>` | Tugas ke Group CEO |
| `/task @slug <instruksi>` | Tugas ke Business Manager bisnis tersebut |
| `/status`, `/today`, `/pause`, `/resume`, `/help` | Status, ringkasan hari ini, kontrol antrean |

## Kantor virtual (pixel art)

Menu **AI Virtual Office**:

- Pilih **Kantor Pusat** atau kantor bisnis mana pun lewat tab. Bisnis baru langsung muncul tanpa perubahan kode.
- **Status bar** di atas kantor: tanggal/jam lokal, jumlah karyawan, yang sedang bekerja, tugas aktif, selesai hari ini,
  jumlah bisnis, dan status sistem (normal / antrean dijeda / provider AI bermasalah). Semua angka dari backend.
- Kantor mengisi seluruh lebar di kiri kolom **Obrolan/Detail**, dan tinggi kanvas mengikuti layar sehingga sejajar dengan
  kolom obrolan. Seret untuk menggeser; tombol **+ / − / Pas** (atau Ctrl+scroll, tombol `+` `-` `0`) untuk zoom dan reset
  kamera. Tombol **Peta** menampilkan minimap (mati secara default; klik minimap untuk memindahkan kamera).
- **Halaman depan** (bagian atas peta): langit sesuai jam browser (matahari/bulan di posisi sebenarnya, bintang, siluet kota),
  jalan, trotoar dengan lampu jalan dan pohon, parkiran (zona motor dua baris, parkir paralel dengan satu pickup double
  cabin lifted, jalan masuk dari jalan raya), taman, dan pintu masuk gedung. Kendaraan hanya dekorasi.
- **Cuaca**: klik chip *Cuaca* di status bar atau klik halaman depan, lalu pilih:
  - *Otomatis*: cuaca asli dari [Open-Meteo](https://open-meteo.com) (gratis, tanpa API key). Cari nama kota sekali; diperbarui
    tiap 15 menit. Browser mengirim koordinat kota (dibulatkan ±1 km) ke Open-Meteo. Data lebih dari 3 jam dianggap
    tidak tersedia.
  - *Manual*: cerah / berawan / hujan / badai petir.
  Pengaturan disimpan di browser. Hujan, awan, petir, dan genangan hanya tampil di luar gedung; lampu jalan menyala saat
  malam atau hujan.
- Arahkan kursor ke karakter untuk tooltip (nama, status, tugas aktif). Klik **karakter** atau **meja** untuk kartu
  karyawan melayang: departemen, bisnis, status, tugas & progres subtugas (jika ada), provider/model AI, token, aktivitas
  terakhir, riwayat (*Detail lengkap* membuka tab Detail).
- Klik **ruangan** mana pun untuk kartu sesuai fungsinya di dalam kantor (CEO: ringkasan grup & approval; Finance: keuangan
  bulan ini; Developer Lab: RAM, uptime, provider, error; HR: karyawan & beban kerja; Lounge: siapa yang sedang tidak
  bertugas; dst.). Kartu hanya menampilkan data yang tercatat di sistem.
- Notifikasi kecil muncul saat karyawan mulai bekerja, tugas selesai/gagal, rapat dimulai, atau ada approval baru.
- Shared Services muncul di "Meja Tamu" kantor bisnis hanya saat sedang mengerjakan tugas bisnis itu.
- Tombol **♪** menyalakan suara (ketikan & notifikasi). Suara selalu **mati** saat halaman dibuka dan tidak pernah autoplay.

Semua animasi berasal dari status tugas di database dan antrean. Tanpa tugas, karakter diam (IDLE). Karyawan tanpa tugas
yang tidak beraktivitas ≥ 20 menit (dihitung dari riwayat tugas) duduk di sofa Lounge/Pantry (**RESTING**) sebanyak kursi
yang tersedia, lalu berjalan kembali ke meja begitu mendapat tugas. Pencahayaan mengikuti jam browser (pagi, siang, sore,
malam: lampu ruangan menyala).

### Obrolan agen

Di sisi kanan kantor ada tab **Obrolan**:

- **Pesan antar-agen** muncul otomatis dari kejadian tugas sungguhan, tanpa panggilan AI tambahan: penugasan, mulai kerja,
  rapat penggabungan, selesai, laporan, gagal, dan permintaan persetujuan. Pesan terbaru juga tampil sebagai bubble di atas karakter.
- **Pesan Anda** — pilih penerima dan mode:
  - *Balasan cepat AI*: 1 panggilan AI; jawaban penerima masuk ke obrolan.
  - *Tugas penuh*: Group CEO/Business Manager membagi pekerjaan.
  - *Catatan saja*: tanpa AI.
- Perintah cepat tanpa AI: `/status`, `/agents`, `/help`.
- Kantor Pusat menampilkan semua obrolan. Kantor bisnis hanya menampilkan obrolan bisnis tersebut, dan staf bisnis lain
  tidak bisa disapa dari sana.
- Riwayat tersimpan di SQLite (tabel `chat_messages`, migrasi `003_chat.sql`) dan dibersihkan otomatis mengikuti retensi log.

### Rendering

Rendering 100% di browser (Canvas 2D, tanpa WebGL/game engine):

- Sprite sheet: satu PNG lokal ±10 KB (165 frame: lantai, wallpaper per ruangan, furnitur, ikon) di `public/assets/office-atlas.png`, dihasilkan dari kode oleh:

  ```bash
  node scripts/build-office-atlas.mjs
  ```

  File ini bisa diganti dengan pixel art Anda sendiri asalkan nama frame di `office-atlas.json` tetap sama.
- FPS adaptif: 30 FPS saat ada karakter berjalan, ±10 FPS saat mengetik/selebrasi, 2 FPS saat diam. Rendering berhenti saat tab tersembunyi atau kanvas tidak terlihat.
- Animasi ambient (tanaman, jam dinding, lampu server) mati otomatis jika sistem meminta *reduced motion*.
- Kantor bisnis dibangun saat pertama kali dibuka (lazy loading).

Detail desain: [docs/OFFICE-VISUALIZATION.md](docs/OFFICE-VISUALIZATION.md).

## Update, backup, restore, troubleshooting

Lihat [docs/DEPLOY-AAPANEL.md](docs/DEPLOY-AAPANEL.md) bagian 8–10. Ringkasnya:

- Migrasi database berjalan otomatis dan didahului backup `pre-migrate-*.db`.
- Backup harian otomatis tersimpan di `data/backups/`.
- Restore dilakukan dengan menyalin file backup menjadi `data/office.db` saat container berhenti.

## Struktur proyek

```
src/            server.js, app.js, config.js, events.js
  db/           SQLite wrapper, migration runner, migrations/001_init.sql, 002_holding.sql, seed.js
  auth/ lib/    sesi, CSRF guard, crypto, zona waktu, settings, rate limit, audit
  providers/    adapter OpenAI-compatible, OpenRouter, 9Router, Cloudflare, Gemini + katalog preset
  router/       Model Router (fallback, cooldown, kuota, concurrency)
  holding/      bisnis, dokumen/FTS, keuangan, laporan, approval, context (isolasi), task factory
  agents/       karyawan, prompt, orchestrator holding → bisnis → karyawan
  queue/        task queue berbasis SQLite + worker
  telegram/     client, bot (long polling), notifier, laporan
  scheduler/    laporan harian, backup, pembersihan
  routes/       REST API
  cli/          reset-password.js
public/         SPA tanpa build step (HTML + CSS + ES modules + Canvas); assets/office-atlas.png (sprite sheet)
scripts/        deploy-aapanel.sh (install/update/backup di VPS aaPanel), build-office-atlas.mjs (generator sprite sheet PNG)
test/           node:test (72 tes) + test/system (restart, beban, RAM)
```
