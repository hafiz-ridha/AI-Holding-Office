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
- [docs/TELEGRAM.md](docs/TELEGRAM.md): membuat bot di @BotFather dan menghubungkannya (laporan, notifikasi, perintah).
- [docs/TESTING.md](docs/TESTING.md): hasil uji fungsional, keamanan, restart, dan RAM.

## Fitur

| Area | Isi |
|---|---|
| Holding | Bisnis tanpa hardcode (tambah/ubah/nonaktifkan dari dashboard), logo, industri, Business Manager, tim, task board, knowledge base, keuangan, laporan, aktivitas |
| Organisasi | Owner → Group CEO → Business Manager → staf bisnis; Shared Services (Group Finance, Secretary, Researcher, Developer, HR). Semua karyawan adalah profil yang berbagi satu AI router |
| Orkestrasi | Holding task → Business task → Employee subtask. Group CEO dapat menjawab langsung bila sederhana (hemat API). Tugas berulang terjadwal (riset tren, berita, media sosial, kompetitor, laporan) |
| Isolasi data | `business_id` pada tugas, percakapan, memori, dokumen, laporan, keuangan, log; diuji otomatis terhadap kebocoran antarbisnis |
| AI provider | 16 preset cloud gratis/kredit + 9Router + custom OpenAI-compatible; pemilihan model otomatis sesuai kebutuhan (dengan alasan di setiap jawaban), fallback, cooldown, batas request & token, model default per tingkatan |
| Second Brain | Hasil kerja menjadi pengetahuan bersama semua karyawan dan semua model (FTS5 + sinonim), fakta yang disematkan, isolasi per bisnis, catatan yang dipakai tampil di bawah jawaban |
| Telegram | Laporan harian holding (sekali per hari, tahan restart; dikirim per bagian seperti chat natural, dengan "mengetik…"), notifikasi tugas/error/persetujuan, perintah `/overview /companies /business <slug> /report /tasks /finance /approvals /task /setchat /pause /resume` |
| Kantor virtual | Pixel art top-down orisinal: Kantor Pusat (CEO Office, Meeting Room, Business Managers, Finance, Secretary, Research, Developer, HR, Marketing, Lounge) + satu kantor per bisnis (otomatis dari database). State IDLE/THINKING/WORKING/WALKING/MEETING/COMPLETED/ERROR (+ RESTING dari riwayat tugas) mengikuti data tugas nyata; klik karakter, meja, atau ruangan untuk detail; status bar, notifikasi, siang/malam, minimap |
| Riset web | Data terbaru dari internet (Google News, Google Trends, Wikipedia, DuckDuckGo) diberikan ke AI sebagai sumber bernomor, tanpa API key; approval owner hanya untuk tindakan penting |
| Keamanan | Login scrypt, sesi HttpOnly, CSRF, rate limit, CSP ketat (koneksi keluar dari browser hanya ke Open-Meteo untuk cuaca otomatis), API key terenkripsi AES-256-GCM, whitelist Telegram, audit log, persetujuan owner untuk tindakan berisiko, bisa diputuskan satu per satu atau sekaligus (AI tidak pernah mengeksekusi tindakan) |

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
Shared Services / staf bisnis) → **model terbaik untuk kebutuhan tugas (otomatis)** → provider cadangan →
tugas ditunda (pending) dengan notifikasi. Jumlah percobaan dibatasi, sehingga tidak ada retry tanpa batas.

### Pemilihan model otomatis

Aktif secara default (**AI Providers → Pemilihan model otomatis**; bisa diganti ke *Manual*). Sebelum tiap
panggilan AI, router mengenali kebutuhannya dari isi tugas, tahap kerja (rencana/kerja/rangkuman), dan jabatan
karyawan: **Pemrograman & teknis**, **Analisis & perencanaan**, **Penulisan & konten**, **Balasan cepat**,
atau **Umum**. Model yang Anda pasang (model default + fallback tiap provider aktif) lalu diurutkan menurut
kecocokan (spesialis kode, kuat penalaran, besar/ringan, cepat), riwayat gagal 24 jam, dan ukuran konteks. Proses
ini tidak memanggil AI tambahan. Bila model teratas gagal atau kuotanya habis, model berikutnya dipakai.
Model khusus karyawan dan model per tingkatan tetap diutamakan bila diisi.

Setiap jawaban mencantumkan model yang menjawab beserta alasannya: di obrolan (baris 🤖 di bawah balasan, klik
untuk alasan lengkap), di detail tugas, di pembaca laporan, dan di notifikasi Telegram "Tugas selesai". Tambahkan
beberapa model ke *Fallback* (tombol **Pilih model** → **+ Fallback**) agar router punya pilihan.

### Second Brain (pengetahuan bersama semua model)

Pengetahuan disimpan di database, bukan di dalam model. Karena itu semua AI gratis yang terhubung memakai pengetahuan
yang sama dan bisa melanjutkan hasil model lain.

- **Yang disimpan:** hanya hasil kerja, yaitu hasil tugas karyawan, laporan bisnis, dan laporan holding, ditambah
  fakta yang Anda tulis. Setiap catatan mencatat siapa yang mengerjakan, model apa, dan tugas sumbernya. Balasan cepat
  obrolan (sapaan, basa-basi, tanya jawab singkat) **tidak** disimpan, baik ke Second Brain maupun ke memori kerja;
  balasan itu hanya ada di riwayat obrolan. Jawaban yang sangat pendek juga dilewati.
- **Yang diberikan ke AI:** sebelum merencanakan atau mengerjakan tugas, AI menerima catatan paling relevan dari
  lingkup yang sama (holding atau satu bisnis), ditambah fakta yang disematkan. Pencarian memakai kata kunci, sinonim
  bisnis (omzet = pendapatan = revenue, pesaing = kompetitor, dst.), tingkat kepentingan, dan kebaruan. Bila tugas
  serupa pernah dikerjakan, AI diminta memperbarui hasil lama, bukan mengulang dari nol.
- **Isolasi:** catatan bisnis A tidak pernah diberikan ke bisnis B. Laporan konsolidasi holding hanya diberikan ke
  Group CEO, dan hanya bila izin lintas bisnis aktif.
- **Transparansi:** baris 🤖 di bawah jawaban menampilkan `📚 N catatan`; klik untuk melihat catatan yang dipakai.
- **Menu Second Brain:** cari, tambah fakta, sematkan, koreksi, atau hapus catatan yang keliru. Pengaturan
  (aktif/nonaktif, jumlah catatan per panggilan) ada di **Settings → Second Brain**. Hasil kerja sebelum update
  otomatis dijadikan catatan sekali saat server pertama kali jalan.

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

## Tugas berulang

Di **Task Manager**, bagian **Tugas berulang** membuat tugas otomatis sesuai jadwal. Template siap pakai:

| Template | Jadwal awal | Tujuan |
|---|---|---|
| Ringkasan berita | Senin–Jumat 07:30 | Group CEO |
| Riset tren | Senin 08:00 | Business Manager |
| Media sosial | Senin & Kamis 09:00 | Business Manager |
| Pantau kompetitor | Rabu 10:00 | Business Manager |
| Laporan mingguan | Jumat 16:00 | Group CEO |
| Ide promo bulanan | Tanggal 1, 09:00 | Business Manager |

Instruksi template meminta AI memakai data terbaru dari internet beserta sumbernya, dan tidak meminta admin mengisi data
manual. Semua isi template bisa diubah.

- **Jadwal**: setiap hari, Senin–Jumat, mingguan (pilih hari), bulanan (tanggal 1–28), atau tiap N jam. Jam mengikuti
  zona waktu holding di Settings.
- **Tujuan**: holding task (Group CEO), business task (Business Manager), atau langsung ke satu karyawan, dengan aturan
  yang sama seperti tugas biasa.
- **Tiap kali jalan**: tanggal ditambahkan ke judul (`Riset tren pasar mingguan · 16-11-2026`). AI diminta melanjutkan
  dari hasil sebelumnya, yang otomatis tersedia lewat Second Brain. Tugasnya bertanda 🔁 di daftar tugas.
- **Tombol per jadwal**: *Jalankan sekarang*, *Nonaktifkan/Aktifkan*, *Riwayat* (daftar tugas dari jadwal itu),
  *Edit*, dan *Hapus* (tugas yang sudah dibuat tetap ada). Semua perubahan tercatat di audit log.
- **Andal**:
  - Satu jadwal yang jatuh tempo membuat tepat satu tugas, juga setelah restart.
  - Jadwal yang terlewat saat server mati dijalankan sekali saja.
  - Secara default, jadwal dilewati jika tugas sebelumnya masih berjalan.
  - Jika tugas gagal dibuat (misalnya bisnis dinonaktifkan), errornya tampil di jadwal dan dikirim sebagai system alert.

Setiap jadwal memakai kuota AI seperti tugas biasa, jadi pilih frekuensi secukupnya untuk provider gratis.

## Persetujuan owner (Approvals)

Hanya **tindakan penting** yang menunggu keputusan owner di menu **Approvals** dan dikirim ke Telegram. Yang termasuk
penting: uang (transfer, pembelian, investasi, sewa), kontrak dan hukum (pajak, izin), SDM (rekrut, PHK, gaji), perubahan
harga atau diskon, publikasi atas nama perusahaan, menghapus atau membagikan data rahasia, dan operasional besar (buka/tutup
cabang, ganti pemasok). Keputusan hanya dicatat. Aplikasi dan AI tidak pernah mengeksekusi tindakannya.

- **Informasi biasa** (analisis, rekomendasi, draf, "untuk diketahui") dan **permintaan data** ("mohon admin menambahkan
  data …") tidak menjadi approval. Semua prompt AI melarang meminta owner mengisi data manual. AI diminta memakai data di
  sistem dan hasil riset web, atau menulis asumsinya. Jika AI tetap menandainya, server menyaringnya dan mencatatnya di
  detail tugas sebagai *Catatan AI (tidak perlu persetujuan)*.
- Setiap item di Approvals menampilkan kategorinya. Tombol **Pilih yang bersifat informasi** membantu membersihkan item
  lama yang dibuat sebelum aturan ini.
- Aturan ini bisa dimatikan di **Settings → Riset web & persetujuan** untuk kembali ke perilaku lama (semua yang
  ditandai AI menjadi approval).

- **Satu per satu**: klik **Setujui** atau **Tolak** pada kartu, lalu tambahkan catatan bila perlu.
- **Sekaligus (bulk)**:
  1. Centang beberapa kartu, atau klik **Pilih semua**. Untuk memilih satu rentang, tahan **Shift** sambil mengklik.
  2. Klik **Setujui N** atau **Tolak N**.
  3. Periksa daftar item di jendela konfirmasi, isi satu catatan untuk semua item, lalu konfirmasi.

  Saring dulu per bisnis atau holding untuk memutuskan semua rekomendasi dari satu bisnis. Item yang sudah diputuskan di
  tempat lain dilewati dan tidak ditimpa. Setiap item tetap tercatat di audit log.

## Riset web otomatis (scraping)

Untuk tugas yang butuh data terbaru dari luar sistem (tren, berita, media sosial, kompetitor, harga pasar, regulasi, dll.),
server mengambil data dari internet **sebelum** AI bekerja. AI menerimanya sebagai sumber bernomor [W1], [W2], … dan
diminta mengutipnya. Admin tidak perlu mengisi data itu manual. Tanpa API key:

| Sumber | Isi |
|---|---|
| Google News RSS | Berita terbaru sesuai topik (judul, media, tanggal) |
| Google Trends RSS | Pencarian yang sedang tren di Indonesia (untuk tugas tren & media sosial) |
| Wikipedia API | Latar belakang untuk topik umum |
| DuckDuckGo HTML | Tautan artikel langsung, lalu isi beberapa halaman dibaca. Di jaringan yang memblokir DuckDuckGo (beberapa ISP Indonesia), langkah ini dilewati otomatis |

- **Kapan riset jalan**: topik diambil dari judul tugas dan industri bisnisnya. Riset berjalan untuk tugas kerja,
  rencana Business Manager, dan rencana Group CEO yang membutuhkannya. Balasan cepat obrolan hanya diriset jika diminta
  (mis. "berita", "harga", "tren").
- **Sumber yang dipakai** tampil di detail tugas (*Sumber web*) dan di riwayat tugas.
- **Aman**:
  - Server hanya membuka alamat publik http/https. Alamat internal/privat ditolak, juga setelah redirect.
  - Ada batas waktu dan ukuran, dan hanya konten teks yang diterima.
  - Isi web diberikan sebagai data, dan AI diminta mengabaikan perintah di dalamnya.
  - User-Agent bot yang jujur. Pemeriksaan bot situs tidak pernah diakali.
  - Hasil di-cache 1 jam.
- **Privasi**: kata kunci pencarian (kata-kata dari judul tugas dan industri bisnis) dikirim ke Google News, Google
  Trends, Wikipedia, dan DuckDuckGo.
- **Pengaturan** di Settings → *Riset web & persetujuan*: aktif/nonaktif dan jumlah halaman yang dibaca per riset (0–5).

## Laporan Telegram

Panduan lengkap, termasuk pengaturan BotFather, grup/channel, keamanan token, dan masalah umum, ada di
[docs/TELEGRAM.md](docs/TELEGRAM.md). Ringkasnya:

1. Di Telegram buka [@BotFather](https://t.me/BotFather), kirim `/newbot`, isi nama dan username (harus diakhiri `bot`),
   lalu salin token yang diberikan.
2. Di dashboard buka menu **Telegram**, tempel token, lalu klik **Simpan**. Status berubah menjadi **Aktif @username_bot**.
3. Kirim `/start` ke bot. Bot membalas User ID Anda. Isi angka itu di **User ID yang diizinkan**, lalu klik **Simpan**.
   Lalu kirim `/setchat` dari chat tujuan (pribadi atau grup): chat itu menjadi tujuan laporan & notifikasi otomatis.
   Chat ID yang diisi manual dicek ke Telegram saat disimpan.
4. Klik **Kirim pesan tes**. Untuk laporan harian, centang **Laporan harian otomatis** dan atur jamnya (zona waktu default Asia/Jakarta).

Menu perintah bot terisi otomatis, jadi `/setcommands` di BotFather tidak diperlukan. Panduan yang sama tersedia di
halaman Telegram pada dashboard.

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
| `/setchat` | Jadikan chat ini (pribadi/grup) tujuan laporan & notifikasi otomatis |
| `/status`, `/today`, `/pause`, `/resume`, `/help` | Status, ringkasan hari ini, kontrol antrean |

## Kantor virtual (pixel art)

Menu **AI Virtual Office**:

- Pilih **Kantor Pusat** atau kantor bisnis mana pun lewat tab. Bisnis baru langsung muncul tanpa perubahan kode.
- **Kantor Pusat bergaya startup**, tanpa ruang per departemen:
  - CEO Office, Meeting Room berdinding kaca, dan Business Managers.
  - **Open Space**: seluruh tim pusat (keuangan, sekretariat, riset, developer, HR, marketing, peran kustom) duduk
    bersama, dikelompokkan per fungsi.
  - **Lounge** dengan *coffee corner* (bar kopi, kursi bar, kulkas minuman) dan *game corner* (ping-pong, foosball,
    arcade, dart).
  - **Kolam renang** dengan kursi berjemur, payung, dan pelampung.
- **Office boy** (Kantor Pusat 3 orang, tiap kantor bisnis 1): dekorasi, bukan karyawan AI.
  - Mereka membuat kopi lalu mengantarnya, diutamakan ke karyawan yang sedang bekerja.
  - Mereka juga mengepel lantai (dengan papan "lantai basah"), membersihkan kolam, dan menyiram tanaman.
  - Mereka berjalan antar ruangan lewat pintu, koridor, dan lorong. Klik untuk melihat apa yang sedang dikerjakan.
- **Layar penuh**: tombol **⛶** atau tombol `F`. Keluar dengan `Esc`. Di browser yang tidak mendukung Fullscreen API,
  kantor menutupi jendela.
- **Status bar** di atas kantor: tanggal/jam lokal, jumlah karyawan, yang sedang bekerja, tugas aktif, selesai hari ini,
  jumlah bisnis, dan status sistem (normal / antrean dijeda / provider AI bermasalah). Semua angka dari backend.
- Halaman kantor memakai seluruh lebar jendela dan pas satu layar (tanpa scroll): animasi kantor mengisi semua ruang di kiri
  kolom samping bertab **Obrolan · Detail · Status**. Tab *Status* berisi status karyawan (nama, jabatan, status, tugas
  aktif; klik untuk membuka kartu karyawan). Tinggi kanvas mengikuti layar.
- Lebar peta mengikuti proporsi kanvas di layar Anda: ruangan melebar sampai kantor (halaman depan + semua ruangan) mengisi
  kanvas penuh saat dibuka dan setiap kali tombol **Pas** diklik. Saat ukuran jendela berubah, tata letak menyesuaikan
  otomatis. Ponsel memakai peta landscape standar pada skala 1:1 dan bisa digeser. Seret untuk menggeser; tombol **+ / − / Pas** (atau Ctrl+scroll, tombol `+` `-` `0`) untuk zoom dan reset
  kamera. Tombol **Peta** menampilkan minimap (mati secara default; klik minimap untuk memindahkan kamera).
- **Waktu**: klik jam di status bar (atau chip *Cuaca*), lalu pilih *Otomatis (jam browser)* atau atur manual
  **Pagi / Siang / Sore / Malam**. Langit, matahari/bulan, jam dinding, dan lampu ruangan ikut berubah. Malam hari, kolam,
  papan neon, dan arcade menyala. Pengaturan disimpan di browser.
- **Halaman depan** (bagian atas peta): langit sesuai waktu yang dipilih (matahari/bulan, bintang, siluet kota),
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
- Tim pusat muncul di "Hot Desk Tamu" kantor bisnis hanya saat sedang mengerjakan tugas bisnis itu.
- Tombol **♪** menyalakan suara (ketikan & notifikasi). Suara selalu **mati** saat halaman dibuka dan tidak pernah autoplay.

Semua status kerja berasal dari status tugas di database dan antrean; tidak ada karakter yang terlihat bekerja tanpa tugas.

Karyawan tanpa tugas (**IDLE**, atau **RESTING** jika aktivitas terakhirnya ≥ 20 menit lalu) terlihat hidup seperti di game:
- jalan-jalan di ruangannya;
- **ngobrol basa-basi** dengan rekan (bubble di atas kepala);
- ngopi di kursi bar, bersantai di sofa/bean bag;
- main arcade, berdua main ping-pong atau foosball;
- **berenang** di kolam.

Obrolan basa-basi diambil dari daftar kalimat di browser. Tidak memakai AI, tidak disimpan, dan tidak masuk ke tab
Obrolan. Status yang ditampilkan tetap status sebenarnya. Begitu ada tugas atau rapat, istirahat langsung berhenti dan
karyawan berjalan ke meja atau ruang rapat. Gerakan ini mati jika sistem meminta *reduced motion*.

Semua karakter berjalan 4 arah di atas grid lantai bebas: lewat pintu, koridor, dan lorong. Mereka tidak pernah menembus
tembok atau furnitur, dan tes `14-office-walking` menyusuri setiap rute untuk memastikannya.

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

- Sprite sheet: satu PNG lokal ±15 KB (224 frame: lantai, wallpaper per ruangan, furnitur, kolam, coffee & game corner, perlengkapan office boy, ikon) di `public/assets/office-atlas.png`, dihasilkan dari kode oleh:

  ```bash
  node scripts/build-office-atlas.mjs
  ```

  Skrip yang sama menulis peta frame ke `office-atlas.json` dan `public/js/office/atlas-data.js` (modul yang dimuat aplikasi,
  sehingga peta frame selalu ikut versi kode; URL PNG memakai hash isi). Jika mengganti gambar dengan pixel art sendiri,
  pertahankan nama frame dan jalankan ulang skrip agar kedua file itu ikut diperbarui.
- FPS adaptif: 30 FPS saat ada karakter berjalan, 20 FPS saat hanya office boy yang berjalan, ±10 FPS saat mengetik, ngobrol, atau bermain, dan 2 FPS saat diam. Rendering berhenti saat tab tersembunyi atau kanvas tidak terlihat.
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
  db/           SQLite wrapper, migration runner, migrations/001–007 (*.sql), seed.js
  auth/ lib/    sesi, CSRF guard, crypto, zona waktu, settings, rate limit, audit
  providers/    adapter OpenAI-compatible, OpenRouter, 9Router, Cloudflare, Gemini + katalog preset
  router/       Model Router (pemilihan model otomatis, fallback, cooldown, kuota, concurrency)
  holding/      bisnis, dokumen/FTS, Second Brain (knowledge), keuangan, laporan, approval (hanya yang penting), tugas berulang, context (isolasi), task factory
  agents/       karyawan, prompt, orchestrator holding → bisnis → karyawan
  research/     riset web otomatis untuk AI (Google News/Trends RSS, Wikipedia, DuckDuckGo; SSRF guard, cache)
  queue/        task queue berbasis SQLite + worker
  telegram/     client, bot (long polling), notifier, laporan
  scheduler/    laporan harian, tugas berulang, backup, pembersihan
  routes/       REST API
  cli/          reset-password.js
public/         SPA tanpa build step (HTML + CSS + ES modules + Canvas); assets/office-atlas.png (sprite sheet)
scripts/        deploy-aapanel.sh (install/update/backup di VPS aaPanel), build-office-atlas.mjs (generator sprite sheet PNG)
test/           node:test (124 tes) + test/system (restart, beban, RAM)
```
