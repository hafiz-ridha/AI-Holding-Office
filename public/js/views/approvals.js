import { get, post } from '../api.js';
import { h, mount, badge, fmtDate, select, modal, field, toast, emptyState, taskCode } from '../ui.js';

export async function render(root, _params, ctx) {
  const status = select([['pending', 'Menunggu'], ['', 'Semua'], ['approved', 'Disetujui'], ['rejected', 'Ditolak']], 'pending');
  const body = h('div');
  const decide = (a, decision) => {
    const note = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Catatan (opsional)' });
    modal({
      title: decision === 'approved' ? 'Setujui rekomendasi' : 'Tolak rekomendasi',
      body: h('div', { class: 'stack' }, h('p', null, a.detail), h('p', { class: 'small muted' }, 'Keputusan ini hanya dicatat. Aplikasi dan AI tidak mengeksekusi tindakan apa pun; lakukan tindakannya sendiri bila disetujui.'), field('Catatan', note)),
      actions: [{ label: 'Batal' }, {
        label: decision === 'approved' ? 'Setujui' : 'Tolak', kind: decision === 'approved' ? 'primary' : 'danger',
        onClick: async () => {
          await post(`/api/approvals/${a.id}/decide`, { decision, note: note.value });
          toast('Keputusan dicatat', 'ok');
          draw();
          ctx.refreshBadges();
        },
      }],
    });
  };
  const draw = async () => {
    const list = await get(`/api/approvals${status.value ? `?status=${status.value}` : ''}`);
    mount(body,
      list.length
        ? h('div', { class: 'stack' }, list.map((a) => h('div', { class: 'card' },
            h('div', { class: 'row-between' },
              h('div', { class: 'grow' },
                h('div', { class: 'small muted' }, `#${a.id} · ${a.business_name || 'Holding'} · ${fmtDate(a.created_at)} · `, a.task_id ? h('a', { href: `#/task/${a.task_id}` }, `${taskCode(a.task_id)} ${a.title}`) : a.title),
                h('p', { style: { margin: '6px 0 0' } }, a.detail),
                a.decided_at ? h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, `Diputuskan ${a.decided_by} · ${fmtDate(a.decided_at)}${a.decision_note ? ` · ${a.decision_note}` : ''}`) : null),
              a.status === 'pending'
                ? h('div', { class: 'row' }, h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => decide(a, 'approved') }, 'Setujui'), h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => decide(a, 'rejected') }, 'Tolak'))
                : badge(a.status)))))
        : emptyState(status.value === 'pending' ? 'Tidak ada persetujuan yang menunggu.' : 'Tidak ada data.'));
  };
  status.addEventListener('change', draw);
  mount(root, h('div', { class: 'stack' },
    h('div', { class: 'row-between' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Rekomendasi AI yang ditandai "PERLU PERSETUJUAN ADMIN" muncul di sini dan dikirim ke Telegram.'), h('div', { style: { width: '180px' } }, status)),
    body));
  await draw();
}
