import { get, post, put } from '../api.js';
import { h, mount, badge, bizLogo, field, select, modal, toast, emptyState, fmtRel, readFileAs } from '../ui.js';
import { financeLine } from './overview.js';

// Shared business profile form (create + edit).
export async function businessForm(b = null, onSaved) {
  const employees = await get('/api/employees');
  const candidates = employees.filter((e) => !e.is_manager);
  const name = h('input', { value: b?.name || '', maxlength: 80, required: true });
  const industry = h('input', { value: b?.industry || '', maxlength: 80, placeholder: 'Contoh: F&B, Olahraga, Teknologi' });
  const desc = h('textarea', { rows: 4, maxlength: 4000 }, b?.description || '');
  const color = h('input', { type: 'color', value: b?.color || '#3b82f6' });
  const status = select([['active', 'Aktif'], ['inactive', 'Nonaktif']], b?.status || 'active');
  const manager = select([['', '— belum ada —'], ...candidates.map((e) => [e.id, `${e.name} — ${e.role}`])], b?.manager_employee_id || '');
  const staffBoxes = candidates.map((e) => {
    const input = h('input', { type: 'checkbox', value: e.id, checked: b ? b.employee_ids.includes(e.id) : false });
    return { input, el: h('label', { class: 'check' }, input, `${e.name} — ${e.role}`, e.org_unit === 'shared' ? h('span', { class: 'small muted' }, ' (shared)') : null) };
  });
  const logoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  modal({
    title: b ? `Edit ${b.name}` : 'Tambah bisnis',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Nama bisnis', name),
      field('Industri', industry),
      h('div', { class: 'full' }, field('Deskripsi', desc, 'Dipakai sebagai konteks AI untuk bisnis ini saja.')),
      field('Business Manager', manager, 'Satu karyawan hanya dapat menjadi manager satu bisnis.'),
      field('Status', status),
      field('Warna (kartu & area kantor)', color),
      field('Logo (PNG/JPEG/WebP, maks 300 KB)', logoInput),
      h('div', { class: 'full field' }, h('span', null, 'Karyawan yang menangani bisnis ini'),
        h('div', { class: 'grid grid-2', style: { gap: '4px 16px', maxHeight: '220px', overflowY: 'auto' } }, staffBoxes.map((s) => s.el))),
    ),
    actions: [
      { label: 'Batal' },
      {
        label: 'Simpan',
        kind: 'primary',
        onClick: async () => {
          if (!name.value.trim()) {
            toast('Nama bisnis wajib diisi', 'error');
            return false;
          }
          const payload = {
            name: name.value.trim(), industry: industry.value.trim(), description: desc.value, color: color.value, status: status.value,
            manager_employee_id: manager.value ? Number(manager.value) : null,
            employee_ids: staffBoxes.filter((s) => s.input.checked).map((s) => Number(s.input.value)),
          };
          let saved = b ? await put(`/api/businesses/${b.id}`, payload) : await post('/api/businesses', payload);
          const file = logoInput.files[0];
          if (file) {
            if (file.size > 300 * 1024) toast('Logo lebih dari 300 KB, tidak diunggah', 'error');
            else saved = await post(`/api/businesses/${saved.id}/logo`, { data_url: await readFileAs(file, 'dataurl') });
          }
          toast(b ? 'Bisnis diperbarui' : 'Bisnis ditambahkan', 'ok');
          onSaved?.(saved);
        },
      },
    ],
  });
}

export async function render(root, _params, ctx) {
  const draw = async () => {
    const list = await get('/api/businesses');
    mount(
      root,
      h('div', { class: 'stack' },
        h('div', { class: 'row-between' },
          h('p', { class: 'muted', style: { margin: 0 } }, `${list.length} bisnis terdaftar. Semua data bisnis diisolasi per bisnis.`),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => businessForm(null, (b) => ctx.navigate(`#/business/${b.id}`)) }, '+ Tambah bisnis')),
        list.length
          ? h('div', { class: 'grid grid-cards' },
              list.map((b) =>
                h('div', { class: 'card biz-card', style: { '--biz': b.color } },
                  h('div', { class: 'row' }, bizLogo(b), h('div', { class: 'grow' }, h('a', { href: `#/business/${b.id}` }, h('strong', null, b.name)), h('div', { class: 'small muted' }, `${b.code} · ${b.industry || 'industri belum diisi'}`)), badge(b.status)),
                  h('dl', { class: 'kv' },
                    h('dt', null, 'Manager'), h('dd', null, b.manager ? `${b.manager.name}${b.manager.enabled ? '' : ' (nonaktif)'}` : 'Belum ada'),
                    h('dt', null, 'Tugas'), h('dd', null, `${b.stats.total} total · ${b.stats.active} aktif · ${b.stats.completed} selesai`),
                    h('dt', null, 'Slug Telegram'), h('dd', { class: 'mono' }, `/business ${b.slug}`)),
                  h('div', { class: 'small' }, h('div', { class: 'muted' }, 'Laporan terbaru:'),
                    b.latest_report ? [h('div', null, b.latest_report.title), h('div', { class: 'muted' }, `${b.latest_report.excerpt.replace(/[#*`]/g, '').slice(0, 160)}… (${fmtRel(b.latest_report.created_at)})`)] : h('div', { class: 'muted' }, 'Belum ada')),
                  h('div', { class: 'row' },
                    h('a', { class: 'btn btn-sm', href: `#/business/${b.id}` }, 'Buka'),
                    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.openNewTask({ mode: 'business', business_id: b.id }) }, '+ Tugas'),
                    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => businessForm(b, draw) }, 'Edit'))
                )
              )
            )
          : emptyState('Belum ada bisnis. Tambahkan bisnis pertama Anda.')
      )
    );
  };
  await draw();
}

export { financeLine };
