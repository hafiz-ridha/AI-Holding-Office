import { get, post, put, del } from '../api.js';
import { h, mount, badge, field, select, modal, toast, errToast, confirmDialog, emptyState, fmtDate, ORG_LABEL } from '../ui.js';
import { avatarCanvas } from '../office/sprites.js';

const ROLE_KEYS = [
  ['business_manager', 'Business Manager'], ['marketing', 'Marketing'], ['operations', 'Operations'], ['finance', 'Finance (bisnis)'],
  ['group_finance', 'Group Finance'], ['secretary', 'Secretary'], ['researcher', 'Researcher'], ['developer', 'Developer'], ['hr', 'HR'], ['custom', 'Lainnya'],
];
const HAIR = [['short', 'Pendek'], ['long', 'Panjang'], ['messy', 'Acak'], ['cap', 'Topi'], ['bun', 'Cepol'], ['bald', 'Botak']];
const TIER = { group_ceo: 'Group CEO', business_manager: 'Business Manager', shared_services: 'Shared Services', business_staff: 'Staf bisnis' };

export async function editEmployee(e, done) {
  const [providers, businesses] = await Promise.all([get('/api/providers'), get('/api/businesses')]);
  const isCeo = e?.is_manager;
  const name = h('input', { value: e?.name || '', maxlength: 60 });
  const role = h('input', { value: e?.role || '', maxlength: 80 });
  const roleKey = select(ROLE_KEYS, e?.role_key || 'custom', { disabled: isCeo });
  const org = select([['shared', 'Shared Services'], ['business', 'Unit bisnis']], e?.org_unit === 'business' ? 'business' : 'shared', { disabled: isCeo });
  const personality = h('textarea', { rows: 2, maxlength: 1000 }, e?.personality || '');
  const prompt = h('textarea', { rows: 9, maxlength: 8000, placeholder: 'Kosongkan untuk prompt standar + aturan keamanan' }, e?.system_prompt || '');
  const provider = select([['', '— default tingkatan / provider default —'], ...providers.map((p) => [p.id, `${p.name}${p.enabled ? '' : ' (nonaktif)'}`])], e?.provider_id || '');
  const modelList = h('datalist', { id: 'emp-models' });
  const model = h('input', { value: e?.model || '', maxlength: 200, list: 'emp-models', placeholder: 'Kosongkan agar dipilih otomatis' });
  const loadModels = async () => {
    mount(modelList);
    const pid = provider.value || providers.find((p) => p.is_default)?.id;
    if (!pid) return;
    const models = await get(`/api/providers/${pid}/models`).catch(() => []);
    for (const m of models.slice(0, 300)) modelList.append(h('option', { value: m.id }, `${m.is_free ? '[gratis] ' : ''}${m.name || m.id}`));
  };
  provider.addEventListener('change', loadModels);
  loadModels();
  const temp = h('input', { type: 'number', min: 0, max: 2, step: 0.1, value: e?.temperature ?? 0.7 });
  const maxTok = h('input', { type: 'number', min: 0, max: 32000, value: e?.max_tokens ?? 0 });
  const enabled = h('input', { type: 'checkbox', checked: e ? e.enabled : true, disabled: isCeo });
  const av = { skin: '#f1c27d', hair: '#3b2416', shirt: '#3b82f6', pants: '#1f2937', accent: '#ffffff', hairStyle: 'short', glasses: false, ...(e?.avatar || {}) };
  const preview = h('div');
  const drawPreview = () => mount(preview, avatarCanvas(av, 4));
  const colorInput = (k, label) => {
    const i = h('input', { type: 'color', value: av[k] });
    i.addEventListener('input', () => { av[k] = i.value; drawPreview(); });
    return field(label, i);
  };
  const hairStyle = select(HAIR, av.hairStyle);
  hairStyle.addEventListener('change', () => { av.hairStyle = hairStyle.value; drawPreview(); });
  const glasses = h('input', { type: 'checkbox', checked: av.glasses });
  glasses.addEventListener('change', () => { av.glasses = glasses.checked; drawPreview(); });
  drawPreview();
  const bizBoxes = businesses.map((b) => {
    const input = h('input', { type: 'checkbox', value: b.id, checked: e ? e.business_ids.includes(b.id) : false, disabled: isCeo });
    return { input, el: h('label', { class: 'check' }, input, b.name) };
  });

  modal({
    title: e ? `Edit ${e.name}` : 'Tambah karyawan AI',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Nama', name), field('Jabatan', role),
      field('Peran (role key)', roleKey, isCeo ? 'Group CEO tetap.' : 'Menentukan akses data (mis. hanya finance & manager yang melihat angka keuangan).'),
      field('Unit organisasi', org, 'Shared Services membantu semua bisnis; staf bisnis hanya bisnis yang dipilih.'),
      h('div', { class: 'full field' }, h('span', null, 'Bisnis yang ditangani'), h('div', { class: 'row', style: { gap: '4px 16px' } }, bizBoxes.length ? bizBoxes.map((x) => x.el) : h('span', { class: 'muted small' }, 'Belum ada bisnis'))),
      h('div', { class: 'full' }, field('Kepribadian', personality)),
      h('div', { class: 'full' }, field('System prompt', prompt, 'Aturan keamanan (tanpa eksekusi tindakan, tidak mengarang data, PERLU PERSETUJUAN ADMIN) disarankan tetap ada.')),
      field('Provider khusus', provider, 'Kosong = model tingkatan bila diatur, selain itu dipilih otomatis sesuai kebutuhan tugas.'),
      field('Model khusus', h('div', null, model, modelList)),
      field('Temperature', temp), field('Maks token output (0 = global)', maxTok),
      h('div', { class: 'full field' }, h('span', null, 'Avatar pixel art'),
        h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '16px' } }, preview,
          h('div', { class: 'grid grid-3 grow', style: { gap: '8px' } }, colorInput('skin', 'Kulit'), colorInput('hair', 'Rambut'), colorInput('shirt', 'Baju'), colorInput('pants', 'Celana'), colorInput('accent', 'Aksen'), field('Gaya rambut', hairStyle), h('label', { class: 'check' }, glasses, 'Kacamata')))),
      h('label', { class: 'check full' }, enabled, 'Aktif (karyawan nonaktif tidak menerima tugas)')),
    actions: [
      { label: 'Batal' },
      {
        label: 'Simpan', kind: 'primary', onClick: async () => {
          const payload = {
            name: name.value.trim(), role: role.value.trim(), personality: personality.value, avatar: av,
            provider_id: provider.value ? Number(provider.value) : null, model: model.value.trim() || null,
            temperature: Number(temp.value), max_tokens: Number(maxTok.value) || 0,
          };
          if (prompt.value.trim() || e) payload.system_prompt = prompt.value;
          if (!isCeo) {
            payload.role_key = roleKey.value;
            payload.org_unit = org.value;
            payload.enabled = enabled.checked;
            payload.business_ids = bizBoxes.filter((x) => x.input.checked).map((x) => Number(x.input.value));
          }
          if (!payload.name || !payload.role) {
            toast('Nama dan jabatan wajib diisi', 'error');
            return false;
          }
          if (e) await put(`/api/employees/${e.id}`, payload);
          else await post('/api/employees', payload);
          toast('Karyawan disimpan', 'ok');
          done?.();
        },
      },
    ],
  });
}

function memoriesDialog(e) {
  get(`/api/employees/${e.id}/memories`).then((rows) => {
    modal({
      title: `Memori kerja — ${e.name}`,
      wide: true,
      body: rows.length
        ? h('div', { class: 'list' }, rows.map((m) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { class: 'small muted' }, `${fmtDate(m.created_at)} · ${m.business_name || 'Holding/umum'}`), m.content))))
        : h('p', { class: 'muted' }, 'Belum ada memori.'),
      actions: rows.length ? [{ label: 'Hapus semua memori', kind: 'danger', onClick: async () => { await del(`/api/employees/${e.id}/memories`); toast('Memori dihapus', 'ok'); } }, { label: 'Tutup' }] : [{ label: 'Tutup' }],
    });
  }).catch(errToast);
}

export async function render(root, [openId], ctx) {
  const draw = async () => {
    const [list, businesses] = await Promise.all([get('/api/employees'), get('/api/businesses')]);
    const bizName = (id) => businesses.find((b) => b.id === id)?.name || `#${id}`;
    const groups = [['holding', list.filter((e) => e.org_unit === 'holding')], ['shared', list.filter((e) => e.org_unit === 'shared')], ['business', list.filter((e) => e.org_unit === 'business')]];
    mount(root,
      h('div', { class: 'stack' },
        h('div', { class: 'row-between' },
          h('p', { class: 'muted', style: { margin: 0 } }, `${list.length} profil karyawan AI. Semua berbagi satu AI router; AI hanya dipanggil saat ada tugas.`),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => editEmployee(null, draw) }, '+ Tambah karyawan')),
        groups.map(([key, rows]) =>
          h('div', { class: 'card card-flush' },
            h('div', { style: { padding: '12px 16px' } }, h('h3', null, `${ORG_LABEL[key]} (${rows.length})`)),
            rows.length
              ? h('div', { class: 'table-wrap' }, h('table', null,
                  h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Nama'), h('th', null, 'Jabatan'), h('th', null, 'Bisnis'), h('th', null, 'Model'), h('th', null, 'Status'), h('th', null, ''))),
                  h('tbody', null, rows.map((e) => h('tr', null,
                    h('td', null, avatarCanvas(e.avatar, 2)),
                    h('td', null, h('strong', null, e.name), h('div', { class: 'small muted mono' }, e.slug)),
                    h('td', null, e.role),
                    h('td', { class: 'small' }, e.manages_business_ids.length ? `Manager: ${e.manages_business_ids.map(bizName).join(', ')}` : e.business_ids.length ? e.business_ids.map(bizName).join(', ') : e.org_unit === 'shared' ? 'Semua (sesuai tugas)' : '-'),
                    h('td', { class: 'small mono' }, e.model || h('span', { class: 'muted' }, `default ${TIER[e.tier]}`)),
                    h('td', null, e.enabled ? badge('active') : badge('inactive')),
                    h('td', { class: 'nowrap' },
                      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => editEmployee(e, draw) }, 'Edit'),
                      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => memoriesDialog(e) }, 'Memori'),
                      e.is_manager ? null : h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', onclick: async () => {
                        if (!(await confirmDialog(`Hapus ${e.name}? Riwayat tugas tetap tersimpan.`, { danger: true, okLabel: 'Hapus' }))) return;
                        await del(`/api/employees/${e.id}`).then(() => toast('Karyawan dihapus', 'ok')).catch(errToast);
                        draw();
                      } }, 'Hapus')))))))
              : emptyState('Tidak ada karyawan pada unit ini.')))));
    if (openId) {
      const e = list.find((x) => String(x.id) === String(openId));
      openId = null;
      if (e) editEmployee(e, draw);
    }
  };
  await draw();
}
