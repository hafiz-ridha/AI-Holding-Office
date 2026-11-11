// Owner approvals: decide one item, or select many (checkbox, "Pilih semua", Shift+klik for a range) and
// approve/reject them in one go. Recommendations: the decision is only recorded. Actions an AI agent asked for
// (e.g. share a Drive file): the server runs them after approval; their outcome is shown on the card.
import { get, post } from '../api.js';
import { h, mount, badge, fmtDate, select, modal, field, toast, emptyState, taskCode } from '../ui.js';

const VERB = { approved: 'Setujui', rejected: 'Tolak' };
const DONE = { approved: 'disetujui', rejected: 'ditolak' };
const NOTICE = 'Rekomendasi: keputusan hanya dicatat; lakukan tindakannya sendiri bila disetujui.';
const ACTION_NOTICE = 'Aksi: bila disetujui, server langsung menjalankan aksi ini atas nama karyawan AI. Bila ditolak, aksi dibatalkan.';
const ACTION_STATE = {
  waiting: ['Aksi menunggu keputusan', ''],
  running: ['Aksi sedang dijalankan…', ''],
  done: ['Aksi dijalankan', 'ok'],
  failed: ['Aksi gagal', 'error'],
  cancelled: ['Aksi dibatalkan', ''],
};
const notices = (items) => [
  items.some((a) => a.action) ? h('p', { class: 'small', style: { margin: 0 } }, ACTION_NOTICE) : null,
  items.some((a) => !a.action) ? h('p', { class: 'small muted', style: { margin: 0 } }, NOTICE) : null,
];

export async function render(root, _params, ctx) {
  const businesses = await get('/api/businesses');
  const status = select([['pending', 'Menunggu'], ['', 'Semua'], ['approved', 'Disetujui'], ['rejected', 'Ditolak']], 'pending', { 'aria-label': 'Status' });
  const scope = select([['', 'Semua bisnis'], ['hq', 'Holding (pusat)'], ...businesses.map((b) => [String(b.id), b.name])], '', { 'aria-label': 'Bisnis' });
  const body = h('div');
  const selected = new Set();
  let pending = []; // pending items currently listed, in display order
  let lastClicked = null;

  const after = () => {
    draw();
    ctx.refreshBadges();
  };

  // Single decision (unchanged behaviour).
  const decide = (a, decision) => {
    const note = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Catatan (opsional)' });
    modal({
      title: `${decision === 'approved' ? 'Setujui' : 'Tolak'} ${a.action ? 'aksi' : 'rekomendasi'}`,
      body: h('div', { class: 'stack' }, h('p', null, a.detail), ...notices([a]), field('Catatan', note)),
      actions: [{ label: 'Batal' }, {
        label: VERB[decision], kind: decision === 'approved' ? 'primary' : 'danger',
        onClick: async () => {
          await post(`/api/approvals/${a.id}/decide`, { decision, note: note.value });
          selected.delete(a.id);
          toast(a.action && decision === 'approved' ? 'Disetujui: aksi sedang dijalankan' : 'Keputusan dicatat', 'ok');
          after();
        },
      }],
    });
  };

  // Bulk decision for every selected item: one confirmation, one note for all.
  const decideMany = (decision) => {
    const items = pending.filter((a) => selected.has(a.id));
    if (!items.length) return;
    const note = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Catatan untuk semua item (opsional)' });
    modal({
      title: `${VERB[decision]} ${items.length} item`,
      body: h('div', { class: 'stack' },
        h('ul', { class: 'bulk-list small' }, items.map((a) => h('li', null, h('span', { class: 'muted' }, `#${a.id} · ${a.business_name || 'Holding'} · `), a.detail))),
        ...notices(items),
        field('Catatan', note)),
      actions: [{ label: 'Batal' }, {
        label: `${VERB[decision]} ${items.length} item`, kind: decision === 'approved' ? 'primary' : 'danger',
        onClick: async () => {
          const r = await post('/api/approvals/decide', { ids: items.map((a) => a.id), decision, note: note.value });
          selected.clear();
          const skip = r.skipped.length ? `, ${r.skipped.length} dilewati karena sudah diputuskan` : '';
          toast(`${r.decided.length} item ${DONE[decision]}${skip}`, r.decided.length ? 'ok' : 'error');
          after();
        },
      }],
    });
  };

  // Bulk bar
  const all = h('input', { type: 'checkbox', 'aria-label': 'Pilih semua yang menunggu' });
  const count = h('span', { class: 'small muted grow' });
  const clearBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { selected.clear(); sync(); } }, 'Batal pilih');
  const approveBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => decideMany('approved') }, 'Setujui terpilih');
  const rejectBtn = h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => decideMany('rejected') }, 'Tolak terpilih');
  // Older items that are only information / data requests (no longer approvals under the current policy).
  const infoBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Pilih item yang hanya berupa informasi atau permintaan data', onclick: () => {
    for (const a of pending) if (!a.important) selected.add(a.id);
    sync();
  } });
  const bar = h('div', { class: 'card bulk-bar' },
    h('label', { class: 'check' }, all, 'Pilih semua'), count, h('div', { class: 'row' }, infoBtn, clearBtn, approveBtn, rejectBtn));

  function sync() {
    const n = selected.size;
    all.checked = n > 0 && n === pending.length;
    all.indeterminate = n > 0 && n < pending.length;
    count.textContent = n ? `${n} dari ${pending.length} dipilih` : `${pending.length} menunggu keputusan · centang untuk memutuskan sekaligus`;
    approveBtn.disabled = rejectBtn.disabled = !n;
    approveBtn.textContent = n ? `Setujui ${n}` : 'Setujui terpilih';
    rejectBtn.textContent = n ? `Tolak ${n}` : 'Tolak terpilih';
    clearBtn.hidden = !n;
    const info = pending.filter((a) => !a.important).length;
    infoBtn.hidden = !info;
    infoBtn.textContent = `Pilih yang bersifat informasi (${info})`;
    bar.classList.toggle('active', n > 0);
    bar.hidden = !pending.length;
    for (const cb of body.querySelectorAll('input[data-approval]')) {
      cb.checked = selected.has(Number(cb.dataset.approval));
      cb.closest('.approval-card').classList.toggle('selected', cb.checked);
    }
  }

  all.addEventListener('change', () => {
    if (all.checked) for (const a of pending) selected.add(a.id);
    else selected.clear();
    sync();
  });

  // Checkbox per pending card; Shift+klik applies the same state to the whole range since the last click.
  const pick = (a) => {
    const cb = h('input', { type: 'checkbox', dataset: { approval: a.id }, 'aria-label': `Pilih #${a.id}` });
    cb.addEventListener('click', (ev) => {
      const idx = pending.findIndex((x) => x.id === a.id);
      const on = cb.checked;
      if (ev.shiftKey && lastClicked !== null) {
        const [from, to] = [Math.min(lastClicked, idx), Math.max(lastClicked, idx)];
        for (const x of pending.slice(from, to + 1)) on ? selected.add(x.id) : selected.delete(x.id);
      } else if (on) selected.add(a.id);
      else selected.delete(a.id);
      lastClicked = idx;
      sync();
    });
    return h('label', { class: 'approval-pick' }, cb);
  };

  // Outcome of an action (approved: ran or failed; failed ones can run again).
  const actionLine = (a) => {
    if (!a.action) return null;
    const [label, tone] = ACTION_STATE[a.action_status] || ACTION_STATE.waiting;
    return h('div', { class: `action-line ${tone}` },
      h('b', null, a.action_result ? `${label}: ` : label), a.action_result || null,
      a.action_status === 'failed' && a.status === 'approved'
        ? h('button', { class: 'btn btn-sm', type: 'button', onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            const r = await post(`/api/approvals/${a.id}/run`);
            toast(r.action_status === 'done' ? 'Aksi berhasil dijalankan' : 'Aksi masih gagal', r.action_status === 'done' ? 'ok' : 'error');
          } finally {
            draw();
          }
        } }, 'Jalankan ulang')
        : null);
  };

  const card = (a) => h('div', { class: `card approval-card${a.status === 'pending' ? ' has-pick' : ''}` },
    a.status === 'pending' ? pick(a) : null,
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'small muted' }, `#${a.id} · ${a.business_name || 'Holding'} · ${fmtDate(a.created_at)} · `, a.task_id ? h('a', { href: `#/task/${a.task_id}` }, `${taskCode(a.task_id)} ${a.title}`) : a.title),
      h('p', { style: { margin: '6px 0 0' } }, h('span', { class: `cat-chip${a.important ? ' imp' : ''}`, title: a.important ? 'Tindakan penting: perlu keputusan owner' : 'Hanya informasi: tidak perlu persetujuan (dibuat sebelum aturan baru)' }, a.category), ' ', a.detail),
      actionLine(a),
      a.decided_at ? h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, `Diputuskan ${a.decided_by} · ${fmtDate(a.decided_at)}${a.decision_note ? ` · ${a.decision_note}` : ''}`) : null),
    a.status === 'pending'
      ? h('div', { class: 'row approval-actions' },
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => decide(a, 'approved') }, 'Setujui'),
          h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => decide(a, 'rejected') }, 'Tolak'))
      : badge(a.status));

  let lastList = [];
  const pendingActions = () => lastList.some((a) => a.action && a.status === 'approved' && ['waiting', 'running'].includes(a.action_status));

  async function draw() {
    const p = new URLSearchParams();
    if (status.value) p.set('status', status.value);
    if (scope.value) p.set('business', scope.value);
    const qs = p.toString();
    const list = await get(`/api/approvals${qs ? `?${qs}` : ''}`);
    lastList = list;
    pending = list.filter((a) => a.status === 'pending');
    for (const id of [...selected]) if (!pending.some((a) => a.id === id)) selected.delete(id); // keep only what is still listed
    lastClicked = null;
    mount(body, list.length
      ? h('div', { class: 'stack' }, list.map(card))
      : emptyState(status.value === 'pending' ? 'Tidak ada persetujuan yang menunggu.' : 'Tidak ada data.'));
    sync();
  }

  ctx.poll(() => (pendingActions() ? draw() : null), 3000);
  status.addEventListener('change', draw);
  scope.addEventListener('change', draw);
  mount(root, h('div', { class: 'stack' },
    h('div', { class: 'approvals-head' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Hanya tindakan penting dari AI (uang, kontrak, SDM, harga, publikasi, hukum, data rahasia) dan aksi yang diminta karyawan AI (misalnya membagikan atau menghapus file Drive) yang menunggu keputusan di sini dan dikirim ke Telegram. Aksi baru dijalankan setelah Anda setujui.'),
      h('div', { class: 'approvals-filters' }, scope, status)),
    bar,
    body));
  await draw();
}
