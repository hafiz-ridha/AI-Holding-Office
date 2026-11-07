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
| Model bisa diganti | Provider, model default, fallback, dan model per karyawan disimpan di DB dan diubah dari dashboard. |
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
2. Provider default + model default.
3. Model fallback provider default (daftar berurutan dari admin, termasuk model gratis).
4. Provider cadangan lain yang aktif (urut prioritas): model default lalu fallback-nya.
5. Semua gagal → tugas kembali `pending` dengan jadwal ulang (backoff), notifikasi System Alert.
   Setelah `max_task_attempts` (default 3) → `failed`.

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
