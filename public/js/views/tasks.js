import { get } from '../api.js';
import { h, mount, badge, fmtRel, taskCode, select, KIND_LABEL, PRIORITY, emptyState } from '../ui.js';

export async function render(root, _params, ctx) {
  const businesses = await get('/api/businesses');
  const status = select([['', 'Semua status'], ['active', 'Aktif'], ['pending', 'Pending'], ['assigned', 'Assigned'], ['processing', 'Processing'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']], '');
  const kind = select([['top', 'Tugas utama saja'], ['', 'Semua level'], ['instruction', 'Holding task'], ['business', 'Business task'], ['subtask', 'Employee subtask'], ['direct', 'Tugas langsung']], 'top');
  const biz = select([['', 'Semua bisnis'], ['holding', 'Holding / umum'], ...businesses.map((b) => [b.id, b.name])], '');
  const q = h('input', { placeholder: 'Cari judul/isi…', maxlength: 100 });
  const body = h('div');
  let page = 1;

  const draw = async () => {
    const qs = new URLSearchParams({ page, limit: 30 });
    if (status.value) qs.set('status', status.value);
    if (kind.value) qs.set('kind', kind.value);
    if (biz.value) qs.set('business_id', biz.value);
    if (q.value.trim()) qs.set('q', q.value.trim());
    const r = await get(`/api/tasks?${qs}`);
    const pages = Math.max(1, Math.ceil(r.total / 30));
    mount(body,
      r.items.length
        ? h('div', { class: 'card card-flush' },
            h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, 'Judul'), h('th', null, 'Level'), h('th', null, 'Bisnis'), h('th', null, 'Penanggung jawab'), h('th', null, 'Prioritas'), h('th', null, 'Status'), h('th', null, 'Diperbarui'))),
              h('tbody', null, r.items.map((t) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(`#/task/${t.id}`) },
                h('td', { class: 'mono small nowrap' }, taskCode(t.id)),
                h('td', null, h('a', { href: `#/task/${t.id}` }, t.title), t.child_count ? h('div', { class: 'small muted' }, `${t.child_count} tugas turunan`) : null),
                h('td', null, KIND_LABEL[t.kind]),
                h('td', null, t.business_name ? h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'dot', style: { background: t.business_color } }), t.business_name) : h('span', { class: 'muted' }, 'Holding')),
                h('td', null, t.employee_name || '-'),
                h('td', null, PRIORITY[t.priority]),
                h('td', null, badge(t.status), t.status === 'pending' && t.next_attempt_at ? h('div', { class: 'small muted' }, `coba lagi ${fmtRel(t.next_attempt_at)}`) : null),
                h('td', { class: 'small nowrap' }, fmtRel(t.updated_at))))))),
            h('div', { class: 'row-between', style: { padding: '10px 12px' } },
              h('span', { class: 'small muted' }, `${r.total} tugas`),
              h('div', { class: 'row' },
                h('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1, onclick: () => { page--; draw(); } }, '‹ Sebelumnya'),
                h('span', { class: 'small' }, `${page}/${pages}`),
                h('button', { class: 'btn btn-sm', type: 'button', disabled: page >= pages, onclick: () => { page++; draw(); } }, 'Berikutnya ›'))))
        : emptyState('Tidak ada tugas yang cocok.', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openNewTask() }, 'Buat tugas')));
  };
  for (const el of [status, kind, biz]) el.addEventListener('change', () => { page = 1; draw(); });
  mount(root, h('div', { class: 'stack' },
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); page = 1; draw(); } },
      h('div', { style: { width: '170px' } }, status), h('div', { style: { width: '190px' } }, kind), h('div', { style: { width: '190px' } }, biz),
      h('div', { class: 'grow', style: { minWidth: '160px' } }, q), h('button', { class: 'btn', type: 'submit' }, 'Cari'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openNewTask() }, '+ Tugas')),
    body));
  await draw();
  ctx.poll(draw, 8000);
}
