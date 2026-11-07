import { get, post } from '../api.js';
import { h, mount, fmtDate, md, modal, select, toast, errToast, emptyState } from '../ui.js';

export async function render(root, _params, ctx) {
  const businesses = await get('/api/businesses');
  const scope = select([['', 'Semua laporan'], ['holding', 'Konsolidasi holding'], ['business', 'Laporan bisnis']], '');
  const body = h('div');
  const preview = h('div');
  const draw = async () => {
    const list = await get(`/api/reports${scope.value ? `?scope=${scope.value}` : ''}`);
    mount(body,
      list.length
        ? h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Tanggal'), h('th', null, 'Jenis'), h('th', null, 'Bisnis'), h('th', null, 'Judul'), h('th', null, 'Oleh'), h('th', null, ''))),
            h('tbody', null, list.map((r) => h('tr', null,
              h('td', { class: 'small nowrap' }, fmtDate(r.created_at)),
              h('td', null, r.scope === 'holding' ? 'Konsolidasi' : 'Bisnis'),
              h('td', null, r.business_name || 'Holding'),
              h('td', null, r.title, h('div', { class: 'small muted' }, r.excerpt.replace(/[#*`]/g, '').slice(0, 140))),
              h('td', { class: 'small' }, r.employee_name || '-'),
              h('td', null, h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
                const full = await get(`/api/reports/${r.id}`);
                modal({ title: full.title, wide: true, body: h('div', null, h('p', { class: 'small muted' }, `${full.business_name || 'Holding'} · ${full.employee_name || ''} · ${fmtDate(full.created_at)}${full.task_id ? ` · tugas #${full.task_id}` : ''}`), h('div', { class: 'result-box' }, md(full.content))) });
              } }, 'Baca'))))))))
        : emptyState('Belum ada laporan. Buat holding task, misalnya "Evaluasi seluruh bisnis bulan ini".', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openNewTask({ mode: 'holding' }) }, 'Buat holding task')));
  };
  scope.addEventListener('change', draw);
  const which = select([['', 'Laporan holding (semua bisnis)'], ...businesses.map((b) => [b.slug, `Laporan ${b.name}`])], '');
  const loadPreview = async () => {
    const r = await get(`/api/telegram/preview${which.value ? `?business=${encodeURIComponent(which.value)}` : ''}`);
    // The Telegram report uses a tiny HTML subset; show it as plain text here.
    mount(preview, h('pre', { style: { whiteSpace: 'pre-wrap', margin: 0, maxHeight: '420px', overflow: 'auto' } }, r.text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')));
  };
  which.addEventListener('change', loadPreview);
  mount(root, h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Laporan harian hari ini (data sistem, tanpa panggilan AI)'),
        h('div', { class: 'row' }, which,
          h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
            const r = await post('/api/telegram/report-now', which.value ? { business: which.value } : {}).catch(errToast);
            if (r?.ok) toast('Laporan dikirim ke Telegram', 'ok');
            else if (r) toast(`Gagal: ${r.error}`, 'error');
          } }, 'Kirim ke Telegram'))),
      preview),
    h('div', { class: 'row-between' }, h('h2', null, 'Arsip laporan AI'), h('div', { style: { width: '220px' } }, scope)),
    body));
  await Promise.all([draw(), loadPreview()]);
}
