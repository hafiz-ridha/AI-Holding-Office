import { get, post, put } from '../api.js';
import { h, mount, badge, field, toast, errToast, fmtDate, emptyState } from '../ui.js';

export async function render(root, _params, ctx) {
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
    ];
    const save = async () => {
      const body = {
        chat_id: chat.value.trim(), allowed_user_ids: users.value.split(/[\s,]+/).filter(Boolean), report_time: time.value, timezone: tz.value.trim(),
        ...Object.fromEntries(flags.map((f) => [f.key, f.i.checked])),
      };
      if (token.value.trim()) body.bot_token = token.value.trim();
      await put('/api/telegram', body);
      token.value = '';
      toast('Pengaturan Telegram disimpan', 'ok');
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
    mount(root, h('div', { class: 'stack' },
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'card stack' },
          h('div', { class: 'row-between' }, h('h2', null, 'Konfigurasi bot'), badge(d.bot.status === 'running' ? 'ok' : d.bot.status === 'error' ? 'error' : 'pending', d.bot.status === 'running' ? `Aktif${s.bot_username ? ` @${s.bot_username}` : ''}` : d.bot.status === 'error' ? 'Error' : 'Tidak aktif')),
          d.bot.message ? h('p', { class: 'small muted', style: { margin: 0 } }, d.bot.message) : null,
          field('Bot token (dari @BotFather)', token, 'Divalidasi ke Telegram lalu disimpan terenkripsi.'),
          field('Chat ID tujuan laporan', chat, 'Kirim /start ke bot untuk melihat Chat ID.'),
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
