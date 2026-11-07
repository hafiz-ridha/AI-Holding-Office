# Hasil Pengujian

Tanggal: 07-11-2026. Lingkungan uji: Windows 10 x64, Node.js v24.14.0 (proses Node langsung, bukan di dalam
container). **Docker tidak tersedia di mesin pengembangan ini**, jadi image belum di-build dan pemakaian RAM di
container Alpine belum diukur. Ukur ulang di VPS dengan `docker stats ai-virtual-holding` setelah deploy.

Semua pengujian AI memakai server **mock** OpenAI-compatible & Telegram lokal (`test/mock-*.js`).
Integrasi dengan API key asli (OpenRouter, Groq, Gemini, 9Router, Telegram) **belum diuji** karena tidak ada
kredensial; dashboard menyediakan *Test connection* untuk memverifikasinya setelah key diisi.

## 1. Tes otomatis: `npm test` → 77/77 lulus

| File | Cakupan |
|---|---|
| `01-core` (10) | migrasi, seed holding, enkripsi AES-GCM, zona waktu Asia/Jakarta, settings, login, CSRF, header keamanan, rate limit login |
| `02-router` (11) | key terenkripsi & tersamar, test connection, sinkron model + deteksi gratis, key salah, 9Router tidak terjangkau/tidak kompatibel, fallback model, preferensi karyawan, cooldown 429, kuota harian, batas request global, batas kandidat, CRUD karyawan |
| `03-orchestrator` (11) | Group CEO → Business Manager → staf → laporan bisnis → laporan holding, Shared Services per bisnis, jawaban langsung (1 panggilan), business task langsung, approval owner, pending → failed, cancel berantai, pause/resume, batas token, recovery restart, model per tingkatan |
| `04-isolation` (9) | dokumen/keuangan/memori/nama bisnis A **tidak pernah** muncul di prompt AI bisnis B (dan sebaliknya), akses lintas bisnis via API ditolak, share dokumen eksplisit, izin lintas bisnis Group CEO, staf tidak bisa ditugaskan ke bisnis lain, bisnis bersejarah hanya bisa dinonaktifkan, validasi logo (tolak SVG/spoof) |
| `05-telegram` (8) | validasi token, whitelist, `/overview /companies /business <slug> /finance /tasks /report`, `/pause /resume /task`, laporan harian sekali per tanggal, retry gagal maks 3×, notifikasi & approval, long polling end-to-end |
| `06-migration` (2) | DB v1 berisi data → migrasi holding: backup `pre-migrate` otomatis, data lama utuh, prompt kustom tidak berubah; backup/restore `integrity_check ok` + FTS |
| `07-provider-catalog` (6) | 18 preset valid, placeholder Account ID Cloudflare, default rate limit preset, provider tanpa key, provider tanpa `/models` (ping chat 1×, saran model preset) |
| `09-chat` (7) | obrolan agen dari event nyata (penugasan/rapat/selesai/laporan), urutan pesan owner → mulai → balasan, mode catatan & slash command tanpa AI, isolasi saluran per bisnis, staf bisnis lain ditolak, hapus riwayat per saluran |
| `10-office-visual` (5) | lapisan visual v3: tidak ada objek bertumpuk di Kantor Pusat & kantor bisnis (holding default, 8 bisnis × 9 staf + 7 shared, holding hampir kosong), setiap ruangan punya wallpaper/papan nama/pintu, kursi lounge punya lorong bebas, meja deterministik per karyawan, semua frame sprite tersedia |
| `08-office` (8) | state kantor dari data nyata: idle saat tidak ada pekerjaan, THINKING→WORKING→MEETING→COMPLETED, meeting HQ vs bisnis, Shared Services "visiting", ERROR dari tugas gagal/tertunda, panel karyawan (token, model, hasil), panel koordinasi terisolasi per bisnis, bisnis baru tampil otomatis, sprite sheet PNG valid |

## 2. Uji sistem: `npm run test:system`

Menjalankan server sungguhan sebagai proses terpisah dengan folder data sementara.

| Skenario | Hasil |
|---|---|
| Boot (migrasi + seed + listen) | ±0,8–1,0 detik |
| Crash keras (kill) saat holding task berjalan → start ulang | Tugas yang terputus dipulihkan (1 tugas), holding task tetap **completed** |
| Laporan harian Telegram sebelum & sesudah restart | Terkirim **1×**; tidak terkirim ulang setelah restart |
| 600 request API (overview, office, tasks, businesses, organization, employees) | 0,8–1,4 detik |
| Beban: 3 holding task + 3 business task (53 panggilan AI) | semua selesai |

## 3. Pemakaian resource (diukur, proses Node, heap dibatasi 96 MB)

| Kondisi | RSS | Heap V8 | CPU |
|---|---|---|---|
| Idle (30 detik setelah boot) | **67–68 MB** | 15 MB | 0–0,31% |
| Puncak saat beban di atas | **79–80 MB** | 23–24 MB | — |
| Setelah beban selesai | 79 MB | — | — |
| Ukuran database setelah beban | 404 KB | | |

Estimasi untuk VPS 1 GB: container ±80–110 MB (RSS di atas + overhead runtime container). Batas `mem_limit: 256m`
di compose hanya pengaman.

## 4. Visualisasi kantor (diukur di browser, Chromium)

| Metrik | Hasil |
|---|---|
| Ukuran aset sprite sheet (v3) | 9,8 KB PNG (165 frame) + JSON |
| Bangun scene Kantor Pusat / kantor bisnis (v3, dengan furnishing + cek tabrakan) | 11,5 ms / 7 ms (sekali, saat dibuka) |
| Pre-render latar + pencahayaan per kantor | 25 ms (sekali per kantor/periode hari) |
| Waktu render 1 frame, semua karakter bekerja (kasus terburuk), tampilan pas layar / zoom 2× | 0,63 ms / 0,30 ms |
| JS heap halaman | ±4,5 MB |
| FPS | 30 saat berjalan, ±10 saat mengetik/selebrasi, 2 saat diam, 0 saat tab tersembunyi/kanvas tidak terlihat |

Rendering terjadi di browser; server hanya melayani `GET /api/office` (JSON) setiap 2 detik selama halaman kantor
terbuka (+ `/api/overview` tiap 10 detik untuk status bar, + riwayat tugas tiap 60 detik untuk RESTING), sehingga RAM
server tidak bertambah karena visualisasi.

## 5. Uji manual di browser (dashboard)

- Login, semua 20 halaman/tab dashboard dimuat tanpa error (dicek otomatis lewat navigasi hash).
- Kantor Pusat & kantor bisnis: perpindahan tab, zoom/pan, panel karyawan, panel meja, panel ruang rapat.
- Urutan state nyata saat business task berjalan: Business Manager THINKING → IDLE (menunggu tim) → MEETING
  (memimpin) → COMPLETED; staf IDLE → WORKING → MEETING → COMPLETED.
- Tampilan mobile 375×812: kanvas bisa digeser, tab kantor bisa digulir, panel di bawah kanvas.
- v3 (dengan mock provider lokal, jeda 6 detik): karyawan RESTING di Lounge berjalan lewat lorong ke meja saat diberi
  tugas → WORKING (monitor menyala, ikon gear, badge ruangan) → COMPLETED (notifikasi) → IDLE di meja; tugas yang
  tertunda karena provider mati tampil ERROR + notifikasi "tertunda". Tooltip, panel karyawan melayang, 16 panel ruangan,
  minimap, tombol suara, status bar, dan 4 periode pencahayaan dicek di browser; tablet 768×1024 dan ponsel 375×812
  (panel karyawan menjadi bottom sheet ±55% tinggi kanvas, minimap disembunyikan default).

## 6. Belum diuji / butuh konfigurasi Anda

- Build & run Docker image, healthcheck, dan RAM di dalam container (perlu VPS/Docker).
- Reverse proxy aaPanel + SSL Let's Encrypt.
- API key asli: OpenRouter, Gemini, Groq, dan provider lain di katalog; 9Router milik Anda.
- Bot Telegram asli (token @BotFather, Chat ID, User ID).
- Graceful shutdown via SIGTERM (di Windows sinyal ini menghentikan paksa; di Linux/Docker handler SIGTERM aktif).
