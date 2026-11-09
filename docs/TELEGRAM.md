# Pengaturan Bot Telegram (@BotFather)

Panduan ini menyiapkan bot Telegram untuk AI Virtual Holding dari nol. Hasilnya:

- laporan harian holding,
- notifikasi tugas, error, dan persetujuan owner,
- perintah seperti `/overview` dan `/task` dari HP.

Bot memakai *long polling*: server yang menghubungi Telegram, bukan sebaliknya. Tidak perlu domain, HTTPS, webhook, atau
membuka port masuk. Server hanya perlu bisa mengakses `api.telegram.org` (koneksi keluar).

Waktu yang dibutuhkan sekitar 5 menit.

## 1. Membuat bot di @BotFather

1. Buka Telegram (HP atau desktop). Cari **@BotFather**, akun resmi bercentang biru, atau buka <https://t.me/BotFather>.
   Tekan **Start**.
2. Kirim `/newbot`.
3. Isi **nama tampilan** bot. Nama ini bebas dan boleh berspasi, misalnya `AI Holding Saya`.
4. Isi **username** bot. Username harus unik, tanpa spasi, dan diakhiri `bot`, misalnya `holding_saya_bot`. Jika sudah dipakai
   orang lain, BotFather meminta username lain.
5. BotFather membalas dengan **token**, bentuknya seperti `123456789:AAH...` (angka, titik dua, sekitar 35 karakter). Salin token itu.

> **Token adalah kunci penuh bot.** Siapa pun yang memegangnya bisa mengendalikan bot. Jangan bagikan ke orang lain,
> jangan tempel di grup, dan jangan simpan di Git. Cukup tempel di dashboard. Di sana token disimpan terenkripsi dan tidak
> pernah ditampilkan lagi.

## 2. Pengaturan opsional di BotFather

Semua pengaturan ini juga tersedia lewat tombol: kirim `/mybots`, pilih bot, lalu **Edit Bot** atau **Bot Settings**.

| Perintah BotFather | Fungsi | Saran |
|---|---|---|
| `/setjoingroups` | Boleh tidaknya bot dimasukkan ke grup | **Disable** jika laporan hanya ke chat pribadi. Orang lain jadi tidak bisa memasukkan bot Anda ke grup mereka. Pilih **Enable** jika laporan dikirim ke grup. |
| `/setprivacy` | Privacy mode di grup | Biarkan **Enabled**. Bot hanya perlu perintah, tidak perlu membaca obrolan grup. |
| `/setuserpic` | Foto profil bot | Opsional |
| `/setdescription`, `/setabouttext` | Teks yang muncul sebelum orang menekan Start | Opsional, misalnya "Bot internal holding, hanya untuk owner." |
| `/setcommands` | Menu perintah | **Tidak perlu.** Aplikasi mengisi menu perintah otomatis setiap kali bot aktif. |

## 3. Menghubungkan bot ke dashboard

1. Login ke dashboard, lalu buka menu **Telegram**.
2. Tempel token di **Bot token (dari @BotFather)**. Pastikan **Terima perintah (long polling)** tercentang (bawaan),
   lalu klik **Simpan**.
   - Token dicek langsung ke Telegram. Jika salah, muncul pesan error dan tidak ada yang tersimpan.
   - Jika benar, status di kanan atas kartu berubah menjadi **Aktif @username_bot**.
3. Buka bot Anda di Telegram (`https://t.me/username_bot`), lalu tekan **Start** atau kirim `/start`. ID Anda belum
   diizinkan, jadi bot membalas:
   `Akses ditolak. User ID Telegram Anda: 123456789`
4. Kembali ke dashboard. Isi angka tersebut di dua kolom, lalu klik **Simpan**:
   - **User ID yang diizinkan memberi perintah**.
   - **Chat ID tujuan laporan**. Untuk chat pribadi, Chat ID sama dengan User ID.
5. Kirim `/start` sekali lagi. Sekarang bot menyapa Anda, menampilkan Chat ID, dan daftar perintah.
6. Klik **Kirim pesan tes**. Jika pesan "Tes AI Virtual Holding" masuk di Telegram, koneksi selesai.
7. Untuk laporan harian, centang **Laporan harian otomatis** (bawaan mati). Atur **Jam laporan harian** dan
   **Zona waktu** (default `Asia/Jakarta`), lalu **Simpan**. Klik **Kirim laporan sekarang** untuk mencoba tanpa menunggu jam laporan.
8. Atur notifikasi sesuai kebutuhan: tugas dimulai, selesai, gagal, serta system alert dan persetujuan owner.
   **Sertakan business task & subtugas** membuat notifikasi lebih ramai, jadi biarkan mati jika cukup ringkasan.

Menambah orang lain, misalnya partner: minta mereka mengirim `/start` ke bot, lalu tambahkan User ID mereka ke daftar
izin, dipisah koma.

## 4. Laporan ke grup (opsional)

1. Pastikan `/setjoingroups` di BotFather berstatus **Enable**.
2. Tambahkan bot ke grup seperti menambah anggota biasa.
3. Di grup, kirim `/start@username_bot`. Sertakan nama bot agar perintah sampai walaupun privacy mode aktif.
   Pengirimnya harus sudah ada di daftar User ID yang diizinkan.
4. Bot membalas Chat ID grup. Untuk grup, angkanya negatif, misalnya `-1001234567890`. Isi angka itu di **Chat ID tujuan laporan**,
   klik **Simpan**, lalu klik **Kirim pesan tes**.

Semua anggota grup bisa membaca laporan, tetapi hanya User ID di daftar izin yang bisa memberi perintah. Di grup,
tulis perintah dengan nama bot, misalnya `/overview@username_bot`.

**Channel:** jadikan bot **admin** channel dengan izin *Post Messages*, lalu isi Chat ID dengan `@namachannel` untuk channel
publik. Untuk channel privat, isi dengan ID `-100…`, yang terlihat di alamat Telegram Web
(`web.telegram.org/a/#-100…`). Channel hanya menerima laporan. Perintah tetap dikirim lewat chat pribadi atau grup.

## 5. Keamanan

- **Token bocor?** Di BotFather kirim `/mybots`, pilih bot, pilih **API Token**, lalu **Revoke current token**. Token lama
  langsung mati. Tempel token baru di dashboard, lalu klik **Simpan**.
- Hanya User ID di daftar izin yang dilayani. Perintah dari orang lain diabaikan tanpa balasan dan dicatat di log server.
  Pengecualian hanya `/start`, yang menampilkan User ID pengirim.
- Bot tidak pernah menjalankan tindakan berisiko. Persetujuan owner tetap diputuskan di dashboard, menu **Approvals**.
- **Satu token untuk satu server.** Jangan memakai token yang sama di laptop (pengembangan) dan VPS sekaligus, karena keduanya
  berebut pesan dan muncul error `409 Conflict`. Untuk uji coba, buat bot kedua di BotFather.

## 6. Masalah umum

| Gejala | Penyebab dan solusi |
|---|---|
| `Format bot token tidak valid` | Token terpotong atau ada spasi. Salin ulang token lengkap dari BotFather (`/mybots`, pilih bot, **API Token**). |
| `Bot token ditolak Telegram: … Unauthorized` | Token salah atau sudah di-*revoke*. Ambil token terbaru di BotFather. |
| `Tidak dapat terhubung ke Telegram` atau `Timeout` | Server tidak bisa mengakses `api.telegram.org`. Periksa firewall, DNS, atau proxy VPS. |
| Status **Error** atau **Tidak aktif**, bot diam | Pastikan **Terima perintah (long polling)** tercentang, lalu klik **Simpan**. Baca pesan di bawah status. |
| Bot membalas "Akses ditolak" | User ID belum ada di daftar izin, atau belum disimpan. |
| Pesan tes gagal `chat not found` | Chat ID salah, Anda belum pernah menekan **Start** di bot (bot tidak bisa memulai chat duluan), atau bot belum dimasukkan ke grup. |
| `bot was blocked by the user` | Buka bot di Telegram, lalu pilih **Unblock** atau **Restart**. |
| `409 Conflict` | Token yang sama sedang dipakai server lain. Matikan instance lain atau buat bot baru. Webhook lama dihapus otomatis oleh aplikasi. |
| Di grup bot tidak merespons | Tulis perintah dengan nama bot (`/overview@username_bot`), dan pastikan pengirim ada di daftar izin. |
| Laporan harian tidak terkirim | Pastikan **Laporan harian otomatis** dicentang. Lihat error di **Riwayat notifikasi**. Laporan dicoba ulang maksimal 3× per hari dan tidak pernah terkirim dua kali. |

Daftar perintah bot ada di [README](../README.md#laporan-telegram).
