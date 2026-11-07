# Deploy ke VPS dengan aaPanel (Docker)

Target: VPS Linux RAM 1 GB, aaPanel, domain dengan HTTPS. Aplikasi berjalan sebagai **satu container**
yang hanya mendengarkan di `127.0.0.1:3000`. Nginx milik aaPanel menjadi reverse proxy HTTPS.
Panduan ini tidak mengubah konfigurasi server aaPanel secara otomatis; semua langkah dilakukan oleh admin.

## 1. Prasyarat

1. aaPanel terpasang dan dapat diakses.
2. **Docker** terpasang: aaPanel → *App Store* → cari **Docker** → Install (otomatis memasang Docker Engine + Compose).
3. Domain (mis. `office.example.com`) mengarah ke IP VPS (DNS A record).
4. (Disarankan untuk RAM 1 GB) swap 1 GB: aaPanel → *Linux Tools* → *Swap* → 1024 MB.

## 2. Unggah source code

Melalui SSH (atau aaPanel → *Files* → upload ZIP lalu extract):

```bash
mkdir -p /www/wwwroot/ai-holding && cd /www/wwwroot/ai-holding
# salin/extract isi proyek ke folder ini (Dockerfile, docker-compose.yml, src/, public/, package*.json, .env.example)
```

## 3. Konfigurasi `.env` dan folder data

```bash
cd /www/wwwroot/ai-holding
cp .env.example .env
openssl rand -base64 48        # salin hasilnya ke APP_SECRET di .env
nano .env                      # isi APP_SECRET, ADMIN_PASSWORD (min. 10 karakter), APP_URL=https://office.example.com
mkdir -p data
chown -R 1000:1000 data        # container berjalan sebagai user non-root "node" (uid 1000)
```

Simpan nilai `APP_SECRET` di tempat aman. Tanpa secret yang sama, API key yang tersimpan di backup tidak dapat dibaca.

## 4. Build & jalankan container

**Opsi A — aaPanel Docker UI:** aaPanel → *Docker* → *Compose* (atau *Container Orchestration*) → *Add* →
pilih folder `/www/wwwroot/ai-holding` (berisi `docker-compose.yml`) → beri nama `ai-holding` → *Confirm/Up*.

**Opsi B — SSH:**

```bash
cd /www/wwwroot/ai-holding
docker compose up -d --build
docker compose ps              # STATUS harus "healthy" setelah ±20 detik
docker compose logs -f         # Ctrl+C untuk keluar
curl -s http://127.0.0.1:3000/api/health
```

Build pertama di VPS 1 GB membutuhkan ±1–3 menit (hanya `npm ci` untuk 2 dependency, tanpa kompilasi native).

## 5. Website + reverse proxy + SSL

1. aaPanel → *Website* → *Add site* → domain `office.example.com`, PHP: *Static/Pure static*, tanpa database.
2. Buka site → *Reverse proxy* → *Add reverse proxy*:
   - Proxy name: `ai-holding`
   - Target URL: `http://127.0.0.1:3000`
   - Send domain: `$host`
3. Site → *SSL* → *Let's Encrypt* → centang domain → *Apply*, lalu aktifkan *Force HTTPS*.
4. Pastikan header berikut ada di konfigurasi proxy (aaPanel → Reverse proxy → *Config file*); tambahkan bila belum:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
client_max_body_size 2m;
```

`X-Forwarded-Proto` membuat cookie sesi diberi flag `Secure`, dan `X-Forwarded-For` membuat rate limit login
bekerja per IP pengguna.

5. Buka `https://office.example.com`, login dengan `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
   Jika `ADMIN_PASSWORD` dikosongkan, password sementara tercetak sekali di `docker compose logs`.

## 6. Konfigurasi awal di dashboard

1. **AI Providers** → buka *Katalog provider AI cloud* → *+ Tambah* (mis. Groq, Gemini, OpenRouter) → tempel API key →
   *Test connection* → *Ambil daftar model* → *Pilih model*. Tambahkan 2–3 provider sebagai cadangan.
2. (Opsional) **Model default per tingkatan** (Group CEO, Business Manager, Shared Services, staf bisnis).
3. **Business Directory**: ubah tiga bisnis contoh atau tambah bisnis Anda; isi knowledge base & keuangan.
4. **Telegram**: bot token dari @BotFather, Chat ID, User ID yang diizinkan, jam laporan → *Simpan* → *Kirim pesan tes*.

## 7. 9Router pada VPS yang sama (opsional)

9Router adalah gateway terpisah milik Anda (bukan bagian aplikasi ini). Jika dijalankan di host yang sama pada
port 20128, gunakan Base URL `http://host.docker.internal:20128/v1` (sudah dipetakan oleh `extra_hosts` di compose).
Perhatikan RAM: 9Router adalah aplikasi Next.js dan membutuhkan RAM jauh lebih besar daripada aplikasi ini.

## 8. Update aplikasi

```bash
cd /www/wwwroot/ai-holding
# 1) backup: dashboard → Settings → "Backup sekarang" → Unduh  (atau: docker compose stop && cp -a data ~/data-backup)
# 2) ganti source code dengan versi baru (JANGAN hapus folder data/ dan file .env)
docker compose up -d --build                    # 3) build ulang & jalankan
docker compose logs --tail=50   # cari "migration applied" dan "backup sebelum migrasi"
```

Migrasi database berjalan otomatis saat start, dan aplikasi membuat `data/backups/pre-migrate-*.db` sebelum migrasi.

## 9. Backup & restore

- Otomatis: setiap hari pada *Backup time* (Settings), disimpan `data/backups/auto-*.db` (retensi default 7 file).
- Manual: dashboard → *Settings* → *Backup sekarang* → *Unduh*. Atau via SSH: `cp data/backups/<file>.db ~/`.
- Simpan juga salinan `.env` (berisi `APP_SECRET`).

Restore:

```bash
cd /www/wwwroot/ai-holding
docker compose stop
cp data/office.db data/office.db.before-restore      # jaga-jaga
cp data/backups/<file-backup>.db data/office.db
rm -f data/office.db-wal data/office.db-shm
chown 1000:1000 data/office.db
docker compose start
```

Restore ke VPS baru: salin folder `data/` dan `.env` (dengan `APP_SECRET` yang sama), lalu `docker compose up -d --build`.

## 10. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| Container restart terus, log: "Folder data ... tidak dapat ditulis" | `chown -R 1000:1000 data` lalu `docker compose up -d`. |
| Log: "APP_SECRET harus minimal 32 karakter" | Isi `APP_SECRET` dengan nilai `openssl rand -base64 48`. |
| 502 Bad Gateway di domain | `docker compose ps` (harus healthy), target proxy `http://127.0.0.1:3000`, `HOST_PORT` di `.env` sesuai. |
| Login berhasil tetapi langsung keluar | Akses lewat HTTP biasa dengan `COOKIE_SECURE=true`. Gunakan HTTPS atau `COOKIE_SECURE=auto` + header `X-Forwarded-Proto`. |
| "Token CSRF tidak valid" | Muat ulang halaman (sesi berganti/kedaluwarsa). |
| Provider status "Key salah" | API key salah/kedaluwarsa: Edit provider → tempel key baru → Test connection. |
| Tugas berstatus Pending "coba lagi …" | Semua model gagal/kuota habis. Tambah provider cadangan atau tunggu reset kuota; tombol *Jalankan sekarang* di detail tugas. |
| Provider "Rate limited" sampai jam tertentu | Kuota harian free tier habis; router otomatis memakai provider/model lain. |
| Telegram tidak membalas perintah | Pastikan *Terima perintah (long polling)* aktif dan User ID Anda ada di daftar izin. `/start` menampilkan User ID. |
| Laporan harian tidak terkirim | Telegram → riwayat notifikasi (lihat error). Laporan dicoba ulang maks. 3× per hari dan tidak pernah dikirim dua kali. |
| RAM tinggi / OOM | `docker stats ai-virtual-holding`. Pastikan *Jumlah pekerjaan AI bersamaan* = 1; tambahkan swap. |
| Lupa password admin | `docker compose exec ai-holding node src/cli/reset-password.js admin 'PasswordBaru123'` (butuh akses SSH ke server). |
