import { get, post } from '../api.js';
import { h, mount, badge, fmtDate, fmtNum, taskCode, md, toast, errToast, confirmDialog, KIND_LABEL, PRIORITY, modelNote, taskModelInfo } from '../ui.js';

const AGENT_EVENT = { tool_call: 'Memakai alat', tool_result: 'Hasil', tool_error: 'Gagal', tool_limit: 'Batas', approval_requested: 'Minta persetujuan', action_done: 'Aksi dijalankan', action_failed: 'Aksi gagal' };

const LEVEL = { holding: 'Holding task', business: 'Business task', employee: 'Employee subtask' };

export async function render(root, [id], ctx) {
  let lastStatus = null;
  const draw = async () => {
    const d = await get(`/api/tasks/${id}`);
    const t = d.task;
    lastStatus = t.status;
    const active = ['pending', 'assigned', 'processing'].includes(t.status);
    mount(root,
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'row-between' },
            h('div', { class: 'grow' }, h('div', { class: 'small muted mono' }, `${t.code} · ${KIND_LABEL[t.kind]} · ${LEVEL[t.level] || ''}`), h('h2', null, t.title)),
            h('div', { class: 'row' }, badge(t.status),
              active ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => {
                if (!(await confirmDialog('Batalkan tugas ini beserta semua tugas turunannya?', { danger: true, okLabel: 'Batalkan' }))) return;
                await post(`/api/tasks/${t.id}/cancel`).catch(errToast);
                draw();
              } }, 'Batalkan') : null,
              ['failed', 'cancelled'].includes(t.status) || (t.status === 'pending' && t.next_attempt_at)
                ? h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
                    await post(`/api/tasks/${t.id}/retry`).then(() => toast('Tugas dijadwalkan ulang', 'ok')).catch(errToast);
                    draw();
                  } }, t.status === 'pending' ? 'Jalankan sekarang' : 'Ulangi')
                : null)),
          h('dl', { class: 'kv', style: { marginTop: '12px' } },
            h('dt', null, 'Task ID'), h('dd', { class: 'mono' }, `${t.code} (#${t.id})`),
            h('dt', null, 'Parent'), h('dd', null, d.parent ? h('a', { href: `#/task/${d.parent.id}` }, `${d.parent.code} ${d.parent.title}`) : '-'),
            h('dt', null, 'Bisnis'), h('dd', null, d.business ? h('a', { href: `#/business/${d.business.id}` }, d.business.name) : 'Holding / umum'),
            h('dt', null, 'Penanggung jawab'), h('dd', null, d.employee ? `${d.employee.name} — ${d.employee.role}` : '-'),
            h('dt', null, 'Prioritas'), h('dd', null, PRIORITY[t.priority]),
            h('dt', null, 'Fase'), h('dd', null, t.phase || '-'),
            h('dt', null, 'Dibuat oleh'), h('dd', null, t.created_by),
            h('dt', null, 'Dibuat'), h('dd', null, fmtDate(t.created_at)),
            h('dt', null, 'Mulai'), h('dd', null, fmtDate(t.started_at)),
            h('dt', null, 'Selesai'), h('dd', null, fmtDate(t.completed_at)),
            h('dt', null, 'Provider / model'), h('dd', { class: 'mono small' }, t.model_used ? `${t.provider_name} / ${t.model_used}` : '-'),
            t.model_choice ? h('dt', null, 'Pemilihan model') : null,
            t.model_choice ? h('dd', { class: 'small' }, `${t.model_choice.mode === 'auto' ? 'Otomatis' : 'Manual'}${t.model_choice.need_label ? ` · kebutuhan: ${t.model_choice.need_label}` : ''}`) : null,
            h('dt', null, 'Token'), h('dd', null, `${fmtNum(t.tokens_in)} input + ${fmtNum(t.tokens_out)} output${t.tokens_estimated ? ` (±${fmtNum(t.tokens_estimated)} diestimasi)` : ''}${t.cost_usd ? ` · $${t.cost_usd.toFixed(5)}` : ''}`),
            h('dt', null, 'Percobaan'), h('dd', null, `${t.attempts}${t.next_attempt_at ? ` · berikutnya ${fmtDate(t.next_attempt_at)}` : ''}`)),
          t.error ? h('p', { class: 'form-error', style: { marginTop: '10px' } }, t.error) : null),
        h('div', { class: 'grid grid-2' },
          h('div', { class: 'card' }, h('h3', null, 'Input'), t.description ? md(t.description) : h('p', { class: 'muted' }, '(hanya judul)')),
          h('div', { class: 'card' }, h('h3', null, 'Rencana'),
            t.plan
              ? h('div', { class: 'stack-sm', style: { marginTop: '8px' } },
                  t.plan.analysis ? h('p', null, t.plan.analysis) : null,
                  (t.plan.children || t.plan.subtasks || []).map((c) => h('div', { class: 'small' }, '• ', h('a', { href: `#/task/${c.id}` }, c.title), ` → ${c.employee}${c.business ? ` @ ${c.business}` : ''}`)),
                  t.plan.direct_answer && !(t.plan.children || t.plan.subtasks || []).length ? h('p', { class: 'small muted' }, 'Dijawab langsung tanpa subtugas (hemat API).') : null)
              : h('p', { class: 'muted' }, 'Tidak ada rencana (tugas eksekusi).'))),
        d.children.length
          ? h('div', { class: 'card card-flush' }, h('div', { style: { padding: '12px 16px' } }, h('h3', null, `Tugas turunan (${d.children.length})`)),
              h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, d.children.map((c) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(`#/task/${c.id}`) },
                h('td', { class: 'mono small' }, c.code), h('td', null, c.title, c.child_count ? h('span', { class: 'small muted' }, ` (${c.child_count} subtugas)`) : null),
                h('td', null, KIND_LABEL[c.kind]), h('td', null, c.business_name || 'Holding'), h('td', null, c.employee_name || '-'), h('td', null, badge(c.status))))))))
          : null,
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Output'), t.result ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => navigator.clipboard?.writeText(t.result).then(() => toast('Disalin', 'ok')) }, 'Salin') : null),
          t.result ? h('div', { class: 'result-box' }, md(t.result)) : h('p', { class: 'muted' }, active ? 'Sedang dikerjakan…' : 'Belum ada hasil.'),
          t.result ? modelNote(taskModelInfo(t), { open: true }) : null),
        // Files this task stored outside (Google Drive, ...).
        d.files?.length
          ? h('div', { class: 'card' }, h('h3', null, `File di layanan luar (${d.files.length})`),
              d.files.map((f) => h('div', { class: 'list-item' },
                h('div', { class: 'grow' }, f.url ? h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, `📄 ${f.title}`) : `📄 ${f.title}`,
                  h('div', { class: 'small muted' }, `${f.provider === 'google_drive' ? 'Google Drive' : f.provider}${f.source === 'auto' ? ' · simpan otomatis' : ' · disimpan agen'}${f.error && f.status !== 'synced' ? ` · ${f.error}` : ''}`)),
                h('span', { class: `badge ${f.status === 'synced' ? 'b-completed' : f.status === 'failed' ? 'b-failed' : 'b-pending'}` },
                  { synced: 'Tersimpan', pending: 'Menunggu unggah', failed: 'Gagal' }[f.status] || f.status))),
              h('a', { href: '#/files', class: 'small' }, 'Semua file →'))
          : null,
        // What the agent did step by step (tools, approvals it asked for, actions run after approval).
        d.agent_steps?.length
          ? h('details', { class: 'card', open: true }, h('summary', null, h('strong', null, `Langkah agen (${d.agent_steps.filter((x) => x.event === 'tool_call').length} alat)`),
              h('span', { class: 'small muted' }, ' · alat yang dipakai karyawan AI dan hasilnya')),
              h('ol', { class: 'timeline small' }, d.agent_steps.map((x) => h('li', { class: x.level === 'warn' ? 'warn' : null },
                h('span', { class: 'muted' }, `${fmtDate(x.created_at)} · ${AGENT_EVENT[x.event] || x.event}: `), x.message))))
          : null,
        // Sources from the automatic web research that the AI was given (cited as [W1], [W2], ...).
        t.web_refs?.length
          ? h('details', { class: 'card', open: true }, h('summary', null, h('strong', null, `Sumber web (${t.web_refs.length})`), h('span', { class: 'small muted' }, ' · diambil otomatis sebelum AI bekerja, dikutip sebagai [W1], [W2], …')),
              h('ol', { class: 'web-refs small' }, t.web_refs.map((r) => h('li', { value: r.n },
                h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title || r.url),
                h('span', { class: 'muted' }, [r.source, r.date ? fmtDate(Date.parse(r.date)) : ''].filter((x) => x && x !== '-').map((x) => ` · ${x}`).join(''))))))
          : null,
        d.approvals.length
          ? h('div', { class: 'card' }, h('h3', null, 'Persetujuan owner'), d.approvals.map((a) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, a.is_action ? h('span', { class: 'cat-chip imp' }, 'Aksi') : null, ' ', a.detail, a.action_result ? h('div', { class: 'small muted' }, `${{ done: 'Dijalankan', failed: 'Gagal', cancelled: 'Dibatalkan' }[a.action_status] || ''}: ${a.action_result}`) : null), badge(a.status))), h('a', { href: '#/approvals', class: 'small' }, 'Kelola di Approvals →'))
          : null,
        // Flags the AI raised that are only information / data requests: no owner approval needed (kept for reference).
        d.logs.some((l) => l.event === 'approval_skipped')
          ? h('div', { class: 'card' }, h('h3', null, 'Catatan AI (tidak perlu persetujuan)'),
              h('ul', { class: 'small', style: { margin: 0, paddingLeft: '18px' } }, d.logs.filter((l) => l.event === 'approval_skipped').map((l) => h('li', null, l.message))),
              h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, 'Hanya tindakan penting (uang, kontrak, SDM, harga, publikasi, hukum, data rahasia) yang menunggu persetujuan owner. Atur di Settings.'))
          : null,
        h('div', { class: 'grid grid-2' },
          h('div', { class: 'card' }, h('h3', null, 'Riwayat'),
            h('div', { class: 'list timeline' }, d.logs.map((l) => h('div', { class: 'list-item' }, h('span', { class: 'small muted nowrap' }, fmtDate(l.created_at)), h('div', { class: 'grow' }, h('strong', null, l.event), l.message ? h('div', { class: 'small muted' }, l.message) : null))))),
          h('div', { class: 'card' }, h('h3', null, 'Pemakaian AI'),
            d.usage.length
              ? h('div', { class: 'list timeline' }, d.usage.map((u) => h('div', { class: 'list-item' },
                  badge(u.ok ? 'ok' : 'error', u.ok ? 'OK' : `Gagal${u.http_status ? ` ${u.http_status}` : ''}`),
                  h('div', { class: 'grow' }, h('div', { class: 'mono small' }, `${u.provider_name} / ${u.model}`), h('div', { class: 'small muted' }, u.ok ? `${u.purpose} · ${u.tokens_in}+${u.tokens_out} token${u.estimated ? ' (estimasi)' : ''} · ${u.latency_ms} ms` : u.error)))))
              : h('p', { class: 'muted' }, 'Belum ada panggilan AI.'))),
        d.conversations.length
          ? h('details', { class: 'card' }, h('summary', null, `Percakapan AI (${d.conversations.length} pesan)`),
              h('div', { class: 'stack', style: { marginTop: '10px' } }, d.conversations.map((c) => h('div', null,
                h('div', { class: 'small muted' }, `${c.role === 'user' ? 'Prompt' : 'Jawaban'} · ${c.employee || ''} · ${c.model || ''} · ${fmtDate(c.created_at)}`),
                h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '300px', overflow: 'auto' } }, c.content)))))
          : null
      ));
  };
  await draw();
  ctx.poll(async () => {
    if (['pending', 'assigned', 'processing'].includes(lastStatus)) await draw();
  }, 4000);
}
