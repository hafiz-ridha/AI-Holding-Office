// Files the AI employees stored at outside services (Google Drive now): the index with links. The files themselves
// live there; uploads that failed are retried automatically and can be retried here.
import { get, post } from '../api.js';
import { h, mount, select, toast, errToast, emptyState, fmtDate, taskCode } from '../ui.js';

const STATUS = { synced: ['Tersimpan', 'b-completed'], pending: ['Menunggu unggah', 'b-pending'], failed: ['Gagal', 'b-failed'], trashed: ['Di Sampah', ''] };
const PROVIDER = { google_drive: 'Google Drive', github: 'GitHub', vercel: 'Vercel', netlify: 'Netlify', supabase: 'Supabase' };

export async function render(root) {
  const [businesses, conn] = await Promise.all([get('/api/businesses'), get('/api/connections')]);
  const scope = select([['', 'Semua bisnis'], ['hq', 'Holding (pusat)'], ...businesses.map((b) => [String(b.id), b.name])], '', { 'aria-label': 'Bisnis' });
  const kind = select([['', 'Semua jenis'], ['document', 'Dokumen'], ['report', 'Laporan']], '', { 'aria-label': 'Jenis' });
  const status = select([['', 'Semua status'], ['synced', 'Tersimpan'], ['pending', 'Menunggu unggah'], ['failed', 'Gagal'], ['trashed', 'Di Sampah']], '', { 'aria-label': 'Status' });
  const body = h('div');

  const retry = (a) => async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await post(`/api/artifacts/${a.id}/retry`);
      toast(r.status === 'synced' ? 'Tersimpan di Drive' : `Masih gagal: ${r.error || r.status}`, r.status === 'synced' ? 'ok' : 'error');
    } catch (e) {
      errToast(e);
    } finally {
      draw();
    }
  };

  const row = (a, kinds) => {
    const [label, cls] = STATUS[a.status] || [a.status, ''];
    return h('tr', null,
      h('td', null, a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.title) : a.title,
        a.error && a.status !== 'synced' ? h('div', { class: 'small muted' }, a.error) : null),
      h('td', null, h('span', { class: 'cat-chip' }, kinds[a.kind] || a.kind), ' ', h('span', { class: 'small muted' }, PROVIDER[a.provider] || a.provider)),
      h('td', null, a.business_name || 'Holding'),
      h('td', null, a.employee_name || '-', a.source === 'auto' ? h('div', { class: 'small muted' }, 'simpan otomatis') : null),
      h('td', null, a.task_id ? h('a', { href: `#/task/${a.task_id}` }, taskCode(a.task_id)) : '-'),
      h('td', { class: 'nowrap' }, h('span', { class: `badge ${cls}` }, label), h('div', { class: 'small muted' }, fmtDate(a.updated_at))),
      h('td', { class: 'right' }, ['pending', 'failed'].includes(a.status) ? h('button', { class: 'btn btn-sm', type: 'button', onclick: retry(a) }, 'Coba lagi') : null));
  };

  async function draw() {
    const p = new URLSearchParams();
    if (scope.value) p.set('business', scope.value);
    if (kind.value) p.set('kind', kind.value);
    if (status.value) p.set('status', status.value);
    const qs = p.toString();
    const d = await get(`/api/artifacts${qs ? `?${qs}` : ''}`);
    mount(body, d.items.length
      ? h('div', { class: 'card card-flush table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Judul', 'Jenis', 'Bisnis', 'Karyawan', 'Tugas', 'Status', ''].map((t) => h('th', null, t)))),
          h('tbody', null, d.items.map((a) => row(a, d.kinds)))))
      : emptyState(conn.google_drive.status === 'connected'
        ? 'Belum ada file. Dokumen dan laporan hasil kerja karyawan AI akan tersimpan di sini otomatis.'
        : 'Belum ada file. Hubungkan Google Drive di halaman Koneksi agar hasil kerja tersimpan otomatis.'));
  }

  for (const s of [scope, kind, status]) s.addEventListener('change', draw);
  const g = conn.google_drive;
  mount(root, h('div', { class: 'stack' },
    h('div', { class: 'row-between' },
      h('p', { class: 'muted', style: { margin: 0 } },
        'File hasil kerja karyawan AI disimpan di layanan luar. ',
        g.status === 'connected'
          ? ['Google Drive: ', g.account || 'terhubung', g.folder_link ? [' · ', h('a', { href: g.folder_link, target: '_blank', rel: 'noopener noreferrer' }, 'buka folder AI Office ↗')] : null]
          : h('a', { href: '#/connections' }, 'Hubungkan Google Drive →')),
      h('div', { class: 'approvals-filters' }, scope, kind, status)),
    body));
  await draw();
}
