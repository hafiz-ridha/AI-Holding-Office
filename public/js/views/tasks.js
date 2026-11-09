// Task Manager: recurring tasks (scheduled rules) on top, then the task list. A task created by a recurring rule
// shows the 🔁 mark; "Riwayat" filters the list to the tasks of one rule.
import { get, post, put, del } from '../api.js';
import { h, mount, badge, fmtRel, fmtDate, taskCode, select, field, modal, toast, errToast, confirmDialog, KIND_LABEL, PRIORITY, emptyState } from '../ui.js';

const FREQ = [['daily', 'Setiap hari'], ['weekdays', 'Senin–Jumat'], ['weekly', 'Mingguan (pilih hari)'], ['monthly', 'Bulanan'], ['hours', 'Tiap beberapa jam']];
const DAYS = [[1, 'Sen'], [2, 'Sel'], [3, 'Rab'], [4, 'Kam'], [5, 'Jum'], [6, 'Sab'], [7, 'Min']];
const DAY_NAME = ['', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

function scheduleText(f) {
  const t = f.time_of_day || '08:00';
  if (f.frequency === 'daily') return `Setiap hari pukul ${t}`;
  if (f.frequency === 'weekdays') return `Senin–Jumat pukul ${t}`;
  if (f.frequency === 'weekly') {
    const d = (f.weekdays || []).map((x) => DAY_NAME[x]);
    return d.length ? `Setiap ${d.length > 1 ? `${d.slice(0, -1).join(', ')} & ${d.at(-1)}` : d[0]} pukul ${t}` : 'Pilih minimal satu hari';
  }
  if (f.frequency === 'monthly') return `Tanggal ${f.day_of_month || 1} setiap bulan pukul ${t}`;
  return `Setiap ${f.every_hours || 1} jam mulai pukul ${t}`;
}

const targetText = (r) => (r.mode === 'holding' ? `Group CEO${r.business_name ? ` · fokus ${r.business_name}` : ''}` : r.mode === 'business' ? `Business Manager · ${r.business_name || '-'}` : `${r.employee_name || 'karyawan dihapus'}${r.business_name ? ` · ${r.business_name}` : ''}`);

export async function render(root, _params, ctx) {
  const [businesses, employees, templates] = await Promise.all([get('/api/businesses'), get('/api/employees'), get('/api/recurring/templates')]);
  const activeBiz = businesses.filter((b) => b.status === 'active');
  const status = select([['', 'Semua status'], ['active', 'Aktif'], ['pending', 'Pending'], ['assigned', 'Assigned'], ['processing', 'Processing'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']], '');
  const kind = select([['top', 'Tugas utama saja'], ['', 'Semua level'], ['instruction', 'Holding task'], ['business', 'Business task'], ['subtask', 'Employee subtask'], ['direct', 'Tugas langsung']], 'top');
  const biz = select([['', 'Semua bisnis'], ['holding', 'Holding / umum'], ...businesses.map((b) => [b.id, b.name])], '');
  const q = h('input', { placeholder: 'Cari judul/isi…', maxlength: 100 });
  const body = h('div');
  const recBody = h('div');
  const filterChip = h('div');
  let page = 1;
  let recFilter = null; // { id, title }: show only the tasks created by this recurring rule
  let rules = [];

  // ---------------- recurring tasks ----------------
  const act = (label, fn, cls = 'btn-sm btn-ghost') => h('button', { class: `btn ${cls}`, type: 'button', onclick: async (ev) => {
    ev.target.disabled = true;
    try {
      await fn();
    } catch (e) {
      errToast(e);
    } finally {
      ev.target.disabled = false;
    }
  } }, label);

  function lastRun(r) {
    if (r.last_status === 'error') return h('span', { class: 'small', style: { color: 'var(--err)' } }, `Gagal: ${r.last_error}`);
    if (r.last_status === 'skipped') return h('span', { class: 'small muted' }, `${r.last_error || 'Dilewati'}`);
    if (!r.last_task_id) return h('span', { class: 'small muted' }, 'Belum pernah jalan');
    return h('span', { class: 'small' }, h('a', { href: `#/task/${r.last_task_id}` }, taskCode(r.last_task_id)), ' ', r.last_task_status ? badge(r.last_task_status) : null, h('span', { class: 'muted' }, ` · ${fmtRel(r.last_run_at)}`));
  }

  function ruleRow(r) {
    return h('div', { class: `rec-row${r.enabled ? '' : ' off'}` },
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'row', style: { gap: '6px' } }, h('span', { 'aria-hidden': 'true' }, '🔁'), h('b', null, r.title), r.enabled ? null : h('span', { class: 'pill' }, 'Nonaktif')),
        h('div', { class: 'small muted' }, `${r.schedule} · ${targetText(r)} · ${r.run_count}× jalan`),
        h('div', { class: 'small' }, r.enabled && r.next_run_at ? h('span', null, 'Berikutnya: ', h('b', null, fmtDate(r.next_run_at)), h('span', { class: 'muted' }, ` (${fmtRel(r.next_run_at)})`)) : h('span', { class: 'muted' }, 'Tidak dijadwalkan'), ' · Terakhir: ', lastRun(r))),
      h('div', { class: 'row rec-actions' },
        act(r.enabled ? 'Nonaktifkan' : 'Aktifkan', async () => {
          await put(`/api/recurring/${r.id}`, { enabled: !r.enabled });
          toast(r.enabled ? 'Tugas berulang dinonaktifkan' : 'Tugas berulang aktif', 'ok');
          drawRules();
        }),
        act('Jalankan sekarang', async () => {
          const res = await post(`/api/recurring/${r.id}/run`);
          toast(`Tugas ${taskCode(res.task_id)} dibuat`, 'ok');
          drawRules();
          draw();
        }),
        act('Riwayat', async () => {
          recFilter = { id: r.id, title: r.title };
          page = 1;
          draw();
        }),
        act('Edit', async () => ruleForm(r)),
        act('Hapus', async () => {
          if (!(await confirmDialog(`Hapus tugas berulang "${r.title}"? Tugas yang sudah dibuat tetap ada.`, { danger: true, okLabel: 'Hapus' }))) return;
          await del(`/api/recurring/${r.id}`);
          toast('Tugas berulang dihapus', 'ok');
          if (recFilter?.id === r.id) recFilter = null;
          drawRules();
          draw();
        }, 'btn-sm btn-ghost btn-danger')));
  }

  const templateChips = (onPick) => h('div', { class: 'row', style: { gap: '6px' } },
    templates.map((t) => h('button', { class: 'btn btn-sm', type: 'button', onclick: () => onPick(t) }, t.label)));

  async function drawRules() {
    rules = await get('/api/recurring');
    const on = rules.filter((r) => r.enabled).length;
    mount(recBody,
      h('div', { class: 'row-between' },
        h('div', null, h('h2', { style: { margin: 0 } }, 'Tugas berulang'), h('div', { class: 'small muted' }, rules.length ? `${on} aktif dari ${rules.length} · dibuat otomatis sesuai jadwal (zona waktu holding)` : 'Tugas yang dibuat otomatis sesuai jadwal, misalnya riset tren, berita, atau media sosial.')),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ruleForm() }, '+ Tugas berulang')),
      rules.length ? h('div', { class: 'rec-list' }, rules.map(ruleRow)) : null,
      h('div', { class: 'stack-sm' }, h('div', { class: 'small muted' }, rules.length ? 'Tambah dari template:' : 'Mulai dari template:'), templateChips((t) => ruleForm(null, t))));
  }

  function ruleForm(r = null, tpl = null) {
    const src = r || (tpl ? { ...tpl, template: tpl.key } : {});
    const title = h('input', { maxlength: 200, value: src.title || '', placeholder: 'mis. Riset tren pasar mingguan' });
    const desc = h('textarea', { rows: 6, maxlength: 20000, placeholder: 'Instruksi untuk AI: apa yang dicari, sumber, dan format hasil…' });
    desc.value = src.description || '';
    const mode = select([['holding', 'Holding task → Group CEO'], ['business', 'Business task → Business Manager'], ['direct', 'Langsung ke satu karyawan']], src.mode || 'holding');
    const bizSel = select([['', '— Semua / holding —'], ...activeBiz.map((b) => [b.id, b.name])], src.business_id || (src.mode === 'business' && activeBiz[0] ? activeBiz[0].id : ''));
    const emp = select([['', '— pilih karyawan —'], ...employees.filter((e) => e.enabled).map((e) => [e.id, `${e.name} — ${e.role}`])], src.employee_id || '');
    const prio = select([['low', 'Rendah'], ['normal', 'Normal'], ['high', 'Tinggi'], ['urgent', 'Mendesak']], src.priority || 'normal');
    const freq = select(FREQ, src.frequency || 'daily');
    const time = h('input', { type: 'time', value: src.time_of_day || '08:00', required: true });
    const days = new Set(src.weekdays?.length ? src.weekdays : [1]);
    const dayBox = h('div', { class: 'row', style: { gap: '4px' } }, DAYS.map(([d, l]) => {
      const cb = h('input', { type: 'checkbox', checked: days.has(d) });
      cb.addEventListener('change', () => {
        if (cb.checked) days.add(d);
        else days.delete(d);
        sync();
      });
      return h('label', { class: 'day-chip' }, cb, l);
    }));
    const dom = h('input', { type: 'number', min: 1, max: 28, value: src.day_of_month || 1 });
    const hours = h('input', { type: 'number', min: 1, max: 24, value: src.every_hours || 6 });
    const skip = h('input', { type: 'checkbox', checked: r ? r.skip_if_running : true });
    const enabled = h('input', { type: 'checkbox', checked: r ? r.enabled : true });
    const bizField = field('Bisnis', bizSel, 'Wajib untuk business task. Opsional untuk holding/langsung.');
    const empField = field('Karyawan', emp);
    const dayField = field('Hari', dayBox);
    const domField = field('Tanggal (1–28)', dom);
    const hoursField = field('Tiap (jam)', hours);
    const preview = h('p', { class: 'small', style: { margin: 0 } });
    const fill = (t) => {
      title.value = t.title;
      desc.value = t.description;
      mode.value = t.mode;
      freq.value = t.frequency;
      time.value = t.time_of_day;
      days.clear();
      for (const d of t.weekdays || [1]) days.add(d);
      [...dayBox.querySelectorAll('input')].forEach((cb, i) => (cb.checked = days.has(DAYS[i][0])));
      dom.value = t.day_of_month || 1;
      if (t.mode === 'business' && !bizSel.value && activeBiz[0]) bizSel.value = String(activeBiz[0].id);
      src.template = t.key;
      sync();
    };
    const values = () => ({
      title: title.value.trim(), description: desc.value, mode: mode.value, priority: prio.value,
      business_id: bizSel.value ? Number(bizSel.value) : null, employee_id: mode.value === 'direct' && emp.value ? Number(emp.value) : null,
      frequency: freq.value, time_of_day: time.value, weekdays: [...days].sort(), day_of_month: Number(dom.value) || 1, every_hours: Number(hours.value) || 1,
      skip_if_running: skip.checked, enabled: enabled.checked, template: src.template || null,
    });
    function sync() {
      empField.hidden = mode.value !== 'direct';
      dayField.hidden = freq.value !== 'weekly';
      domField.hidden = freq.value !== 'monthly';
      hoursField.hidden = freq.value !== 'hours';
      preview.textContent = `Jadwal: ${scheduleText(values())}.`;
    }
    for (const el of [mode, freq, time, dom, hours]) el.addEventListener('input', sync);
    for (const el of [mode, freq]) el.addEventListener('change', sync);
    sync();
    modal({
      title: r ? 'Edit tugas berulang' : 'Tugas berulang baru',
      wide: true,
      body: h('div', { class: 'stack' },
        r ? null : h('div', { class: 'stack-sm' }, h('div', { class: 'small muted' }, 'Isi cepat dari template:'), templateChips(fill)),
        field('Judul', title), field('Instruksi', desc, 'Setiap kali jalan, tanggal ditambahkan ke judul dan AI diminta melanjutkan dari hasil sebelumnya (Second Brain).'),
        h('div', { class: 'form-grid' }, field('Jenis tugas', mode), field('Prioritas', prio)),
        bizField, empField,
        h('div', { class: 'form-grid' }, field('Frekuensi', freq), field('Jam', time)),
        dayField, domField, hoursField, preview,
        h('label', { class: 'check' }, skip, 'Lewati jadwal jika tugas sebelumnya masih berjalan'),
        h('label', { class: 'check' }, enabled, 'Aktif'),
        h('p', { class: 'small muted', style: { margin: 0 } }, 'Setiap jadwal memakai kuota AI seperti tugas biasa. Untuk provider gratis, pilih frekuensi secukupnya.')),
      actions: [
        { label: 'Batal' },
        { label: r ? 'Simpan' : 'Buat tugas berulang', kind: 'primary', onClick: async () => {
          const v = values();
          if (v.title.length < 3) {
            toast('Judul minimal 3 karakter', 'error');
            return false;
          }
          if (v.frequency === 'weekly' && !v.weekdays.length) {
            toast('Pilih minimal satu hari', 'error');
            return false;
          }
          const saved = r ? await put(`/api/recurring/${r.id}`, v) : await post('/api/recurring', v);
          toast(saved.next_run_at ? `Tersimpan · berikutnya ${fmtDate(saved.next_run_at)}` : 'Tersimpan (nonaktif)', 'ok');
          drawRules();
        } },
      ],
    });
  }

  // ---------------- task list ----------------
  const draw = async () => {
    const qs = new URLSearchParams({ page, limit: 30 });
    if (status.value) qs.set('status', status.value);
    if (kind.value) qs.set('kind', kind.value);
    if (biz.value) qs.set('business_id', biz.value);
    if (q.value.trim()) qs.set('q', q.value.trim());
    if (recFilter) qs.set('recurring_id', recFilter.id);
    mount(filterChip, recFilter ? h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'pill' }, `🔁 Hanya tugas dari "${recFilter.title}"`),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { recFilter = null; page = 1; draw(); } }, 'Tampilkan semua')) : null);
    const r = await get(`/api/tasks?${qs}`);
    const pages = Math.max(1, Math.ceil(r.total / 30));
    mount(body,
      r.items.length
        ? h('div', { class: 'card card-flush' },
            h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, 'Judul'), h('th', null, 'Level'), h('th', null, 'Bisnis'), h('th', null, 'Penanggung jawab'), h('th', null, 'Prioritas'), h('th', null, 'Status'), h('th', null, 'Diperbarui'))),
              h('tbody', null, r.items.map((t) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(`#/task/${t.id}`) },
                h('td', { class: 'mono small nowrap' }, taskCode(t.id)),
                h('td', null, t.recurring_id ? h('span', { title: 'Dibuat oleh tugas berulang', 'aria-label': 'Tugas berulang' }, '🔁 ') : null, h('a', { href: `#/task/${t.id}` }, t.title), t.child_count ? h('div', { class: 'small muted' }, `${t.child_count} tugas turunan`) : null),
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
        : emptyState(recFilter ? 'Tugas berulang ini belum membuat tugas.' : 'Tidak ada tugas yang cocok.', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openNewTask() }, 'Buat tugas')));
  };
  for (const el of [status, kind, biz]) el.addEventListener('change', () => { page = 1; draw(); });
  mount(root, h('div', { class: 'stack' },
    h('div', { class: 'card stack-sm' }, recBody),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); page = 1; draw(); } },
      h('div', { style: { width: '170px' } }, status), h('div', { style: { width: '190px' } }, kind), h('div', { style: { width: '190px' } }, biz),
      h('div', { class: 'grow', style: { minWidth: '160px' } }, q), h('button', { class: 'btn', type: 'submit' }, 'Cari'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openNewTask() }, '+ Tugas')),
    filterChip,
    body));
  await Promise.all([drawRules(), draw()]);
  ctx.poll(draw, 8000);
  ctx.poll(drawRules, 30000);
}
