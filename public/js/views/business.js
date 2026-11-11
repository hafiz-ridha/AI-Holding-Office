import { get, post, put, del } from '../api.js';
import {
  h, mount, badge, bizLogo, field, select, modal, toast, errToast, emptyState, fmtDate, fmtRel, fmtMoney, taskCode, md,
  confirmDialog, readFileAs, KIND_LABEL, PRIORITY,
} from '../ui.js';
import { businessForm } from './businesses.js';
import { avatarCanvas } from '../office/sprites.js';

const TABS = [
  ['profile', 'Profil'], ['team', 'Karyawan'], ['board', 'Task board'], ['knowledge', 'Knowledge base'],
  ['finance', 'Keuangan'], ['activity', 'Aktivitas'], ['reports', 'Laporan'],
];

export async function render(root, [id, tab = 'profile'], ctx) {
  const data = await get(`/api/businesses/${id}`);
  const b = data.business;
  const body = h('div');
  mount(
    root,
    h('div', { class: 'stack' },
      h('div', { class: 'card biz-card', style: { '--biz': b.color } },
        h('div', { class: 'row' }, bizLogo(b, 'biz-logo-lg'),
          h('div', { class: 'grow' }, h('h2', null, b.name), h('div', { class: 'muted small' }, `${b.code} · ${b.industry || 'industri belum diisi'} · Manager: ${b.manager?.name || 'belum ada'}`)),
          badge(b.status),
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => ctx.openNewTask({ mode: 'business', business_id: b.id }) }, '+ Business task'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => businessForm(b, () => ctx.navigate(location.hash)) }, 'Edit profil'))),
      h('nav', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { class: `tab ${k === tab ? 'active' : ''}`, href: `#/business/${b.id}/${k}` }, l))),
      body
    )
  );
  const views = { profile, team, board, knowledge, finance, activity, reports };
  await (views[tab] || profile)(body, b, data, ctx);
  return { title: b.name };
}

async function profile(el, b, data) {
  mount(el,
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'card' },
        h('h3', null, 'Profil bisnis'),
        h('dl', { class: 'kv', style: { marginTop: '10px' } },
          h('dt', null, 'Business ID'), h('dd', { class: 'mono' }, `${b.code} (#${b.id})`),
          h('dt', null, 'Slug'), h('dd', { class: 'mono' }, b.slug),
          h('dt', null, 'Industri'), h('dd', null, b.industry || '-'),
          h('dt', null, 'Status'), h('dd', null, badge(b.status)),
          h('dt', null, 'Manager'), h('dd', null, b.manager?.name || 'Belum ada — Group CEO akan menangani langsung'),
          h('dt', null, 'Telegram'), h('dd', { class: 'mono' }, `/business ${b.slug}`),
          h('dt', null, 'Dibuat'), h('dd', null, fmtDate(b.created_at))),
        h('h3', { style: { marginTop: '14px' } }, 'Deskripsi'),
        b.description ? md(b.description) : h('p', { class: 'muted' }, 'Belum ada deskripsi.')),
      h('div', { class: 'card' },
        h('h3', null, 'Ringkasan'),
        h('dl', { class: 'kv', style: { marginTop: '10px' } },
          h('dt', null, 'Tugas'), h('dd', null, `${b.stats.total} total · ${b.stats.active} aktif · ${b.stats.completed} selesai · ${b.stats.failed} gagal`),
          h('dt', null, 'Tim'), h('dd', null, `${data.team.length} karyawan`),
          h('dt', null, 'Persetujuan'), h('dd', null, `${data.approvals_pending} menunggu`),
          h('dt', null, 'Keuangan bulan ini'), h('dd', null, data.finance_month ? data.finance_month.currencies.map((c) => `${c.currency}: masuk ${fmtMoney(c.income, c.currency)}, keluar ${fmtMoney(c.expense, c.currency)}`).join(' · ') : 'Belum ada catatan')),
        h('h3', { style: { marginTop: '14px' } }, 'Isolasi data'),
        h('p', { class: 'small muted' }, 'Tugas, percakapan, memori, dokumen, laporan, dan catatan keuangan bisnis ini hanya dipakai sebagai konteks AI untuk bisnis ini. Dokumen hanya terlihat oleh bisnis lain bila Anda membagikannya secara eksplisit.'),
        b.extra_access.length ? h('p', { class: 'small' }, `Akses tambahan manager ke bisnis: ${b.extra_access.join(', ')}`) : null))
  );
}

async function team(el, b, data, ctx) {
  mount(el,
    h('div', { class: 'card card-flush' },
      data.team.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Nama'), h('th', null, 'Jabatan'), h('th', null, 'Unit'), h('th', null, 'Model'), h('th', null, 'Status'))),
            h('tbody', null, data.team.map((e) =>
              h('tr', { class: 'clickable', onclick: () => ctx.navigate(`#/employees/${e.id}`) },
                h('td', null, avatarCanvas(e.avatar, 2)),
                h('td', null, h('strong', null, e.name), e.id === b.manager_employee_id ? h('div', { class: 'small muted' }, 'Business Manager') : null),
                h('td', null, e.role), h('td', null, e.org_unit === 'shared' ? 'Shared' : 'Bisnis'),
                h('td', { class: 'mono small' }, e.model || `default (${e.tier})`),
                h('td', null, e.enabled ? badge('active') : badge('inactive')))))))
        : emptyState('Belum ada karyawan. Tambahkan melalui Edit profil atau menu AI Employees.')),
    h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Shared Services (Group Finance, Secretary, Researcher, Developer, HR) selalu dapat membantu semua bisnis tanpa diduplikasi.')
  );
}

const COLS = [
  ['pending', 'Pending', (t) => t.status === 'pending' || t.status === 'assigned'],
  ['processing', 'Processing', (t) => t.status === 'processing'],
  ['completed', 'Completed', (t) => t.status === 'completed'],
  ['failed', 'Failed / Cancelled', (t) => t.status === 'failed' || t.status === 'cancelled'],
];

async function board(el, b, _data, ctx) {
  const draw = async () => {
    const { items } = await get(`/api/tasks?business_id=${b.id}&limit=100`);
    mount(el,
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } },
        COLS.map(([key, label, fn]) => {
          const list = items.filter(fn);
          return h('div', { class: 'card', style: { background: 'var(--surface-2)' } },
            h('div', { class: 'card-head' }, h('strong', null, label), badge(key, String(list.length))),
            list.length
              ? h('div', { class: 'stack-sm' }, list.slice(0, 25).map((t) =>
                  h('a', { class: 'card', href: `#/task/${t.id}`, style: { padding: '10px', color: 'inherit', textDecoration: 'none' } },
                    h('div', { class: 'small muted mono' }, `${taskCode(t.id)} · ${KIND_LABEL[t.kind]} · ${PRIORITY[t.priority]}`),
                    h('div', null, t.title),
                    h('div', { class: 'small muted' }, `${t.employee_name || '-'} · ${fmtRel(t.updated_at)}`))))
              : h('p', { class: 'small muted' }, 'Kosong'));
        })));
  };
  await draw();
  ctx.poll(draw, 8000);
}

async function knowledge(el, b, _data, ctx) {
  const draw = async () => {
    const [docs, businesses] = await Promise.all([get(`/api/businesses/${b.id}/documents`), get('/api/businesses')]);
    const others = businesses.filter((x) => x.id !== b.id);
    const q = h('input', { placeholder: 'Uji pencarian knowledge base (seperti yang dilihat AI)…', maxlength: 200 });
    const results = h('div', { class: 'stack-sm' });
    mount(el,
      h('div', { class: 'stack' },
        h('div', { class: 'row-between' },
          h('p', { class: 'muted', style: { margin: 0 } }, 'Dokumen teks (.txt, .md, .csv, .json) menjadi konteks AI hanya untuk bisnis ini.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => docForm(b, null, draw) }, '+ Tulis dokumen'),
            uploadButton(b, draw))),
        h('div', { class: 'card' }, h('form', { class: 'row', onsubmit: async (e) => {
          e.preventDefault();
          if (!q.value.trim()) return;
          const r = await get(`/api/businesses/${b.id}/knowledge/search?q=${encodeURIComponent(q.value)}`).catch(errToast);
          mount(results, r?.length ? r.map((d) => h('div', { class: 'list-item' }, h('div', null, h('strong', null, d.title), h('div', { class: 'small muted' }, d.snippet.slice(0, 300))))) : h('p', { class: 'small muted' }, 'Tidak ada hasil.'));
        } }, h('div', { class: 'grow' }, q), h('button', { class: 'btn', type: 'submit' }, 'Cari')), results),
        h('div', { class: 'card card-flush' },
          docs.length
            ? h('div', { class: 'table-wrap' }, h('table', null,
                h('thead', null, h('tr', null, h('th', null, 'Judul'), h('th', null, 'Jenis'), h('th', { class: 'num' }, 'Ukuran'), h('th', null, 'Diperbarui'), h('th', null, 'Dibagikan'), h('th', null, ''))),
                h('tbody', null, docs.map((d) => h('tr', null,
                  h('td', null, h('strong', null, d.title), d.shared_in ? h('div', { class: 'small muted' }, 'Dibagikan dari bisnis lain (hanya baca)') : h('div', { class: 'small muted' }, d.excerpt.slice(0, 90))),
                  h('td', null, d.kind === 'knowledge' ? 'Knowledge' : 'Dokumen'),
                  h('td', { class: 'num small' }, `${Math.ceil(d.size / 1024)} KB`),
                  h('td', { class: 'small' }, fmtRel(d.updated_at)),
                  h('td', { class: 'small' }, d.shared_in ? '-' : d.shared_with.length ? d.shared_with.map((id) => others.find((o) => o.id === id)?.name || `#${id}`).join(', ') : 'Tidak'),
                  h('td', { class: 'nowrap' }, d.shared_in ? null : [
                    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => docForm(b, await get(`/api/businesses/${b.id}/documents/${d.id}`), draw) }, 'Edit'),
                    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => shareForm(b, d, others, draw) }, 'Bagikan'),
                    h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', onclick: async () => {
                      if (!(await confirmDialog(`Hapus dokumen "${d.title}"?`, { danger: true, okLabel: 'Hapus' }))) return;
                      await del(`/api/businesses/${b.id}/documents/${d.id}`).catch(errToast);
                      draw();
                    } }, 'Hapus'),
                  ]))))))
            : emptyState('Knowledge base masih kosong. AI memakai riset web dan pengetahuan umum (ditandai estimasi) sampai ada dokumen.'))));
  };
  await draw();
}

function uploadButton(b, done) {
  const input = h('input', { type: 'file', accept: '.txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json', hidden: true, multiple: true });
  input.addEventListener('change', async () => {
    for (const f of input.files) {
      if (f.size > 200 * 1024) {
        toast(`${f.name} lebih dari 200 KB`, 'error');
        continue;
      }
      try {
        const content = await readFileAs(f);
        const mime = f.type || (f.name.endsWith('.md') ? 'text/markdown' : f.name.endsWith('.csv') ? 'text/csv' : f.name.endsWith('.json') ? 'application/json' : 'text/plain');
        await post(`/api/businesses/${b.id}/documents`, { title: f.name.replace(/\.[^.]+$/, ''), content, filename: f.name, mime, kind: 'knowledge' });
        toast(`${f.name} diunggah`, 'ok');
      } catch (e) {
        errToast(e);
      }
    }
    input.value = '';
    done();
  });
  return h('span', null, input, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => input.click() }, 'Unggah file'));
}

function docForm(b, doc, done) {
  const title = h('input', { value: doc?.title || '', maxlength: 200 });
  const kind = select([['knowledge', 'Knowledge base (dipakai AI)'], ['document', 'Dokumen']], doc?.kind || 'knowledge');
  const content = h('textarea', { rows: 14, maxlength: 210000 }, doc?.content || '');
  modal({
    title: doc ? 'Edit dokumen' : 'Dokumen baru',
    wide: true,
    body: h('div', { class: 'stack' }, field('Judul', title), doc ? null : field('Jenis', kind), field('Isi (teks/Markdown)', content)),
    actions: [{ label: 'Batal' }, {
      label: 'Simpan', kind: 'primary', onClick: async () => {
        if (doc) await put(`/api/businesses/${b.id}/documents/${doc.id}`, { title: title.value, content: content.value });
        else await post(`/api/businesses/${b.id}/documents`, { title: title.value, content: content.value, kind: kind.value });
        toast('Dokumen disimpan', 'ok');
        done();
      },
    }],
  });
}

function shareForm(b, d, others, done) {
  const boxes = others.map((o) => {
    const input = h('input', { type: 'checkbox', value: o.id, checked: d.shared_with.includes(o.id) });
    return { input, el: h('label', { class: 'check' }, input, o.name) };
  });
  modal({
    title: `Bagikan "${d.title}"`,
    body: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Bisnis yang dipilih dapat membaca dokumen ini sebagai konteks AI. Mereka tidak dapat mengubahnya.'), boxes.map((x) => x.el)),
    actions: [{ label: 'Batal' }, {
      label: 'Simpan izin', kind: 'primary', onClick: async () => {
        await put(`/api/businesses/${b.id}/documents/${d.id}/shares`, { business_ids: boxes.filter((x) => x.input.checked).map((x) => Number(x.input.value)) });
        toast('Izin dokumen diperbarui', 'ok');
        done();
      },
    }],
  });
}

async function finance(el, b) {
  const draw = async (from, to) => {
    const qs = from && to ? `?from=${from}&to=${to}` : '';
    const f = await get(`/api/businesses/${b.id}/finance${qs}`);
    const fromI = h('input', { type: 'date', value: f.from });
    const toI = h('input', { type: 'date', value: f.to });
    mount(el,
      h('div', { class: 'stack' },
        h('div', { class: 'row-between' },
          h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); draw(fromI.value, toI.value); } }, fromI, toI, h('button', { class: 'btn', type: 'submit' }, 'Tampilkan')),
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => importForm(b, () => draw(f.from, f.to)) }, 'Impor CSV'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => recordForm(b, () => draw(f.from, f.to)) }, '+ Catatan'))),
        h('div', { class: 'stats' },
          f.summary
            ? f.summary.currencies.flatMap((c) => [
                h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, `Pemasukan (${c.currency})`), h('div', { class: 'stat-value' }, fmtMoney(c.income, c.currency))),
                h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, `Pengeluaran (${c.currency})`), h('div', { class: 'stat-value' }, fmtMoney(c.expense, c.currency))),
                h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, `Bersih (${c.currency})`), h('div', { class: 'stat-value', style: { color: c.net >= 0 ? 'var(--ok)' : 'var(--err)' } }, fmtMoney(c.net, c.currency))),
              ])
            : h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Ringkasan'), h('div', { class: 'stat-value' }, 'Belum ada'), h('div', { class: 'stat-sub' }, 'Belum ada catatan pada periode ini'))),
        h('div', { class: 'card card-flush' },
          f.records.length
            ? h('div', { class: 'table-wrap' }, h('table', null,
                h('thead', null, h('tr', null, h('th', null, 'Tanggal'), h('th', null, 'Tipe'), h('th', null, 'Kategori'), h('th', { class: 'num' }, 'Jumlah'), h('th', null, 'Keterangan'), h('th', null, ''))),
                h('tbody', null, f.records.map((r) => h('tr', null,
                  h('td', { class: 'nowrap' }, r.record_date), h('td', null, badge(r.type === 'income' ? 'completed' : 'pending', r.type === 'income' ? 'Masuk' : 'Keluar')),
                  h('td', null, r.category || '-'), h('td', { class: 'num' }, fmtMoney(r.amount, r.currency)), h('td', { class: 'small' }, r.description || ''),
                  h('td', null, h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', onclick: async () => {
                    if (!(await confirmDialog('Hapus catatan ini?', { danger: true, okLabel: 'Hapus' }))) return;
                    await del(`/api/businesses/${b.id}/finance/${r.id}`).catch(errToast);
                    draw(f.from, f.to);
                  } }, 'Hapus')))))))
            : emptyState('Belum ada catatan keuangan pada periode ini.'))));
  };
  await draw();
}

function recordForm(b, done) {
  const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const type = select([['income', 'Pemasukan'], ['expense', 'Pengeluaran']], 'income');
  const cat = h('input', { maxlength: 80, placeholder: 'penjualan, gaji, sewa…' });
  const amount = h('input', { type: 'number', min: 0, step: 'any' });
  const cur = h('input', { value: 'IDR', maxlength: 3 });
  const desc = h('input', { maxlength: 500 });
  modal({
    title: `Catatan keuangan — ${b.name}`,
    body: h('div', { class: 'form-grid' }, field('Tanggal', date), field('Tipe', type), field('Kategori', cat), field('Jumlah', amount), field('Mata uang', cur), field('Keterangan', desc)),
    actions: [{ label: 'Batal' }, {
      label: 'Simpan', kind: 'primary', onClick: async () => {
        await post(`/api/businesses/${b.id}/finance`, { record_date: date.value, type: type.value, category: cat.value, amount: Number(amount.value), currency: cur.value.toUpperCase(), description: desc.value });
        toast('Catatan disimpan', 'ok');
        done();
      },
    }],
  });
}

function importForm(b, done) {
  const ta = h('textarea', { rows: 10, placeholder: 'tanggal,tipe,kategori,jumlah,mata_uang,keterangan\n2026-11-01,income,penjualan,1500000,IDR,Penjualan harian' });
  modal({
    title: `Impor CSV — ${b.name}`,
    body: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Kolom: tanggal (YYYY-MM-DD), tipe (income/expense), kategori, jumlah, mata uang, keterangan. Semua baris masuk ke bisnis ini saja.'), ta),
    actions: [{ label: 'Batal' }, {
      label: 'Impor', kind: 'primary', onClick: async () => {
        const r = await post(`/api/businesses/${b.id}/finance/import`, { csv: ta.value });
        toast(`${r.imported} catatan diimpor`, 'ok');
        done();
      },
    }],
  });
}

async function activity(el, b) {
  const rows = await get(`/api/businesses/${b.id}/activity`);
  mount(el, h('div', { class: 'card' },
    rows.length
      ? h('div', { class: 'list timeline' }, rows.map((r) => h('div', { class: 'list-item' },
          h('span', { class: 'small muted nowrap' }, fmtDate(r.created_at)),
          h('div', { class: 'grow' }, h('a', { href: `#/task/${r.task_id}` }, `${taskCode(r.task_id)} ${r.title}`), h('div', { class: 'small muted' }, `${r.event}${r.message ? `: ${r.message}` : ''}`)),
          r.level !== 'info' ? badge(r.level === 'error' ? 'failed' : 'pending', r.level) : null)))
      : emptyState('Belum ada aktivitas.')));
}

async function reports(el, b) {
  const list = await get(`/api/businesses/${b.id}/reports`);
  mount(el, h('div', { class: 'card' },
    list.length
      ? h('div', { class: 'list' }, list.map((r) => h('div', { class: 'list-item' },
          h('div', { class: 'grow' }, h('strong', null, r.title), h('div', { class: 'small muted' }, `${r.employee_name || '-'} · ${fmtDate(r.created_at)}`), h('div', { class: 'small' }, r.excerpt.replace(/[#*`]/g, '').slice(0, 220))),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
            const full = await get(`/api/reports/${r.id}`);
            modal({ title: full.title, wide: true, body: h('div', { class: 'result-box' }, md(full.content)) });
          } }, 'Baca'))))
      : emptyState('Belum ada laporan. Laporan dibuat otomatis saat business task selesai.')));
}
