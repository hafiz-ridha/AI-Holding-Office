// Connections to outside services. Google Drive (personal Gmail) is linked with a device code: no domain or HTTPS
// needed. Secrets are entered here but never shown again (only a hint). GitHub, Vercel, Netlify and Supabase follow
// in the next stages.
import { get, post, put, del } from '../api.js';
import { h, mount, field, toast, errToast, confirmDialog, fmtDate } from '../ui.js';

const kbd = (t) => h('code', { class: 'kbd' }, t);
const ext = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
const STATUS = {
  connected: ['Terhubung', 'b-completed'],
  pending: ['Menunggu kode dimasukkan', 'b-processing'],
  expired: ['Perlu dihubungkan ulang', 'b-failed'],
  error: ['Error', 'b-failed'],
  disconnected: ['Belum terhubung', 'b-pending'],
};
const NEXT = {
  github: 'Menyimpan kode program; juga jalur ke Cloudflare Pages & GitHub Pages.',
  vercel: 'Menerbitkan website buatan karyawan AI.',
  netlify: 'Menerbitkan website buatan karyawan AI.',
  supabase: 'Database gratis untuk website/aplikasi, dan penyimpanan gambar.',
};

function guide(g) {
  const steps = [
    [Boolean(g.client_id), 'Buat project di Google Cloud (gratis).', ['Buka ', ext('https://console.cloud.google.com/', 'Google Cloud Console ↗'), ' dengan akun Gmail Anda, lalu buat project baru, misalnya "AI Office".']],
    [Boolean(g.client_id), 'Aktifkan Google Drive API.', ['Menu APIs & Services → Library → cari ', kbd('Google Drive API'), ' → Enable.']],
    [Boolean(g.client_id), 'Atur layar persetujuan OAuth.', ['Google Auth Platform → Branding: isi nama aplikasi dan email. Audience: pilih External, lalu klik ', h('strong', null, 'Publish app'),
      ' (status In production) agar akses tidak kedaluwarsa tiap 7 hari. Izin yang dipakai hanya ', kbd('drive.file'), ' (non-sensitif): AI Office hanya bisa melihat file yang dibuatnya sendiri.']],
    [Boolean(g.client_id && g.has_client_secret), 'Buat OAuth Client tipe "TVs and Limited Input devices".', ['Clients → Create client → Application type ', h('strong', null, 'TVs and Limited Input devices'),
      '. Salin Client ID dan Client Secret ke formulir di bawah, lalu Simpan.']],
    [g.status === 'connected', 'Hubungkan dengan kode.', ['Klik Hubungkan. Buka ', kbd('google.com/device'), ', masukkan kodenya, pilih akun Gmail Anda, lalu Izinkan. Tidak perlu domain atau HTTPS di server.']],
  ];
  const done = steps.filter(([ok]) => ok).length;
  return h('details', { class: 'card', open: g.status !== 'connected' },
    h('summary', null, h('strong', null, 'Cara menghubungkan Google Drive (Gmail pribadi)'), h('span', { class: 'small muted' }, ` · ${done}/${steps.length} langkah selesai`)),
    h('ol', { class: 'setup-steps' }, steps.map(([ok, title, body]) => h('li', { class: ok ? 'done' : null },
      h('div', null, h('strong', null, title), h('div', { class: 'small muted' }, body))))),
    h('div', { class: 'small muted setup-notes' },
      h('div', null, 'Setelah terhubung, dokumen dan laporan hasil kerja karyawan AI tersimpan di folder ', kbd('AI Office/<bisnis>/Dokumen'), ' dan ', kbd('…/Laporan'),
        ' sebagai Google Docs, jadi ikut tersinkron di aplikasi Google Drive Anda.'),
      h('div', null, 'Membagikan atau menghapus file selalu menunggu persetujuan Anda di Approvals.')));
}

function codeBox(p, onCheck) {
  const left = h('span', { class: 'small muted' });
  const tick = () => {
    const s = Math.max(0, Math.round((p.expires_at - Date.now()) / 1000));
    left.textContent = s ? `berlaku ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} lagi` : 'kode kedaluwarsa, klik Hubungkan lagi';
  };
  tick();
  const timer = setInterval(() => (left.isConnected ? tick() : clearInterval(timer)), 1000);
  return h('div', { class: 'device-code' },
    h('div', { class: 'small muted' }, '1. Buka ', ext(p.verification_url, p.verification_url.replace(/^https?:\/\//, '') + ' ↗'), ' di HP atau komputer mana saja.'),
    h('div', { class: 'small muted' }, '2. Masukkan kode ini, pilih akun Gmail Anda, lalu Izinkan:'),
    h('div', { class: 'device-code-value mono' }, p.user_code),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: onCheck }, 'Sudah, cek sekarang'), left));
}

function driveCard(g, redraw) {
  const [label, cls] = STATUS[g.status] || STATUS.disconnected;
  const clientId = h('input', { value: g.client_id || '', placeholder: '1234567890-abc….apps.googleusercontent.com', autocomplete: 'off' });
  const secret = h('input', { type: 'password', autocomplete: 'off', placeholder: g.has_client_secret ? `Tersimpan (${g.client_secret_hint || '••••'}). Kosongkan bila tidak diubah.` : 'GOCSPX-…' });
  const busy = (btn, fn) => async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      errToast(e);
    } finally {
      btn.disabled = false;
    }
  };
  const save = h('button', { class: 'btn', type: 'button' }, 'Simpan');
  save.onclick = busy(save, async () => {
    await put('/api/connections/google_drive', { client_id: clientId.value.trim(), ...(secret.value ? { client_secret: secret.value } : {}) });
    toast('Client Google disimpan', 'ok');
    redraw();
  });
  const connect = h('button', { class: 'btn btn-primary', type: 'button', disabled: !(g.client_id && g.has_client_secret) }, g.status === 'connected' ? 'Hubungkan akun lain' : 'Hubungkan');
  connect.onclick = busy(connect, async () => {
    await post('/api/connections/google_drive/connect');
    redraw();
  });
  const test = h('button', { class: 'btn', type: 'button' }, 'Tes koneksi');
  test.onclick = busy(test, async () => {
    const r = await post('/api/connections/google_drive/test');
    toast(`Google Drive OK${r.account ? `: ${r.account}` : ''}`, 'ok');
    redraw();
  });
  const off = h('button', { class: 'btn btn-danger', type: 'button' }, 'Putuskan');
  off.onclick = busy(off, async () => {
    if (!(await confirmDialog('Putuskan Google Drive? File yang sudah ada tetap di Drive Anda; simpan otomatis berhenti sampai dihubungkan lagi.', { okLabel: 'Putuskan', danger: true }))) return;
    await del('/api/connections/google_drive');
    toast('Google Drive diputus', 'ok');
    redraw();
  });
  const check = async () => {
    const r = await post('/api/connections/google_drive/poll');
    if (r.state === 'connected') toast('Google Drive terhubung', 'ok');
    else if (r.state === 'pending') toast('Belum ada izin dari Google. Masukkan kodenya dulu, lalu cek lagi.', 'error');
    redraw();
  };
  return h('div', { class: 'card stack' },
    h('div', { class: 'row-between' },
      h('div', null, h('h3', { style: { margin: 0 } }, 'Google Drive'), h('div', { class: 'small muted' }, 'Dokumen & laporan hasil kerja karyawan AI (Google Docs)')),
      h('span', { class: `badge ${cls}` }, label)),
    g.status === 'connected'
      ? h('dl', { class: 'kv' },
          h('dt', null, 'Akun'), h('dd', null, g.account || '-'),
          h('dt', null, 'Terhubung sejak'), h('dd', null, g.connected_at ? fmtDate(g.connected_at) : '-'),
          h('dt', null, 'Folder'), h('dd', null, g.folder_link ? ext(g.folder_link, 'AI Office ↗') : 'dibuat saat file pertama disimpan'))
      : null,
    g.error ? h('div', { class: 'form-error' }, g.error) : null,
    g.pending ? codeBox(g.pending, check) : null,
    h('div', { class: 'form-grid' },
      field('Client ID', clientId, 'Dari Google Cloud Console → Clients (tipe TVs and Limited Input devices).'),
      field('Client Secret', secret, 'Disimpan terenkripsi; tidak pernah ditampilkan lagi.')),
    h('div', { class: 'row' }, save, connect, g.status === 'connected' ? test : null, g.status === 'connected' || g.status === 'expired' ? off : null));
}

export async function render(root, _params, ctx) {
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    const d = await get('/api/connections');
    mount(body,
      h('p', { class: 'muted', style: { margin: 0 } },
        'Layanan luar yang dipakai karyawan AI sebagai alat. Semua file hasil kerja disimpan di sana; AI Office hanya menyimpan daftar dan tautannya. ',
        'Kunci rahasia disimpan terenkripsi dan tidak pernah ditampilkan lagi.'),
      driveCard(d.google_drive, draw),
      guide(d.google_drive),
      h('div', { class: 'grid-cards' }, d.next.map((n) => h('div', { class: 'card stack-sm next-conn' },
        h('div', { class: 'row-between' }, h('strong', null, n.label), h('span', { class: 'badge' }, 'Tahap berikutnya')),
        h('div', { class: 'small muted' }, NEXT[n.provider] || '')))));
    return d;
  };
  const first = await draw();
  // While a code is waiting, follow the background check.
  let waiting = first.google_drive.status === 'pending';
  ctx.poll(async () => {
    if (!waiting && !body.querySelector('.device-code')) return;
    const d = await draw();
    waiting = d.google_drive.status === 'pending';
    if (d.google_drive.status === 'connected' && !waiting) toast('Google Drive terhubung', 'ok');
  }, 4000);
  mount(root, body);
}
