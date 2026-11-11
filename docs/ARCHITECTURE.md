# AI Virtual Office — Analisis & Arsitektur

Dokumen ini adalah hasil Tahap 1 (analisis arsitektur) dan masih berlaku sebagai fondasi. Pembaruan berikutnya:

- **AI Virtual Holding** (multi-bisnis, Group CEO, Business Manager, Shared Services, isolasi data):
  [AUDIT-HOLDING.md](AUDIT-HOLDING.md), migrasi `002_holding.sql`.
- **Katalog provider AI cloud gratis** (16 preset + 9Router + custom): `src/providers/registry.js`.
- **Visualisasi kantor pixel art v2** (Kantor Pusat + kantor per bisnis, panel interaktif):
  [OFFICE-VISUALIZATION.md](OFFICE-VISUALIZATION.md).

Semua angka resource di bagian "Estimasi resource" adalah **estimasi** awal. Angka hasil pengukuran nyata ada di
[TESTING.md](TESTING.md).

## 1. Prinsip desain

| Prinsip | Keputusan |
|---|---|
| RAM/CPU minimal | Satu proses Node.js, satu container, SQLite in-process, tanpa framework frontend, tanpa build step. |
| Tanpa LLM lokal | Semua inferensi lewat HTTP ke provider (OpenRouter, 9Router, OpenAI-compatible). |
| Model bisa diganti | Provider, model default, fallback, model per karyawan, dan mode pemilihan model (otomatis/manual) disimpan di DB dan diubah dari dashboard. |
| AI hanya bekerja saat ada tugas | Tidak ada loop "berpikir" otomatis. Panggilan AI hanya terjadi saat task queue mengambil tugas. |
| Aman secara default | AI hanya menghasilkan teks. Tidak ada tool eksekusi (hapus file, shell, email, transaksi). Rekomendasi berisiko ditandai "PERLU PERSETUJUAN ADMIN". |
| Mudah dipelihara | 2 dependency runtime (Fastify + @fastify/static). Sisanya modul bawaan Node.js. |

## 2. Diagram arsitektur

```
                         Internet (HTTPS)
                               │
                 ┌─────────────▼──────────────┐
                 │ aaPanel Nginx (reverse     │  SSL Let's Encrypt
                 │ proxy → 127.0.0.1:3000)    │
                 └─────────────┬──────────────┘
                               │ HTTP
┌──────────────────────────────▼───────────────────────────────────────────┐
│ Container "ai-office" (node:24-alpine, user non-root)                     │
│                                                                           │
│  Fastify HTTP ──┬── /            static SPA (HTML + Canvas + CSS + JS)    │
│                 ├── /api/auth    login, sesi, CSRF                        │
│                 ├── /api/*       tasks, employees, providers, telegram,   │
│                 │                settings, overview, office, usage        │
│                 └── /api/health  health check Docker                      │
│                                                                           │
│  ┌────────────┐   event bus   ┌──────────────┐    ┌──────────────────┐    │
│  │ Task Queue │──────────────▶│ Orchestrator │───▶│  Model Router    │    │
│  │ (SQLite,   │◀──────────────│ CEO plan →   │    │ prioritas,       │    │
│  │ concurrency│               │ subtugas →   │    │ fallback,        │    │
│  │ default 1) │               │ sintesis     │    │ cooldown, kuota, │    │
│  └────────────┘               └──────────────┘    │ batas token      │    │
│        │                                          └────────┬─────────┘    │
│        │ events                                            │ adapters     │
│  ┌─────▼──────┐  ┌────────────┐                  ┌─────────▼─────────┐    │
│  │ Notifier   │─▶│ Telegram   │◀── long polling ─│ OpenRouter        │    │
│  │ (throttle) │  │ client/bot │    (commands)    │ 9Router (OpenAI-  │    │
│  └────────────┘  └────────────┘                  │  compatible)      │    │
│  ┌────────────────────────────┐                  │ Groq / Gemini /   │    │
│  │ Scheduler (tick 30 detik): │                  │ custom OpenAI-    │    │
│  │ laporan harian, backup,    │                  │ compatible        │    │
│  │ pembersihan, recovery      │                  └─────────┬─────────┘    │
│  └────────────────────────────┘                            │              │
│                                                            │ HTTPS fetch  │
│  SQLite (node:sqlite, WAL) ── /app/data/office.db          │              │
│  Backup ── /app/data/backups/*.db   (volume persisten)     │              │
└────────────────────────────────────────────────────────────┼──────────────┘
                                                             ▼
                             openrouter.ai · 9Router (container terpisah milik admin)
                             api.groq.com · generativelanguage.googleapis.com
                             api.telegram.org
```

### Alur tugas (Agent Orchestrator)

```
Pemilik (dashboard / Telegram)
   │ 1. instruksi
   ▼
[root task, kind=instruction, phase=planning, assigned → CEO]
   │ 2. Queue mengambil → CEO menganalisis (1 panggilan AI, output JSON)
   │ 3. CEO membuat ≤ N subtugas (default 4) dengan assignee berdasarkan peran
   ▼
[subtask × N, status=assigned]  ── phase root = executing
   │ 4–5. Queue menjalankan satu per satu (concurrency default 1)
   │ 6. Hasil + percakapan + memori disimpan per karyawan
   ▼
Semua subtugas selesai/gagal → root phase=synthesizing, status=assigned
   │ 7. CEO menggabungkan hasil (1 panggilan AI)
   ▼
[root completed] → 8. dashboard  → 9. notifikasi Telegram (sesuai konfigurasi)
```

Jumlah panggilan AI per instruksi = 1 (rencana) + N (subtugas) + 1 (sintesis).
Jika CEO menilai instruksi sederhana, CEO menjawab langsung (1 panggilan).

### Model Router — urutan kandidat

1. Provider + model pilihan karyawan (jika diisi).
2. Model default tingkatan (`tier_models`, jika diisi).
3. Provider default + model default.
4. Model fallback provider default (daftar berurutan dari admin, termasuk model gratis).
5. Provider cadangan lain yang aktif (urut prioritas): model default lalu fallback-nya.
6. Semua gagal → tugas kembali `pending` dengan jadwal ulang (backoff), notifikasi System Alert.
   Setelah `max_task_attempts` (default 3) → `failed`.

**Pemilihan model otomatis** (`model_routing = auto`, default; `src/router/modelSelector.js`): kandidat 3–5
diurutkan ulang untuk setiap panggilan, sedangkan 1–2 (pilihan admin) tetap di depan.

- `detectNeed()` membaca judul/deskripsi tugas (kata kunci ID/EN, blok kode), tujuan panggilan (`plan` →
  analisis, `synthesis` → penulisan), jabatan karyawan, dan penanda balasan obrolan. Hasilnya `coding`,
  `reasoning`, `writing`, `quick`, atau `general`, plus sinyal yang terdeteksi dan flag input panjang.
- `profileModel()` menebak kekuatan model dari id-nya (keluarga model dikenal + ukuran parameter `70b`, `120b`,
  dst.) dan katalog yang disinkron (panjang konteks, gratis/berbayar). Id yang tidak dikenali berprofil netral,
  sehingga urutan admin tetap berlaku.
- `rankCandidates()` memberi skor: bobot tag/ukuran per kebutuhan, bonus kecil untuk model default provider
  utama, penalti gagal 24 jam (`usage_logs`), penalti konteks terlalu kecil untuk input panjang, penalti kecil
  model berbayar. Tanpa panggilan AI tambahan.
- `describeChoice()` menyusun penjelasan (mode, kebutuhan, alasan, peringkat, model yang dilewati). Penjelasan
  disimpan di `tasks.model_choice` (migrasi `004`, JSON), dicatat di log tugas (`model_choice`), dan ditampilkan
  di obrolan, detail tugas, pembaca laporan, serta notifikasi Telegram.
- `GET /api/providers/routing` menampilkan pilihan utama per kebutuhan dan profil tiap model terpasang.

### Second Brain — pengetahuan bersama antarmodel

`src/holding/knowledge.js`, migrasi `005_knowledge.sql` (tabel `knowledge_notes` + FTS5 `knowledge_fts`,
kolom `tasks.knowledge_refs`). Pengetahuan berada di SQLite, jadi model mana pun yang menjawab membaca catatan
yang sama.

- **Capture** (`captureTask`, dipanggil di `finish()` orkestrator): satu catatan per tugas selesai, berisi bagian
  Ringkasan/Hasil/Rekomendasi dari jawaban (`distill`) beserta penulis, provider/model, dan sumber tugas. Yang
  dilewati: balasan cepat obrolan (penanda "Pesan obrolan dari owner"), jawaban di bawah 120 karakter, dan saat
  `knowledge_enabled = false`. Balasan cepat juga tidak lagi ditulis ke memori kerja karyawan.
- **Recall** (`recallKnowledge` + `formatKnowledge`, dipakai di rencana CEO, rencana Business Manager, dan
  pengerjaan karyawan; tidak di tahap rangkuman). Isinya: catatan yang disematkan, lalu hasil FTS5 (bm25, judul
  dibobot 3×) yang diurutkan ulang menurut kepentingan dan umur, hingga `knowledge_items` catatan dalam ±2.400
  karakter. Blok ini masuk ke pesan *system* sebagai data, bukan instruksi. Bila judul mirip (≥0,6) dengan catatan
  lama, AI diminta memperbarui hasil itu.
- **Isolasi:** `business_id IS task.business_id`. Catatan `ceo_only` (laporan holding) hanya untuk Group CEO dengan
  `group_ceo_cross_business`. Catatan dari rantai tugas yang sama (induk, saudara, anak) dilewati karena sudah ada
  di prompt.
- **Pencarian** (`src/lib/search.js`, juga dipakai knowledge base dokumen): stop word ID/EN dibuang, kata ≥4 huruf
  memakai prefix match, dan sinonim bisnis ditambahkan.
- **Batas:** maksimal 5.000 catatan kerja yang tidak disematkan; yang paling tidak penting dan paling lama tidak
  dipakai dipangkas lebih dulu. Backfill sekali dari 300 tugas selesai terakhir (`_knowledge_backfilled`).
- API: `GET/POST /api/knowledge`, `GET/PUT/DELETE /api/knowledge/:id`. Perubahan dicatat di audit log.

Kandidat dilewati bila: provider nonaktif, provider/model sedang cooldown (429, kuota habis,
model tidak ditemukan), batas request harian provider atau global tercapai.
Setiap job dibatasi `max_model_attempts` (default 4) sehingga tidak ada retry tak terbatas.

## 3. Struktur folder

```
office/
├── Dockerfile                 # multi-stage, node:24-alpine, non-root, HEALTHCHECK
├── docker-compose.yml         # 1 service, volume ./data, restart, mem_limit
├── .env.example
├── package.json               # 2 dependency runtime
├── README.md                  # instalasi, update, backup/restore, troubleshooting
├── docs/
│   ├── ARCHITECTURE.md        # dokumen ini
│   ├── DEPLOY-AAPANEL.md      # panduan langkah demi langkah aaPanel
│   └── TESTING.md             # hasil uji fungsional, keamanan, RAM
├── src/
│   ├── server.js              # entry point, boot, graceful shutdown
│   ├── app.js                 # Fastify, security headers, routes
│   ├── config.js              # baca environment variables
│   ├── events.js              # event bus internal (EventEmitter)
│   ├── db/
│   │   ├── index.js           # wrapper node:sqlite (WAL, transaksi)
│   │   ├── migrate.js         # migration runner (schema_migrations)
│   │   ├── migrations/        # 001_init.sql, ...
│   │   └── seed.js            # 5 karyawan awal, settings default
│   ├── lib/                   # crypto, time (zona waktu), settings, audit, rate limit, teks
│   ├── auth/                  # sesi, guard (auth + CSRF)
│   ├── providers/             # adapter OpenAI-compatible, OpenRouter, 9Router, registry
│   ├── router/                # Model Router
│   ├── agents/                # karyawan, prompt, memori, orchestrator
│   ├── queue/                 # task queue berbasis SQLite
│   ├── telegram/              # client Bot API, bot (commands), notifier, laporan harian
│   ├── scheduler/             # tick internal: laporan, backup, cleanup
│   ├── services/              # backup database
│   └── routes/                # endpoint REST
├── public/                    # frontend statis (tanpa build step)
│   ├── index.html
│   ├── css/app.css
│   └── js/                    # api, router SPA, views, office (canvas pixel art)
└── test/                      # node:test + mock provider/Telegram untuk uji otomatis
```

## 4. Daftar dependency

### Runtime (production)

| Paket | Fungsi | Alasan |
|---|---|---|
| `fastify` 5.x | HTTP server, validasi JSON schema, logger (pino) | Ringan, cepat, validasi input bawaan. |
| `@fastify/static` | Menyajikan frontend statis | Aman terhadap path traversal, dukung ETag/cache. |

### Modul bawaan Node.js (tanpa install)

| Modul | Fungsi |
|---|---|
| `node:sqlite` | Database SQLite (tanpa kompilasi native, image Alpine tetap kecil). |
| `node:crypto` | scrypt (hash password), AES-256-GCM (enkripsi API key), token sesi. |
| `fetch` global | Request ke provider AI dan Telegram. |
| `node:events` | Event bus. |
| `node:test` | Pengujian otomatis. |
| `Intl` (full-ICU) | Zona waktu Asia/Jakarta tanpa library tambahan. |

**Catatan `node:sqlite`:** di Node 24 modul ini masih berlabel *experimental* (API dasar
`prepare/run/get/all/exec` sudah stabil sejak Node 22.5). Akses DB dipusatkan di
`src/db/index.js` sehingga beralih ke `better-sqlite3` cukup mengubah satu file bila
diperlukan. Versi Node di Docker dipatok ke 24 agar perilakunya sama dengan saat diuji.

Tidak dipakai: Ollama, LLM lokal, PostgreSQL, Redis, Kubernetes, Elasticsearch,
framework frontend, bundler, ORM, cron eksternal.

## 5. Estimasi resource (belum diukur)

| Komponen | Estimasi RSS |
|---|---|
| Node.js 24 runtime dasar | 40–50 MB |
| Fastify + pino + routes | 10–20 MB |
| SQLite (cache halaman default + WAL) | 2–10 MB |
| Buffer request AI (non-streaming, ≤ 1 concurrency) | 1–5 MB |
| **Total container (idle → aktif)** | **± 60–110 MB** |

- Heap V8 dibatasi `--max-old-space-size=96` dan container `mem_limit: 256m` sebagai
  pengaman, bukan target.
- CPU: idle ≈ 0% (hanya timer 5 detik untuk queue dan 30 detik untuk scheduler serta
  long-poll Telegram yang idle). Saat bekerja, CPU dipakai sebentar untuk parsing JSON;
  waktu tunggu didominasi latensi API.
- Disk: image ± 60–80 MB (node:24-alpine + 2 dependency). Database tumbuh sesuai riwayat;
  log lama dibersihkan otomatis (default 90 hari).
- Sisa RAM VPS 1 GB perlu dibagi dengan aaPanel (± 150–300 MB), Nginx, MySQL bila aktif,
  dan Docker daemon. Bila 9Router dijalankan di VPS yang sama, alokasikan RAM tambahan
  untuk container 9Router (aplikasi Next.js, umumnya jauh lebih besar dari aplikasi ini).

Angka nyata hasil pengujian ada di [TESTING.md](TESTING.md).

## 6. Rencana implementasi

| Tahap | Isi | Kriteria uji |
|---|---|---|
| 1 | Analisis arsitektur, struktur folder | Dokumen ini |
| 2 | Backend, SQLite, migration, auth, konfigurasi provider | Unit test DB/crypto/auth, login via HTTP |
| 3 | AI Router, sistem karyawan | Test fallback, cooldown, batas token & request dengan mock provider |
| 4 | Orchestrator & task queue | Test alur CEO → subtugas → sintesis, recovery setelah restart |
| 5 | Telegram bot & laporan harian | Test command, whitelist, anti-duplikat laporan dengan mock Bot API |
| 6 | Dashboard frontend | Uji manual di browser desktop & mobile |
| 7 | Kantor virtual pixel art | Animasi mengikuti status tugas nyata |
| 8 | Integrasi | Alur penuh via HTTP API |
| 9 | Uji fungsional, keamanan, RAM | TESTING.md berisi angka nyata |
| 10 | Docker image & panduan aaPanel | Dockerfile, compose, README, DEPLOY-AAPANEL.md |

## 7. Keputusan terkait 9Router

Berdasarkan README resmi [decolua/9router](https://github.com/decolua/9router):

- 9Router adalah **gateway self-hosted** (default `http://localhost:20128/v1`), bukan layanan
  cloud. Admin menjalankannya sendiri (Docker image `decolua/9router`).
- Endpoint client: `POST /v1/chat/completions` dan `GET /v1/models` dalam format OpenAI.
- Autentikasi: `Authorization: Bearer <key dari dashboard 9Router>`; wajib hanya bila
  `REQUIRE_API_KEY=true` di 9Router.
- Model memakai prefix provider (`kr/…`, `cc/…`, `gh/…`) atau nama *combo*.

Implementasi: adapter `ninerouter` memakai protokol OpenAI-compatible dengan Base URL dapat
diatur dan API key opsional. Test Connection memanggil `GET /models` dan memvalidasi bentuk
respons; bila server tidak terjangkau statusnya `error`, bila respons bukan format OpenAI
statusnya `unsupported`. Tidak ada integrasi tiruan.

## 8. Keamanan

- Login admin, password di-hash dengan scrypt (N=16384, r=8, p=1, salt 16 byte).
- Sesi: token acak 32 byte di cookie `HttpOnly; SameSite=Strict; Secure` (saat HTTPS),
  disimpan sebagai hash SHA-256 di DB, kedaluwarsa (default 12 jam).
- CSRF: header `X-CSRF-Token` wajib untuk semua request yang mengubah data.
- Rate limit: login (5 gagal / 15 menit per IP), API umum per IP.
- Validasi input: JSON schema Fastify di setiap endpoint.
- Sanitasi output: frontend tidak memakai `innerHTML` untuk data; Telegram memakai
  escape HTML. Header keamanan: CSP ketat, `X-Frame-Options`, `nosniff`, `Referrer-Policy`.
- API key provider & token bot Telegram dienkripsi AES-256-GCM dengan kunci dari
  `APP_SECRET`; dashboard hanya menerima versi tersamar (`sk-or-…a1b2`).
- Telegram: hanya User ID dalam whitelist yang dapat menjalankan perintah.
- Audit log: login, perubahan provider, karyawan, Telegram, settings, backup.

### Tugas berulang

`src/holding/recurring.js`, rute `src/routes/recurring.js`, migrasi `006_recurring.sql` (tabel `recurring_tasks`,
kolom `tasks.recurring_id`). Aturan jadwal: `daily`, `weekdays`, `weekly` (hari ISO 1–7), `monthly` (tanggal 1–28),
atau `hours` (tiap N jam mulai `time_of_day`), dihitung di zona waktu holding (`nextRunAt`). Scheduler 30 detik
memanggil `runDueRecurring()`:

- Jadwal diklaim dengan `UPDATE … SET next_run_at = <berikutnya> WHERE next_run_at = <lama>`, jadi satu jadwal yang
  jatuh tempo membuat tepat satu tugas, juga jika ada dua detak atau setelah restart. Jadwal yang terlewat saat server
  mati dijalankan sekali.
- Tugas dibuat lewat `createOwnerTask` (aturan hierarki yang sama dengan tugas manual; validasi saat menyimpan memakai
  `resolveOwnerTask` tanpa membuat tugas). Judul diberi tanggal, `created_by = recurring:<id>`. Instruksi ditambah
  catatan agar AI melanjutkan dari hasil sebelumnya, yang tersedia lewat Second Brain.
- `skip_if_running` (default aktif) melewati jadwal saat tugas sebelumnya masih aktif. Error (mis. bisnis nonaktif)
  disimpan di aturan dan dikirim sebagai `system:alert`.

### Riset web & kebijakan persetujuan

- `src/research/web.js`: `needsWeb(task)` (kata kunci tren/berita/media sosial/kompetitor/harga/regulasi/…, semua
  business task, dan tugas evaluasi/strategi/penjualan/harga/proyeksi di sebuah bisnis; jenis `market` mencari berita
  industri dan patokan harga/omzet) →
  `plan()` (jenis + topik dari judul & industri bisnis) → `research()`, yang berisi:
  - Google News RSS, Google Trends RSS, Wikipedia API, dan DuckDuckGo HTML, ditambah isi 0–5 halaman artikel langsung.
  - Hasilnya blok teks bersumber [W1]… plus `refs`, disimpan di `tasks.web_refs`.
  - Keamanan: `assertPublicUrl` (DNS di-resolve, IP privat/loopback/link-local/CGNAT/IPv6 lokal ditolak, dicek ulang di
    setiap redirect), batas 4 redirect, 8 detik, 800 KB, konten teks saja, cache 1 jam, dan User-Agent bot yang jujur.
  - Orkestrator (`webFor`) memanggilnya sebelum rencana CEO/Business Manager dan pengerjaan karyawan. Blok masuk ke
    pesan *user* sebagai data, dengan perintah untuk mengabaikan instruksi di dalamnya.
  - Pengaturan: `web_research_enabled`, `web_research_pages`. Di tes, alamat sumber diarahkan ke alamat lokal yang
    ditolak guard, sehingga tes tidak pernah ke internet.
- `DATA_RULE` (`src/agents/prompts.js`) ada di prompt kerja dan laporan: angka internal hanya dari konteks sistem;
  bila belum ada, pakai riset web dan pengetahuan umum sebagai "estimasi" yang ditandai, lalu sebut data yang kurang
  sekali di baris "Catatan data". Konteks bisnis menulis "belum diisi"/"belum ada", bukan "DATA NOT AVAILABLE". Aturan
  dasar yang tersimpan di prompt karyawan diperbarui sekali oleh `seed()` (flag `_data_rule_v2`, hanya baris lama yang
  persis sama). `tidyMissing()` (`src/lib/readable.js`, dipanggil oleh `readable()`) merapikan label lama di jawaban.
- `APPROVAL_RULE` (`src/agents/prompts.js`) ada di semua prompt yang bisa menghasilkan rekomendasi. Isinya: tandai
  "PERLU PERSETUJUAN ADMIN" hanya untuk tindakan penting, dan jangan pernah meminta owner mengisi data manual.
- `classifyApproval` (`src/holding/approvals.js`) adalah lapis kedua di server:
  - Hasil: kategori Keuangan, Kontrak & hukum, SDM, Harga, Publikasi, Data & akses, atau Operasional besar
    (penting); selain itu Informasi atau Permintaan data.
  - Dengan `approval_important_only` (default aktif), item yang tidak penting dicatat sebagai log tugas
    `approval_skipped`, bukan approval.
  - `GET /api/approvals` menyertakan `category`/`important` untuk antrean lama.

### Telegram: grup tim (topik per karyawan)

`src/telegram/team.js`, migrasi `008_telegram_team.sql` (`telegram_topics`, `telegram_settings.team_chat_id /
team_title / report_thread_id`).

- `/team` (`linkTeam`): memeriksa `is_forum` dan hak admin `can_manage_topics` (`getChatMember`).
  `syncTeamTopics` membuat topik yang hilang (`createForumTopic`, warna ikon = warna baju karakter terdekat dari 6
  warna Telegram) dan mengganti nama yang berubah (`editForumTopic`). Scheduler memanggil `maybeSyncTeam()`, yang
  hanya menyinkronkan jika ada perubahan (cek DB).
- Masuk: `bot.onUpdate` → `handleTopicMessage`. Pesan di topik karyawan dari User ID yang diizinkan →
  `sendOwnerMessage` (mode reply / task `/tugas` / note `/catat`, kanal = bisnis yang dikelola/ditempati atau HQ).
  Perintah lain dijawab di topik yang sama (`message_thread_id`).
- Keluar: `startTeamBridge` mendengar `chat:message`.
  - Jawaban, laporan, persetujuan, dan kegagalan karyawan yang ditujukan ke owner dikirim ke topiknya, dengan
    `personEmoji` (emoji pekerjaan + warna kulit karakter), nama, dan jabatan. Markdown diubah ke HTML Telegram.
  - Pesan owner dari dashboard dicerminkan. Pesan yang datang dari Telegram tidak digemakan balik.
  - Antrean ±3 detik per pesan karena batas ±20 pesan/menit per grup. Topik yang dihapus di Telegram dilupakan, lalu
    dibuat ulang pada sinkronisasi berikutnya.
  - `task:started` untuk tugas obrolan menampilkan "mengetik…" di topik.
- Laporan otomatis memakai `report_thread_id` (dari `/team` atau `/setchat` di dalam topik).

### Teks natural (tanpa JSON untuk manusia)

`src/lib/readable.js`: `readable()` mengubah JSON dari AI menjadi Markdown biasa (jawaban/ringkasan sebagai paragraf
pembuka, field lain sebagai "Label: nilai" atau daftar). JSON yang terpotong diselamatkan dari nilai teksnya. Prosa dan
kode di dalam prosa tidak diubah. `cleanError()` mengganti badan JSON di pesan error dengan pesannya.

- Di sumber: orchestrator memakai `planAnswer()` untuk rencana CEO/Manager tanpa daftar tugas atau yang gagal diurai,
  dan `readable()` untuk hasil kerja dan laporan sintesis (kecuali tugas meminta JSON). Error provider dibersihkan di
  `providers/base.js`. Prompt kerja dan laporan meminta teks/Markdown, bukan JSON.
- Di keluaran: obrolan dashboard (`holding/chat.js`), laporan data (`telegram/report.js`), notifikasi, dan topik tim
  memakai `readable()`/`cleanError()`, jadi hasil lama yang tersimpan sebagai JSON juga tampil natural.
- `src/telegram/format.js`: siapa yang berbicara (`speaker`, `personEmoji`), warna topik, dan `chatHtml()` (JSON →
  teks → HTML Telegram). Notifikasi tugas ditulis seperti pesan chat: pembicara, judul, isi, lalu model sebagai footer.

### Agen, alat, dan koneksi (Tahap 1 ala OpenClaw)

Migrasi `009_agents.sql`: `connections` (satu baris per layanan, rahasia di `secret_enc`), `artifacts` (indeks file di
layanan luar), dan kolom aksi di `approvals` (`action`, `action_status`, `action_result`, `action_at`).

- **Loop agen** (`src/agents/agent.js`): `runWork` → `runAgent()` bila `agent_enabled` dan ada alat. Protokol teks
  `<tool_call>{"name","args"}</tool_call>` (tanpa function calling provider), satu alat per balasan, hasil alat dikirim
  balik sebagai DATA. Berjalan di dalam satu `executeTask` (kantor tetap "working"). Batas `agent_max_steps`; anggaran
  `agent_max_tokens` (dibaca ulang dari DB tiap langkah); anggaran hampir habis → jawaban akhir. Log `tool_*` di tugas.
- **Registry alat** (`src/agents/tools/`): `{name, description, args, risk safe|important, connector, run, describe?}`,
  validator argumen sendiri, `toolsFor()` hanya alat yang koneksinya aktif.
- **Aksi penting**: `createActionApproval()` (`src/holding/approvals.js`) menyimpan alat + argumen; `decideApproval(s)`
  memicu `runApprovedAction()` (`src/agents/actions.js`, impor dinamis) yang mengklaim baris secara atomik, memvalidasi
  ulang, menjalankan alat, lalu emit `action:finished` (obrolan & Telegram). Ditolak → `cancelled`.
- **Koneksi** (`src/connections/store.js`): rahasia JSON terenkripsi `encryptSecret`, tidak pernah keluar dari server.
- **Google Drive** (`src/connections/google.js`): OAuth device flow (`/device/code`, polling `/token`, scope `drive.file`),
  refresh token terenkripsi, access token di memori, `invalid_grant` → `expired` + `system:alert`. Menghubungkan akun lain
  tidak memutus koneksi lama sampai yang baru diizinkan. Folder `AI Office/<bisnis>/<Dokumen|Laporan>`, Markdown →
  HTML (`src/lib/markdown.js`) diunggah multipart sebagai Google Docs; perbarui, ekspor teks, bagikan, Sampah.
- **Indeks & simpan otomatis** (`src/connections/artifacts.js`): `done()` di orchestrator mencoba menyimpan laporan dan
  hasil kerja panjang sebelum `finish()` (agar tautan ikut di notifikasi); gagal → `pending` dengan isi Markdown, diulang
  scheduler dengan jeda bertambah, maks 5 kali. Tautan dipakai notifier, obrolan, topik tim, detail tugas, menu File.
- **Aturan dasar karyawan**: `seed()` mengganti baris lama "tidak dapat mengeksekusi tindakan" sekali (flag
  `_tool_rule_v1`, hanya teks yang persis sama).
- Tes: `test/mock-google.js` meniru OAuth & Drive v3; `config.googleOAuthBase` / `googleApiBase` diarahkan ke sana.
