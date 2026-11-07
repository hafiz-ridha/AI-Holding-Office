# Audit Proyek & Rencana Upgrade → AI Virtual Holding Company

Tanggal audit: 07-11-2026. Audit dilakukan terhadap source code di repositori ini sebelum modifikasi.

## 1. Arsitektur saat ini (v1, sebelum upgrade)

Satu proses Node.js 24 (Fastify 5) + SQLite bawaan (`node:sqlite`, WAL). Detail lengkap: [ARCHITECTURE.md](ARCHITECTURE.md).

```
Fastify ─ /api/auth, /api/health ─ guard (sesi + CSRF) ─ rate limit
Task queue (SQLite) → Orchestrator (CEO plan → subtask → sintesis) → Model Router → adapter provider
Event bus → (notifier Telegram: ditulis, belum dihubungkan)
```

## 2. Status fitur hasil audit

| Area | Status | Bukti |
|---|---|---|
| DB + migration runner + seed | Berfungsi | `test/01-core.test.js` (10 tes lulus) |
| Login, scrypt, sesi, CSRF, rate limit, audit log | Berfungsi (API) | `test/01-core.test.js` |
| Enkripsi API key (AES-256-GCM) + masking | Berfungsi | `test/01-core.test.js` |
| Adapter OpenRouter / 9Router / OpenAI-compatible | Berfungsi terhadap server mock; **belum diuji dengan API key asli** | `test/02-router.test.js` |
| Model Router (fallback, cooldown 429, kuota harian, batas percobaan) | Berfungsi | `test/02-router.test.js` (11 tes) |
| Employee CRUD + memori | Berfungsi (service, belum ada endpoint) | `test/02-router.test.js` |
| Orchestrator + task queue + recovery restart + cancel | Berfungsi | `test/03-orchestrator.test.js` (7 tes) |
| Telegram client, notifier, laporan harian | **Sebagian**: modul ditulis, belum dihubungkan, belum diuji | — |
| Telegram bot (commands), scheduler, backup | **Belum ada** | — |
| REST API untuk tasks/employees/providers/settings | **Belum ada** | — |
| Dashboard frontend + kantor pixel art | **Belum ada** (`public/index.html` placeholder) | — |
| Dockerfile, compose, README, panduan aaPanel | **Belum ada** | — |

Kesimpulan: belum ada deployment dan belum ada data produksi. Upgrade tetap dikerjakan sebagai
migrasi aditif agar database v1 (jika ada) dapat ditingkatkan tanpa kehilangan data.

## 3. Fitur yang perlu ditambahkan

1. Entitas **bisnis** (CRUD dari dashboard, logo, industri, status, Business Manager, karyawan).
2. Struktur organisasi: Group CEO → Business Manager → staf bisnis; Shared Services (Group Finance,
   Secretary, Researcher, Developer, HR) yang tidak diduplikasi per bisnis.
3. Hierarki tugas: Holding Task → Business Task → Employee Subtask, semuanya membawa `business_id`.
4. Isolasi data per bisnis: tasks, conversations, memories, documents/knowledge base, laporan,
   catatan keuangan, penugasan karyawan, log aktivitas.
5. Knowledge base per bisnis (SQLite FTS5), dokumen dapat dibagikan ke bisnis lain hanya dengan izin.
6. Catatan keuangan per bisnis (pemasukan/pengeluaran) untuk Group Finance dan `/finance`.
7. Laporan bisnis & laporan konsolidasi holding.
8. Persetujuan owner (approval) untuk rekomendasi berisiko + notifikasi Telegram.
9. Model default per tingkatan: Group CEO, Business Manager, Shared Services, staf bisnis.
10. Telegram: laporan harian format holding, `/overview /companies /report /tasks /finance /pause /resume /business <slug>`.
11. Dashboard: Holding Overview, Business Directory, Business Detail, Organization, Shared Services,
    Consolidated Reports, Virtual Office dengan area holding/unit bisnis/shared/meeting.

## 4. File yang akan dimodifikasi / dibuat

Dimodifikasi: `src/db/migrate.js` (backup otomatis sebelum migrasi), `src/db/seed.js` (struktur holding +
jalur upgrade), `src/agents/*` (konteks terisolasi, prompt holding), `src/queue/tasks.js` (hierarki),
`src/router/modelRouter.js` (model default per tingkatan), `src/lib/settings.js`, `src/telegram/*`,
`src/routes/index.js`, `src/app.js`.

Dibuat: `src/db/migrations/002_holding.sql`, `src/holding/*` (businesses, documents, finance, reports,
approvals, context), `src/telegram/bot.js`, `src/scheduler/index.js`, `src/services/backup.js`,
`src/routes/*`, `src/server.js`, seluruh `public/`, Docker & dokumentasi, tes baru.

## 5. Risiko perubahan database

| Risiko | Mitigasi |
|---|---|
| Kehilangan data saat migrasi | Backup otomatis `pre-migrate-*.db` sebelum migrasi baru dijalankan pada DB yang sudah berisi data. Setiap migrasi berjalan dalam transaksi. |
| Kolom baru memecah query lama | Semua kolom baru `NULL`-able / punya default; tidak ada kolom yang dihapus atau diganti nama. |
| Data lama tanpa `business_id` | `NULL` = konteks holding/umum. Data lama tetap tampil di level holding dan tidak bocor ke bisnis mana pun. |
| Kebocoran konteks antarbisnis | Satu modul `src/holding/context.js` menjadi satu-satunya pintu pembentuk konteks AI; diuji otomatis dengan data rahasia per bisnis. |
| Perubahan peran karyawan lama | Karyawan v1 tidak dihapus; hanya diklasifikasikan (`org_unit`). CEO v1 menjadi Group CEO. |

## 6. Strategi migrasi yang aman

1. Aplikasi membuat backup `VACUUM INTO data/backups/pre-migrate-<tanggal>.db` bila ada migrasi baru.
2. `002_holding.sql` hanya `CREATE TABLE`, `CREATE INDEX`, dan `ALTER TABLE … ADD COLUMN`.
3. Seed upgrade bersifat idempoten (ditandai di `system_settings`), hanya menambah data yang belum ada.
4. Diuji: database v1 berisi data → migrasi → data lama utuh + struktur holding tersedia.
5. Rollback: hentikan container, salin file backup `pre-migrate-*.db` menjadi `office.db`, jalankan
   image versi sebelumnya.
