# Hasil Pengujian

Tanggal: 07-11-2026. Lingkungan uji: Windows 10 x64, Node.js v24.14.0 (proses Node langsung, bukan di dalam
container). **Docker tidak tersedia di mesin pengembangan ini**, jadi image belum di-build dan pemakaian RAM di
container Alpine belum diukur. Ukur ulang di VPS dengan `docker stats ai-virtual-holding` setelah deploy.

Semua pengujian AI memakai server **mock** OpenAI-compatible & Telegram lokal (`test/mock-*.js`).
Integrasi dengan API key asli (OpenRouter, Groq, Gemini, 9Router, Telegram) **belum diuji** karena tidak ada
kredensial; dashboard menyediakan *Test connection* untuk memverifikasinya setelah key diisi.

## 1. Tes otomatis: `npm test` → 136/136 lulus

| File | Cakupan |
|---|---|
| `01-core` (11) | migrasi, seed holding, enkripsi AES-GCM, zona waktu Asia/Jakarta, settings, login, CSRF, header keamanan, rate limit login, cache file statis (HTML/JS/CSS/JSON selalu divalidasi ulang + `304`; URL sprite sheet berversi hash isi) |
| `02-router` (11) | key terenkripsi & tersamar, test connection, sinkron model + deteksi gratis, key salah, 9Router tidak terjangkau/tidak kompatibel, fallback model, preferensi karyawan, cooldown 429, kuota harian, batas request global, batas kandidat, CRUD karyawan |
| `03-orchestrator` (11) | Group CEO → Business Manager → staf → laporan bisnis → laporan holding, Shared Services per bisnis, jawaban langsung (1 panggilan), business task langsung, approval owner, pending → failed, cancel berantai, pause/resume, batas token, recovery restart, model per tingkatan |
| `04-isolation` (9) | dokumen/keuangan/memori/nama bisnis A **tidak pernah** muncul di prompt AI bisnis B (dan sebaliknya), akses lintas bisnis via API ditolak, share dokumen eksplisit, izin lintas bisnis Group CEO, staf tidak bisa ditugaskan ke bisnis lain, bisnis bersejarah hanya bisa dinonaktifkan, validasi logo (tolak SVG/spoof) |
| `05-telegram` (12) | laporan panjang dikirim per bagian (sapaan, ringkasan, satu pesan per bisnis, …) dengan "mengetik…", isi utuh & berurutan, pesan pendek tetap satu, bisa dimatikan; validasi token, status bot langsung tampil setelah disimpan, Chat ID dicek ke Telegram saat disimpan (ID bot ditolak, chat tak terjangkau ditolak), `/setchat` & `/start` menunjukkan tujuan laporan, error "chat not found" dijelaskan, migrasi grup → supergroup diikuti, whitelist, `/overview /companies /business <slug> /finance /tasks /report`, `/pause /resume /task`, laporan harian sekali per tanggal, retry gagal maks 3×, notifikasi & approval, long polling end-to-end |
| `06-migration` (2) | DB v1 berisi data → migrasi holding (002–008): backup `pre-migrate` otomatis, data lama utuh, prompt kustom tidak berubah; backup/restore `integrity_check ok` + FTS |
| `07-provider-catalog` (6) | 18 preset valid, placeholder Account ID Cloudflare, default rate limit preset, provider tanpa key, provider tanpa `/models` (ping chat 1×, saran model preset) |
| `09-chat` (7) | obrolan agen dari event nyata (penugasan/rapat/selesai/laporan), urutan pesan owner → mulai → balasan, mode catatan & slash command tanpa AI, isolasi saluran per bisnis, staf bisnis lain ditolak, hapus riwayat per saluran |
| `10-office-visual` (9) | kantor startup: Open Space untuk seluruh tim pusat (urut per fungsi, developer dua monitor), tidak ada ruang departemen / berlabel Shared Services, lounge dengan coffee bar, kursi bar, ping-pong, foosball, arcade, sofa & troli OB, kolam di dalam ruangannya tanpa furnitur di air, 3 office boy (1 per kantor bisnis) dengan titik kerja di dalam ruangan; rasio peta 1,0–3,5 (mengisi layar) tetap tanpa tabrakan;  lapisan visual v3/v4: peta frame modul = JSON = PNG (ukuran & hash versi), halaman depan (tepat satu pickup, dua baris motor, kendaraan di dalam parkiran, jalan masuk & pintu utama bebas), tidak ada objek bertumpuk di Kantor Pusat & kantor bisnis (holding default, 8 bisnis × 9 staf + 7 shared, holding hampir kosong), setiap ruangan punya wallpaper/papan nama/pintu, kursi lounge punya lorong bebas, meja deterministik per karyawan, semua frame sprite tersedia |
| `11-model-selection` (9) | deteksi kebutuhan (kode, analisis, penulisan, balasan obrolan, umum; tahap rencana; jabatan), profil model dari id, mode otomatis memilih model terbaik per kebutuhan + penjelasan, model teratas gagal → model berikutnya dan alasan "dilewati", mode manual mempertahankan urutan, model khusus karyawan/tingkatan tetap didahulukan, riwayat gagal & konteks kecil menurunkan peringkat, ringkasan `/api/providers/routing`, balasan obrolan dan detail tugas membawa model + alasan |
| `12-second-brain` (9) | pencarian dengan stop word, prefix, dan sinonim; ringkasan jawaban panjang; hasil kerja menjadi catatan (penulis, model, bisnis) tetapi balasan cepat obrolan **tidak** (juga tidak masuk memori kerja) dan jawaban pendek dilewati; tugas berikutnya di bisnis yang sama menerima catatan (sinonim pesaing = kompetitor), bisnis lain tidak; petunjuk "tugas serupa pernah dikerjakan"; fakta yang disematkan selalu diberikan, termasuk saat balasan cepat, dan tampil di bawah jawaban; laporan holding hanya untuk Group CEO dengan izin lintas bisnis; API cari/sematkan/koreksi/hapus (indeks FTS ikut berubah); backfill dan sakelar nonaktif |
| `13-approvals` (5) | keputusan tunggal tercatat sekali; keputusan massal (bulk) dalam satu transaksi dengan satu catatan, item yang sudah diputuskan/tidak ada/duplikat dilewati dan tidak pernah ditimpa, audit log per item (`bulk`), filter bisnis/holding + status, validasi input (1–100 id) |
| `14-office-walking` (3) | Kantor Pusat (normal & lebar) dan kantor bisnis: semua rute (meja ↔ meja lintas ruangan lewat pintu/koridor/lorong, ke setiap kursi bar, sofa/bean bag, arcade, ujung meja ping-pong/foosball, pintu masuk kolam, titik kerja office boy, dan kembali; dari ambang pintu; renang & keluar kolam) disusuri per 2 px: tidak pernah di dalam tembok, kaki tidak pernah menyentuh furnitur, tanpa langkah diagonal, putaran renang tetap di air |
| `15-recurring` (5) | jadwal harian, Senin–Jumat, mingguan, bulanan, tiap N jam di zona waktu holding (WIB); template riset tren, berita, media sosial, kompetitor, laporan; validasi input & aturan hierarki; satu jadwal jatuh tempo = tepat satu tugas (scheduler berdetak dua kali, server mati 3 hari → sekali); judul bertanggal, `recurring_id`, filter daftar tugas; dilewati jika tugas sebelumnya masih aktif, *Jalankan sekarang* tetap membuat tugas; nonaktif tidak jalan, ubah jadwal menghitung ulang, bisnis nonaktif → error tercatat, hapus jadwal → tugas tetap ada |
| `16-approvals-web` (7) | klasifikasi approval (keuangan, kontrak, SDM, harga, publikasi, data vs informasi & permintaan data); hasil AI: hanya yang penting jadi approval, sisanya dicatat di tugas, kebijakan bisa dimatikan; kategori di daftar Approvals; semua prompt membawa aturan persetujuan & larangan meminta data manual; SSRF guard (IP privat/IPv6 lokal/metadata/localhost/file:/kredensial ditolak; tes tidak pernah ke internet); parser RSS/hasil pencarian/teks halaman; riset (berita, hasil web lewat redirect, isi halaman, tren, Wikipedia, cache 1 jam); end-to-end: tugas butuh data terbaru → sumber [W1]… di prompt AI dan tersimpan di tugas, mati → tanpa riset |
| `17-telegram-team` (6) | grup tim: `/team` butuh grup dengan Topics + bot admin "kelola topik" (orang lain ditolak); satu topik per karyawan + topik laporan (warna ikon valid), laporan otomatis pindah ke topik 📊, ringkasan di General; emoji orang sesuai pekerjaan & warna kulit karakter; pesan di topik karyawan → obrolan dashboard → tugas balasan cepat, jawaban kembali ke topik (emoji, nama, jabatan, format Markdown), pesan sendiri tidak digemakan; `/tugas` di topik CEO → holding task, `/catat` → catatan; pesan dashboard dicerminkan; topik terhapus dibuat ulang; ganti nama → topik diganti; `/setchat` di topik karyawan ditolak, di topik laporan disimpan; laporan harian ke topik; lepas grup → tidak diteruskan |
| `18-natural-text` (6) | tidak ada JSON mentah untuk manusia: JSON → teks natural (jawaban dulu, label, daftar, prioritas diterjemahkan), JSON terpotong diselamatkan ("…"), prosa/tautan/kode biasa tidak diubah, blok ```json di obrolan jadi teks; error provider tanpa badan JSON; persetujuan dari baris JSON bersih; rencana CEO tanpa daftar tugas → hasil = analisis (laporan & Telegram tanpa JSON); balasan chat berupa JSON → teks di obrolan & format Telegram, tetap JSON bila owner memintanya; notifikasi Telegram seperti chat (emoji orang, nama, judul, isi, model); penyebab gagal tanpa JSON |
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
| Ukuran aset sprite sheet (v4, + halaman depan) | 11,7 KB PNG (186 frame) + JSON |
| Bangun scene Kantor Pusat / kantor bisnis (v4, furnishing + halaman depan + cek tabrakan) | 13 ms / 7 ms (sekali, saat dibuka) |
| Pre-render latar + pencahayaan per kantor | 36 ms (sekali per kantor/periode hari/cuaca) |
| Waktu render 1 frame, semua karakter bekerja, halaman depan terlihat: cerah / badai (hujan + kilat) | 0,55 ms / 0,95 ms |
| JS heap halaman | ±5,5 MB |
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
- v4: instalasi baru disimulasikan (riwayat tugas kosong): semua karyawan IDLE di ruangannya masing-masing dan
  berjalan mondar-mandir acak tanpa menembus meja/furnitur; grid jalan setiap ruangan diperiksa (pintu bebas, semua tempat
  berdiri & kursi terjangkau, juga dengan 14 staf bisnis + 9 developer tambahan). Halaman depan tampil lewat pemuat sprite
  baru (`sprite-atlas.js` + `atlas-data.js`).

## 6. Belum diuji / butuh konfigurasi Anda

- Build & run Docker image, healthcheck, dan RAM di dalam container (perlu VPS/Docker).
- Reverse proxy aaPanel + SSL Let's Encrypt.
- API key asli: OpenRouter, Gemini, Groq, dan provider lain di katalog; 9Router milik Anda.
- Bot Telegram asli (token @BotFather, Chat ID, User ID).
- Graceful shutdown via SIGTERM (di Windows sinyal ini menghentikan paksa; di Linux/Docker handler SIGTERM aktif).
