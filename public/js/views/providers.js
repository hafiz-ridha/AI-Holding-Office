import { get, post, put, del } from '../api.js';
import { h, mount, badge, field, select, modal, toast, errToast, confirmDialog, emptyState, fmtRel, fmtNum } from '../ui.js';

const TIERS = [
  ['group_ceo', 'Group CEO'], ['business_manager', 'Business Manager'], ['shared_services', 'Shared Services'], ['business_staff', 'Staf unit bisnis'],
];

const CAT_ORDER = ['free', 'trial', 'self_hosted', 'custom'];

function presetSelect(presets, categories, value, disabled) {
  const s = h('select', { disabled });
  for (const cat of CAT_ORDER) {
    const g = h('optgroup', { label: categories[cat] || cat });
    for (const p of presets.filter((x) => x.category === cat)) g.append(h('option', { value: p.key, selected: p.key === value }, p.label));
    if (g.children.length) s.append(g);
  }
  return s;
}

async function providerForm(p, presets, done, initialPreset = null, categories = {}) {
  const preset = presetSelect(presets, categories, p?.preset || initialPreset || 'openrouter', Boolean(p));
  const phWrap = h('div', { class: 'full stack-sm' });
  const phInputs = {};
  const keyLink = h('p', { class: 'small full', style: { margin: 0 } });
  const name = h('input', { value: p?.name || '', maxlength: 80 });
  const baseUrl = h('input', { value: p?.base_url || '', maxlength: 300 });
  const apiKey = h('input', { type: 'password', autocomplete: 'off', maxlength: 400, placeholder: p?.has_api_key ? `Tersimpan (${p.api_key_hint}). Kosongkan bila tidak diubah.` : 'Tempel API key' });
  const clearKey = h('input', { type: 'checkbox' });
  const defModel = h('input', { value: p?.default_model || '', maxlength: 200, list: 'prov-models', placeholder: 'contoh: meta-llama/llama-3.3-70b-instruct:free' });
  const fallbacks = h('textarea', { rows: 3, placeholder: 'Satu model per baris, urut prioritas (utamakan model gratis)' }, (p?.fallback_models || []).join('\n'));
  const timeout = h('input', { type: 'number', min: 5, max: 300, value: Math.round((p?.timeout_ms || 60000) / 1000) });
  const retries = h('input', { type: 'number', min: 0, max: 3, value: p?.max_retries ?? 1 });
  const rpm = h('input', { type: 'number', min: 0, value: p?.rpm_limit ?? '' });
  const daily = h('input', { type: 'number', min: 0, value: p?.daily_request_limit ?? '' });
  const priority = h('input', { type: 'number', min: 0, max: 1000, value: p?.priority ?? 100 });
  const enabled = h('input', { type: 'checkbox', checked: p ? p.enabled : true });
  const note = h('p', { class: 'small muted full' });
  const list = h('datalist', { id: 'prov-models' });
  if (p) get(`/api/providers/${p.id}/models`).then((ms) => ms.slice(0, 400).forEach((m) => list.append(h('option', { value: m.id }, `${m.is_free ? '[gratis] ' : ''}${m.name}`)))).catch(() => {});
  let lastLabel = null;
  const applyPreset = () => {
    const pr = presets.find((x) => x.key === preset.value);
    if (!p) {
      baseUrl.value = pr.base_url;
      if (!name.value || name.value === lastLabel) name.value = pr.label;
      lastLabel = pr.label;
      rpm.value = pr.rpm_limit;
      daily.value = pr.daily_request_limit;
      if (!defModel.value && pr.models?.length) defModel.value = pr.models[0];
      if (!fallbacks.value && pr.models?.length > 1) fallbacks.value = pr.models.slice(1).join('\n');
    }
    note.textContent = [pr.free !== '-' ? `Gratis: ${pr.free}` : '', pr.note || '', pr.keyRequired ? '' : 'API key opsional.'].filter(Boolean).join(' ');
    mount(keyLink,
      pr.key_url ? h('a', { href: pr.key_url, target: '_blank', rel: 'noopener noreferrer' }, 'Ambil API key ↗') : null,
      pr.key_url && pr.docs ? ' · ' : null,
      pr.docs ? h('a', { href: pr.docs, target: '_blank', rel: 'noopener noreferrer' }, 'Dokumentasi ↗') : null);
    // Placeholders such as {ACCOUNT_ID} get their own input and are substituted into the Base URL on save.
    mount(phWrap);
    for (const k of Object.keys(phInputs)) delete phInputs[k];
    if (!p) {
      for (const ph of pr.placeholders || []) {
        const i = h('input', { maxlength: 100, placeholder: ph.label });
        phInputs[ph.key] = { input: i, ph };
        phWrap.append(field(ph.label, i, `Mengisi {${ph.key}} pada Base URL.`));
      }
    }
  };
  preset.addEventListener('change', applyPreset);
  applyPreset();
  modal({
    title: p ? `Edit ${p.name}` : 'Tambah AI provider',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Jenis provider', preset), field('Nama', name),
      h('div', { class: 'full' }, field('Base URL', baseUrl)), phWrap, note, keyLink,
      h('div', { class: 'full' }, field('API key (disimpan terenkripsi, tidak pernah dikirim ke browser)', apiKey)),
      p?.has_api_key ? h('label', { class: 'check full' }, clearKey, 'Hapus API key tersimpan') : null,
      field('Model default', h('div', null, defModel, list), 'Gunakan "Ambil daftar model" untuk mengisi saran.'),
      field('Prioritas cadangan (kecil = dicoba dulu)', priority),
      h('div', { class: 'full' }, field('Model fallback', fallbacks)),
      field('Timeout (detik)', timeout), field('Retry per model (0–3)', retries),
      field('Batas request per menit (0 = tanpa batas)', rpm), field('Batas request per hari (0 = tanpa batas)', daily),
      h('label', { class: 'check full' }, enabled, 'Aktif')),
    actions: [{ label: 'Batal' }, {
      label: 'Simpan', kind: 'primary', onClick: async () => {
        let url = baseUrl.value.trim();
        for (const [key, { input, ph }] of Object.entries(phInputs)) {
          const v = input.value.trim();
          if (ph.pattern && !new RegExp(ph.pattern).test(v)) {
            toast(`${ph.label} tidak valid`, 'error');
            return false;
          }
          url = url.replace(`{${key}}`, v);
        }
        const body = {
          name: name.value.trim() || undefined, base_url: url, default_model: defModel.value.trim() || null,
          fallback_models: fallbacks.value.split('\n').map((s) => s.trim()).filter(Boolean),
          timeout_ms: Math.max(5, Number(timeout.value) || 60) * 1000, max_retries: Number(retries.value) || 0,
          rpm_limit: Number(rpm.value) || 0, daily_request_limit: Number(daily.value) || 0, priority: Number(priority.value) || 0, enabled: enabled.checked,
        };
        if (apiKey.value.trim()) body.api_key = apiKey.value.trim();
        if (clearKey.checked) body.clear_api_key = true;
        if (p) await put(`/api/providers/${p.id}`, body);
        else await post('/api/providers', { ...body, preset: preset.value });
        apiKey.value = '';
        toast('Provider disimpan', 'ok');
        done();
      },
    }],
  });
}

// Catalogue of every cloud AI API the app supports out of the box, grouped by kind of free access.
function catalogCard(presets, configured, catalog, onAdd) {
  const count = (key) => configured.filter((p) => p.preset === key).length;
  const open = !configured.length;
  return h('details', { class: 'card', open },
    h('summary', null, h('strong', null, `Katalog provider AI cloud (${presets.filter((p) => p.category === 'free' || p.category === 'trial').length} gratis/kredit)`),
      h('span', { class: 'small muted' }, ' · klik "Tambah", isi API key, lalu Test connection')),
    h('div', { class: 'stack', style: { marginTop: '12px' } },
      CAT_ORDER.filter((c) => c !== 'custom').map((cat) => h('div', { class: 'stack-sm' },
        h('h3', null, catalog.categories[cat]),
        h('div', { class: 'grid grid-cards' }, presets.filter((p) => p.category === cat).map((p) => h('div', { class: 'card stack-sm', style: { padding: '12px', background: 'var(--surface-2)' } },
          h('div', { class: 'row-between' }, h('strong', null, p.label), count(p.key) ? badge('ok', `${count(p.key)} terpasang`) : null),
          h('div', { class: 'small' }, p.free),
          h('div', { class: 'small muted' }, p.keyRequired ? 'API key diperlukan' : 'API key opsional', p.rpm_limit ? ` · default ${p.rpm_limit}/menit` : '', p.daily_request_limit ? ` · ${p.daily_request_limit}/hari` : ''),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => onAdd(p.key) }, '+ Tambah'),
            p.key_url ? h('a', { class: 'btn btn-sm btn-ghost', href: p.key_url, target: '_blank', rel: 'noopener noreferrer' }, 'Ambil key ↗') : null)))))),
      h('details', null, h('summary', { class: 'small' }, 'Diteliti tetapi tidak dijadikan preset'),
        h('ul', { class: 'small muted' }, catalog.excluded.map((x) => h('li', null, h('strong', null, x.name), ': ', x.reason)))),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Batas free tier dapat berubah sewaktu-waktu. Aplikasi menegakkan batas per menit/hari yang Anda atur pada tiap provider, lalu otomatis beralih ke provider cadangan bila kuota habis.')));
}

function modelsDialog(p) {
  const q = h('input', { placeholder: 'Cari model…' });
  const freeOnly = h('input', { type: 'checkbox', checked: p.preset === 'openrouter' });
  const out = h('div');
  const load = async () => {
    const ms = await get(`/api/providers/${p.id}/models?free=${freeOnly.checked}&q=${encodeURIComponent(q.value)}`);
    mount(out, ms.length
      ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Model'), h('th', null, 'Konteks'), h('th', null, 'Harga'), h('th', null, ''))),
          h('tbody', null, ms.map((m) => h('tr', null,
            h('td', null, h('div', { class: 'mono small' }, m.id), h('div', { class: 'small muted' }, m.name)),
            h('td', { class: 'small' }, m.context_length ? fmtNum(m.context_length) : '-'),
            h('td', null, m.is_free ? badge('completed', 'Gratis') : h('span', { class: 'small muted' }, m.pricing_prompt !== null ? `$${(m.pricing_prompt * 1e6).toFixed(2)}/M` : '-')),
            h('td', { class: 'nowrap' },
              h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { await put(`/api/providers/${p.id}`, { default_model: m.id }); toast('Model default diubah', 'ok'); } }, 'Jadikan default'),
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
                const cur = (await get('/api/providers')).find((x) => x.id === p.id);
                const fb = [...new Set([...(cur.fallback_models || []), m.id])].slice(0, 10);
                await put(`/api/providers/${p.id}`, { fallback_models: fb });
                toast('Ditambahkan ke fallback', 'ok');
              } }, '+ Fallback'),
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async (ev) => {
                ev.target.disabled = true;
                const r = await post(`/api/providers/${p.id}/test-model`, { model: m.id }).catch(errToast);
                ev.target.disabled = false;
                if (r) toast(r.ok ? `OK (${r.latency_ms} ms): ${r.reply}` : `Gagal: ${r.error}`, r.ok ? 'ok' : 'error');
              } }, 'Tes')))))))
      : h('p', { class: 'muted' }, 'Tidak ada model. Klik "Ambil daftar model" pada provider.'));
  };
  q.addEventListener('input', () => load());
  freeOnly.addEventListener('change', load);
  modal({ title: `Model ${p.name}`, wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, q), h('label', { class: 'check' }, freeOnly, 'Hanya gratis')), h('p', { class: 'small muted' }, 'Tombol "Tes" mengirim 1 request kecil (memakai kuota).'), out) });
  load();
}

async function tierCard(providers, done) {
  const s = await get('/api/settings');
  const tiers = s.values.tier_models;
  const rows = TIERS.map(([key, label]) => {
    const prov = select([['', 'Provider default'], ...providers.map((p) => [p.id, p.name])], tiers[key]?.provider_id || '');
    const model = h('input', { value: tiers[key]?.model || '', placeholder: 'Model default provider', maxlength: 200 });
    return { key, label, prov, model };
  });
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Model default per tingkatan'), h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: async () => {
      const v = {};
      for (const r of rows) v[r.key] = { provider_id: r.prov.value ? Number(r.prov.value) : null, model: r.model.value.trim() || null };
      await put('/api/settings', { tier_models: v }).then(() => toast('Model per tingkatan disimpan', 'ok')).catch(errToast);
      done();
    } }, 'Simpan')),
    h('p', { class: 'small muted' }, 'Urutan pemilihan: model khusus karyawan → model tingkatan → model default provider default → fallback (utamakan model gratis) → provider cadangan. Semua memakai satu AI router bersama.'),
    h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, rows.map((r) => h('tr', null, h('td', null, h('strong', null, r.label)), h('td', { style: { minWidth: '160px' } }, r.prov), h('td', { style: { minWidth: '220px' } }, r.model)))))));
}

export async function render(root, _params, ctx) {
  const draw = async () => {
    const [list, presets, catalog] = await Promise.all([get('/api/providers'), get('/api/providers/presets'), get('/api/providers/catalog')]);
    const categories = catalog.categories;
    const action = (label, fn, cls = 'btn-sm') => h('button', { class: `btn ${cls}`, type: 'button', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        await fn();
      } catch (e) {
        errToast(e);
      } finally {
        ev.target.disabled = false;
      }
    } }, label);
    mount(root, h('div', { class: 'stack' },
      h('div', { class: 'row-between' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'Kelola penyedia model AI tanpa mengubah source code. API key disimpan terenkripsi di server.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => providerForm(null, presets, draw, null, categories) }, '+ Tambah provider')),
      catalogCard(presets, list, catalog, (key) => providerForm(null, presets, draw, key, categories)),
      list.length
        ? h('div', { class: 'grid grid-2' }, list.map((p) => h('div', { class: 'card stack-sm' },
            h('div', { class: 'row-between' }, h('div', null, h('strong', null, p.name), p.is_default ? h('span', { class: 'pill', style: { marginLeft: '6px' } }, 'Default') : null, h('div', { class: 'small muted' }, `${p.typeLabel} · prioritas ${p.priority}`)), p.enabled ? badge(p.status) : badge('inactive')),
            h('dl', { class: 'kv' },
              h('dt', null, 'Base URL'), h('dd', { class: 'mono small' }, p.base_url),
              h('dt', null, 'API key'), h('dd', { class: 'mono small' }, p.has_api_key ? p.api_key_hint : 'tidak ada'),
              h('dt', null, 'Model default'), h('dd', { class: 'mono small' }, p.default_model || '— belum diatur —'),
              h('dt', null, 'Fallback'), h('dd', { class: 'mono small' }, p.fallback_models.length ? p.fallback_models.join(', ') : '-'),
              h('dt', null, 'Model'), h('dd', { class: 'small' }, `${p.model_count} (${p.free_model_count} gratis)`),
              h('dt', null, 'Batas'), h('dd', { class: 'small' }, `${p.rpm_limit || '∞'}/menit · ${p.daily_request_limit || '∞'}/hari · timeout ${p.timeout_ms / 1000}s · retry ${p.max_retries}`),
              h('dt', null, 'Status'), h('dd', { class: 'small' }, p.status_message || '-', p.last_checked_at ? h('span', { class: 'muted' }, ` (${fmtRel(p.last_checked_at)})`) : null, p.cooldown_until ? h('div', { style: { color: 'var(--warn)' } }, `Cooldown sampai ${new Date(p.cooldown_until).toLocaleString('id-ID')}`) : null)),
            h('div', { class: 'row' },
              action('Test connection', async () => {
                const r = await post(`/api/providers/${p.id}/test`);
                toast(r.message, r.ok ? 'ok' : 'error');
                draw();
              }),
              action('Ambil daftar model', async () => {
                const r = await post(`/api/providers/${p.id}/models/sync`);
                toast(r.source === 'preset' ? `Provider tidak menyediakan /models; ${r.total} model saran dari preset dipakai.` : `${r.total} model (${r.free} ditandai gratis)`, 'ok');
                draw();
              }),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: () => modelsDialog(p) }, 'Pilih model'),
              p.is_default ? null : action('Jadikan default', async () => { await post(`/api/providers/${p.id}/default`); draw(); }),
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => providerForm(p, presets, draw, null, categories) }, 'Edit'),
              action('Hapus', async () => {
                if (!(await confirmDialog(`Hapus provider ${p.name}?`, { danger: true, okLabel: 'Hapus' }))) return;
                await del(`/api/providers/${p.id}`);
                draw();
              }, 'btn-sm btn-ghost btn-danger')))))
        : h('div', { class: 'card' }, emptyState('AI belum terintegrasi: belum ada provider. Pilih provider dari katalog di atas (mis. Groq, Gemini, OpenRouter), tempel API key, lalu klik Test connection.')),
      list.length ? await tierCard(list, draw) : null));
  };
  await draw();
}
