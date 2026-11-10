import { get, post, put, del } from '../api.js';
import { h, mount, badge, field, toast, errToast, fmtDate, emptyState, confirmDialog } from '../ui.js';
import { avatarCanvas } from '../office/sprites.js';

const GUIDE_URL = 'https://github.com/hafiz-ridha/AI-Holding-Office/blob/main/docs/TELEGRAM.md';

export function botBadge(state, username = '') {
  if (state.status === 'running') return badge('ok', `Aktif${username ? ` @${username}` : ''}`);
  if (state.status === 'error') return badge('error', 'Error');
  return badge('pending', state.status === 'starting' ? 'Menghubungkan…' : 'Tidak aktif');
}

const ext = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
const kbd = (t) => h('span', { class: 'kbd' }, t);

// Step-by-step BotFather setup. Each step is ticked from the saved settings, so the owner sees what is left.
function setupGuide(s, history, open, onToggle) {
  const botLink = s.bot_username ? ext(`https://t.me/${s.bot_username}`, `@${s.bot_username} ↗`) : 'bot Anda';
  const delivered = history.some((r) => r.status === 'sent' && r.type !== 'command');
  const steps = [
    [s.has_bot_token, 'Buat bot di @BotFather.', ['Buka ', ext('https://t.me/BotFather', '@BotFather ↗'), ' (akun resmi bercentang biru), kirim ', kbd('/newbot'),
      ', isi nama tampilan, lalu username yang diakhiri ', kbd('bot'), ' (mis. holding_saya_bot). BotFather membalas token seperti ', kbd('123456789:AAH…'), '.']],
    [s.has_bot_token, 'Tempel token, lalu Simpan.', ['Isi kolom "Bot token" di bawah. Token dicek ke Telegram dan disimpan terenkripsi, lalu status berubah menjadi Aktif. Jangan bagikan token ke siapa pun.']],
    [s.allowed_user_ids.length > 0 && Boolean(s.chat_id), 'Kirim /start ke bot, lalu daftarkan ID Anda.', ['Buka ', botLink, ' dan tekan Start. Bot membalas "Akses ditolak. User ID Telegram Anda: …". Isi angka itu di ',
      h('strong', null, 'User ID yang diizinkan'), ', lalu Simpan. Setelah itu kirim ', kbd('/setchat'), ' dari chat tujuan (chat pribadi atau grup): chat itu langsung menjadi tujuan laporan.']],
    [delivered, 'Klik Kirim pesan tes.', ['Jika pesan "Tes AI Virtual Holding" masuk di Telegram, koneksi selesai. Bila gagal, lihat error di Riwayat notifikasi.']],
    [s.report_enabled, 'Nyalakan laporan harian.', ['Centang "Laporan harian otomatis", atur jam dan zona waktu, lalu Simpan. Coba dengan "Kirim laporan sekarang".']],
  ];
  const done = steps.filter(([ok]) => ok).length;
  const el = h('details', { class: 'card', open },
    h('summary', null, h('strong', null, 'Cara menyiapkan bot (@BotFather)'),
      h('span', { class: 'small muted' }, ` · ${done}/${steps.length} langkah selesai`)),
    h('ol', { class: 'setup-steps' }, steps.map(([ok, title, body]) => h('li', { class: ok ? 'done' : null },
      h('div', null, h('strong', null, title), h('div', { class: 'small muted' }, body))))),
    h('div', { class: 'small muted setup-notes' },
      h('div', null, h('strong', null, 'Grup: '), 'aktifkan ', kbd('/setjoingroups'), ' di BotFather, tambahkan bot ke grup, kirim ', kbd(`/start@${s.bot_username || 'username_bot'}`),
        ', lalu pakai Chat ID grup yang dibalas bot (angka negatif, mis. -100…).'),
      h('div', null, h('strong', null, 'Token bocor? '), 'BotFather → ', kbd('/mybots'), ' → pilih bot → API Token → Revoke, lalu tempel token baru di sini.'),
      h('div', null, 'Menu perintah bot terisi otomatis, jadi ', kbd('/setcommands'), ' tidak perlu. Satu token hanya untuk satu server. ', ext(GUIDE_URL, 'Panduan lengkap ↗'))));
  el.addEventListener('toggle', () => onToggle(el.open));
  return el;
}

// Team group: one Telegram topic per AI employee (talk to each one directly), set up with /team in the group.
function teamCard(d, s, btn, redraw) {
  const t = d.team;
  const botName = s.bot_username ? `@${s.bot_username}` : 'bot Anda';
  if (!t) {
    return h('details', { class: 'card' },
      h('summary', null, h('strong', null, 'Grup tim: satu topik per karyawan'), h('span', { class: 'small muted' }, ' · ngobrol langsung dengan setiap karyawan AI dan Group CEO di Telegram')),
      h('ol', { class: 'small', style: { margin: '10px 0 0', paddingLeft: '20px', display: 'grid', gap: '4px' } },
        h('li', null, 'Buat grup baru di Telegram (mis. "AI Holding Team").'),
        h('li', null, 'Info grup → Edit → aktifkan ', h('b', null, 'Topics'), '.'),
        h('li', null, 'Tambahkan ', h('b', null, botName), ' ke grup dan jadikan ', h('b', null, 'admin'), ' dengan izin ', h('b', null, 'Kelola topik'), ' (Manage topics).'),
        h('li', null, 'Kirim ', h('span', { class: 'kbd' }, '/team'), ' di grup itu. Bot membuat satu topik per karyawan + topik "📊 Laporan & Notifikasi".')),
      h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'Tulis di topik seorang karyawan untuk bicara langsung dengannya (balasan cepat AI, tersinkron dengan Obrolan di dashboard). /tugas … = tugas penuh, /catat … = catatan. Hanya User ID yang diizinkan yang ditanggapi; isolasi data antarbisnis tetap berlaku.'));
  }
  const staff = t.topics.filter((x) => x.kind === 'employee');
  return h('div', { class: 'card stack-sm' },
    h('div', { class: 'row-between' },
      h('div', null, h('h3', { style: { margin: 0 } }, `Grup tim: ${t.title || t.chat_id}`),
        h('div', { class: 'small muted' }, `${staff.length} topik karyawan${t.pending ? ` · ${t.pending} perlu disinkronkan` : ''}${t.syncing ? ' · sedang menyinkronkan…' : ''} · laporan ${t.reports_here ? 'masuk ke topik 📊' : 'dikirim ke tempat lain'}`)),
      h('div', { class: 'row' },
        btn('Sinkronkan topik', async () => {
          const r = await post('/api/telegram/team/sync');
          toast(`${r.created} topik dibuat, ${r.renamed} diperbarui${r.errors.length ? ` · ${r.errors[0]}` : ''}`, r.errors.length ? 'error' : 'ok');
          redraw();
        }, 'btn-sm'),
        btn('Lepas grup', async () => {
          if (!(await confirmDialog('Lepas grup tim? Topik di Telegram tetap ada, tetapi pesan di sana tidak diteruskan lagi ke karyawan.', { danger: true, okLabel: 'Lepas' }))) return;
          await del('/api/telegram/team');
          toast('Grup tim dilepas', 'ok');
          redraw();
        }, 'btn-sm btn-ghost btn-danger'))),
    h('div', { class: 'team-topics' }, t.topics.map((x) => h('a', { class: `team-topic${x.enabled ? '' : ' off'}`, href: x.link, target: '_blank', rel: 'noopener noreferrer', title: 'Buka topik di Telegram' },
      x.employee_id && x.avatar ? avatarCanvas(x.avatar, 1) : h('span', { class: 'team-ico', 'aria-hidden': 'true' }, x.employee_id ? x.icon : ''), h('span', { class: 'grow' }, x.name)))),
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Balasan ditandai emoji pekerjaan dengan warna kulit karakter di kantor virtual, nama, dan jabatan. Karyawan baru otomatis mendapat topik. /tugas … = tugas penuh, /catat … = catatan.'));
}

export async function render(root, _params, ctx) {
  // Keeps the guide as it is (open or closed) while the page re-renders after each save; a fresh visit opens it
  // only until the essential steps are done.
  let guideOpen = null;
  const draw = async () => {
    const [d, history] = await Promise.all([get('/api/telegram'), get('/api/telegram/history')]);
    const s = d.settings;
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: s.has_bot_token ? `Tersimpan (${s.bot_token_hint}). Kosongkan bila tidak diubah.` : '123456789:AA...' });
    const chat = h('input', { value: s.chat_id, placeholder: 'Contoh: 123456789 atau -1001234567890' });
    const users = h('input', { value: s.allowed_user_ids.join(', '), placeholder: 'User ID dipisah koma' });
    const time = h('input', { type: 'time', value: s.report_time });
    const tz = h('input', { value: s.timezone, maxlength: 64 });
    const box = (key, label) => {
      const i = h('input', { type: 'checkbox', checked: s[key] });
      return { key, i, el: h('label', { class: 'check' }, i, label) };
    };
    const flags = [
      box('report_enabled', 'Laporan harian otomatis'), box('polling_enabled', 'Terima perintah (long polling)'),
      box('notify_task_started', 'Notifikasi tugas dimulai'), box('notify_task_completed', 'Notifikasi tugas selesai'),
      box('notify_task_failed', 'Notifikasi tugas gagal'), box('notify_system_alert', 'System alert & persetujuan owner'),
      box('notify_subtasks', 'Sertakan business task & subtugas (lebih ramai)'),
      box('split_messages', 'Kirim laporan per bagian (beberapa pesan pendek dengan indikator "mengetik…", terasa lebih natural)'),
    ];
    const save = async () => {
      const body = {
        chat_id: chat.value.trim(), allowed_user_ids: users.value.split(/[\s,]+/).filter(Boolean), report_time: time.value, timezone: tz.value.trim(),
        ...Object.fromEntries(flags.map((f) => [f.key, f.i.checked])),
      };
      if (token.value.trim()) body.bot_token = token.value.trim();
      const r = await put('/api/telegram', body);
      token.value = '';
      toast(r.chat?.label ? `Pengaturan disimpan · tujuan laporan: ${r.chat.label}` : 'Pengaturan Telegram disimpan', 'ok');
      draw();
    };
    const btn = (label, fn, cls = '') => h('button', { class: `btn ${cls}`, type: 'button', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        await fn();
      } catch (e) {
        errToast(e);
      } finally {
        ev.target.disabled = false;
      }
    } }, label);
    const essentials = s.has_bot_token && s.allowed_user_ids.length > 0 && Boolean(s.chat_id);
    // Automatic sends failing (wrong Chat ID) while commands work: offer the chat the owner last wrote from.
    const lc = d.last_command_chat;
    const la = d.last_auto;
    const broken = s.has_bot_token && (!s.chat_id || (la?.status === 'failed' && la.chat_id === s.chat_id && /chat not found|Chat ID|blocked|kicked|not a member/i.test(la.error || '')));
    const fixCard = broken
      ? h('div', { class: 'card tg-fix stack-sm' },
          h('strong', null, s.chat_id ? `Pengiriman otomatis gagal ke Chat ID ${s.chat_id}` : 'Chat ID tujuan laporan belum diatur'),
          la?.error && s.chat_id ? h('div', { class: 'small muted' }, la.error) : null,
          h('div', { class: 'small' }, 'Balasan perintah (mis. /report) tetap jalan karena dikirim ke chat asal perintah, sedangkan laporan & notifikasi otomatis dikirim ke Chat ID di bawah.'),
          lc && lc.chat_id !== s.chat_id
            ? h('div', { class: 'row' },
                h('span', { class: 'small grow' }, 'Perintah terakhir Anda datang dari ', h('b', null, lc.label), ` (Chat ID ${lc.chat_id}).`),
                btn('Pakai chat ini sebagai tujuan', async () => {
                  const r = await put('/api/telegram', { chat_id: lc.chat_id });
                  toast(`Tujuan laporan: ${r.chat?.label || lc.label}`, 'ok');
                  draw();
                }, 'btn-primary btn-sm'))
            : h('div', { class: 'small' }, 'Cara termudah: buka chat tujuan (chat pribadi dengan bot atau grup), lalu kirim ', h('span', { class: 'kbd' }, '/setchat'), '.'))
      : null;
    mount(root, h('div', { class: 'stack' },
      fixCard,
      setupGuide(s, history, guideOpen ?? !essentials, (v) => { guideOpen = v; }),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'card stack' },
          h('div', { class: 'row-between' }, h('h2', null, 'Konfigurasi bot'), botBadge(d.bot, s.bot_username)),
          d.bot.message ? h('p', { class: 'small muted', style: { margin: 0 } }, d.bot.message) : null,
          field('Bot token (dari @BotFather)', token, 'Divalidasi ke Telegram lalu disimpan terenkripsi.'),
          field('Chat ID tujuan laporan', chat, 'Dicek ke Telegram saat disimpan. Paling mudah: kirim /setchat dari chat tujuan. Chat pribadi = User ID Anda (bukan angka di depan token); grup = angka negatif (-100…).'),
          field('User ID yang diizinkan memberi perintah', users, 'Perintah dari user lain diabaikan. /start menampilkan User ID pengirim.'),
          h('div', { class: 'form-grid' }, field('Jam laporan harian', time), field('Zona waktu', tz)),
          h('div', { class: 'stack-sm' }, flags.map((f) => f.el)),
          h('div', { class: 'row' }, btn('Simpan', save, 'btn-primary'), btn('Kirim pesan tes', async () => {
            const r = await post('/api/telegram/test');
            toast(r.ok ? 'Pesan tes terkirim' : `Gagal: ${r.error}`, r.ok ? 'ok' : 'error');
            draw();
          }), btn('Kirim laporan sekarang', async () => {
            const r = await post('/api/telegram/report-now', {});
            toast(r.ok ? 'Laporan holding terkirim' : `Gagal: ${r.error}`, r.ok ? 'ok' : 'error');
            draw();
          }))),
        h('div', { class: 'card stack' },
          h('h2', null, 'Perintah bot'),
          h('div', { class: 'list' }, d.commands.map((c) => h('div', { class: 'list-item' }, h('span', { class: 'kbd' }, c.command), h('span', { class: 'small' }, c.description)))),
          h('p', { class: 'small muted' }, 'Perintah per bisnis bersifat dinamis: /business <slug>, /tasks <slug>, /report <slug>, /task @slug <instruksi>. Slug dapat dilihat dengan /companies atau di Business Directory.'),
          h('p', { class: 'small muted' }, `Laporan harian terakhir: ${d.today_report ? `${d.today_report.status} (${fmtDate(d.today_report.updated_at)}${d.today_report.error ? `, ${d.today_report.error}` : ''})` : 'belum ada'}. Laporan dikunci satu kali per tanggal sehingga tidak terkirim dua kali, juga setelah container restart.`))),
      teamCard(d, s, btn, draw),
      h('div', { class: 'card card-flush' },
        h('div', { style: { padding: '12px 16px' } }, h('h3', null, 'Riwayat notifikasi')),
        history.length
          ? h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null, h('th', null, 'Waktu'), h('th', null, 'Jenis'), h('th', null, 'Status'), h('th', null, 'Isi / error'))),
              h('tbody', null, history.map((r) => h('tr', null,
                h('td', { class: 'small nowrap' }, fmtDate(r.created_at)), h('td', { class: 'small' }, r.type + (r.report_date ? ` ${r.report_date}` : '')),
                h('td', null, badge(r.status)), h('td', { class: 'small' }, r.error ? h('span', { style: { color: 'var(--err)' } }, r.error) : (r.message || '').replace(/<[^>]+>/g, '').slice(0, 160)))))))
          : emptyState('Belum ada pesan.'))));
  };
  await draw();
}
