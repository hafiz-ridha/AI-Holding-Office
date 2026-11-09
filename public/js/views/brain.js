// Second Brain: knowledge notes distilled from finished work plus facts written by the owner. Every AI model of the
// same scope (holding or one business) reads them before working, so results build on each other.
import { get, post, put, del } from '../api.js';
import { h, mount, md, toast, errToast, confirmDialog, modal, field, select, fmtDate, emptyState } from '../ui.js';

const LIMIT = 30;

export async function render(root, [focusId], ctx) {
  const businesses = await get('/api/businesses');
  const scopes = [['hq', 'Holding (tingkat pusat)'], ...businesses.map((b) => [String(b.id), b.name])];
  const scope = select([['all', 'Semua lingkup'], ...scopes], 'all', { 'aria-label': 'Lingkup' });
  const kind = select([['', 'Semua catatan'], ['work', 'Hasil kerja'], ['fact', 'Fakta owner']], '', { 'aria-label': 'Jenis catatan' });
  const search = h('input', { type: 'search', placeholder: 'Cari… (sinonim ikut dicari, mis. omzet = pendapatan)', 'aria-label': 'Cari pengetahuan' });
  const stats = h('div', { class: 'brain-stats small muted' });
  const list = h('div', { class: 'stack-sm' });
  const more = h('button', { class: 'btn btn-sm', type: 'button', hidden: true, onclick: () => load(true) }, 'Muat lebih banyak');
  let offset = 0;
  let focus = focusId ? Number(focusId) : null;

  const qs = () => {
    const p = new URLSearchParams({ scope: scope.value, limit: String(LIMIT), offset: String(offset) });
    if (search.value.trim()) p.set('q', search.value.trim());
    if (kind.value) p.set('kind', kind.value);
    return p.toString();
  };

  const action = (label, fn, cls = 'btn-sm btn-ghost') => h('button', { class: `btn ${cls}`, type: 'button', onclick: async (ev) => {
    ev.target.disabled = true;
    try {
      await fn();
    } catch (e) {
      errToast(e);
    } finally {
      ev.target.disabled = false;
    }
  } }, label);

  function noteCard(n) {
    const body = h('div', { class: 'brain-content' }, md(n.content));
    const toggle = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
      body.classList.toggle('open');
      toggle.textContent = body.classList.contains('open') ? 'Ringkas' : 'Selengkapnya';
    } }, 'Selengkapnya');
    const meta = [
      n.kind === 'fact' ? 'Fakta owner' : 'Hasil kerja',
      n.business_name || 'Holding',
      n.author,
      n.model ? `model ${n.model}` : null,
      fmtDate(n.created_at),
      n.use_count ? `dipakai AI ${n.use_count}×` : 'belum dipakai AI',
      n.ceo_only ? 'hanya untuk Group CEO' : null,
    ].filter(Boolean).join(' · ');
    const card = h('div', { class: `card brain-note${n.pinned ? ' pinned' : ''}${n.id === focus ? ' focus' : ''}`, id: `note-${n.id}` },
      h('div', { class: 'row-between', style: { alignItems: 'flex-start', gap: '8px' } },
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'small muted' }, `${n.pinned ? '📌 ' : ''}${meta}`),
          h('strong', null, n.title)),
        h('div', { class: 'row', style: { gap: '4px', flexWrap: 'nowrap' } },
          action(n.pinned ? 'Lepas sematan' : 'Sematkan', async () => {
            await put(`/api/knowledge/${n.id}`, { pinned: !n.pinned });
            toast(n.pinned ? 'Sematan dilepas' : 'Disematkan: selalu diberikan ke AI pada lingkup ini', 'ok');
            load();
          }),
          action('Edit', async () => noteForm(n)),
          action('Hapus', async () => {
            if (!(await confirmDialog(`Hapus catatan "${n.title}"? AI tidak akan memakainya lagi.`, { danger: true, okLabel: 'Hapus' }))) return;
            await del(`/api/knowledge/${n.id}`);
            toast('Catatan dihapus', 'ok');
            load();
          }, 'btn-sm btn-ghost btn-danger'))),
      body,
      h('div', { class: 'row', style: { gap: '8px' } }, toggle, n.task_id ? h('a', { class: 'small', href: `#/task/${n.task_id}` }, `Sumber: ${n.task_code} ↗`) : null));
    requestAnimationFrame(() => {
      if (body.scrollHeight <= body.clientHeight + 4 && !body.classList.contains('open')) toggle.hidden = true;
    });
    return card;
  }

  async function load(append = false) {
    if (!append) offset = 0;
    const r = await get(`/api/knowledge?${qs()}`);
    const s = r.stats;
    stats.textContent = `${s.total} catatan · ${s.work} hasil kerja · ${s.facts} fakta · ${s.pinned} disematkan · dipakai AI ${s.uses}×`;
    const cards = r.items.map(noteCard);
    if (append) list.append(...cards);
    else mount(list, cards.length ? cards : emptyState(search.value.trim()
      ? 'Tidak ada catatan yang cocok.'
      : 'Belum ada catatan. Catatan dibuat otomatis dari hasil tugas yang selesai (bukan dari balasan cepat obrolan), atau tambahkan fakta sendiri.'));
    offset += r.items.length;
    more.hidden = offset >= r.total;
    if (focus) {
      const el = list.querySelector(`#note-${focus}`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        focus = null;
      } else if (!append && scope.value === 'all' && !search.value && !kind.value) {
        // Linked note not on the first page: show it alone.
        const n = await get(`/api/knowledge/${focus}`).catch(() => null);
        if (n) list.prepend(noteCard(n));
        focus = null;
      }
    }
  }

  function noteForm(n = null) {
    const sc = select(scopes, n ? (n.business_id ? String(n.business_id) : 'hq') : (scope.value === 'all' ? 'hq' : scope.value), { disabled: Boolean(n) });
    const title = h('input', { value: n?.title || '', maxlength: 200, placeholder: 'mis. Target omzet Coffee Q4' });
    const content = h('textarea', { rows: 8, maxlength: 4000, placeholder: 'mis. Target omzet Coffee Business Q4 2026 = Rp50 juta/bulan. Disepakati owner 1 Nov 2026.' });
    content.value = n?.content || '';
    const pin = h('input', { type: 'checkbox', checked: n ? n.pinned : true });
    modal({
      title: n ? 'Edit catatan' : 'Tambah fakta',
      body: h('div', { class: 'stack-sm' },
        field('Lingkup', sc, n ? 'Lingkup tidak dapat diubah.' : 'Catatan hanya dipakai AI pada lingkup ini (isolasi antarbisnis tetap berlaku).'),
        field('Judul', title),
        field('Isi', content),
        h('label', { class: 'check' }, pin, 'Sematkan: selalu diberikan ke AI pada lingkup ini')),
      actions: [
        { label: 'Batal' },
        { label: 'Simpan', kind: 'primary', onClick: async () => {
          const data = { title: title.value, content: content.value, pinned: pin.checked };
          if (n) await put(`/api/knowledge/${n.id}`, data);
          else await post('/api/knowledge', { ...data, scope: sc.value });
          toast('Catatan disimpan', 'ok');
          load();
        } },
      ],
    });
  }

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(), 250);
  });
  scope.addEventListener('change', () => load());
  kind.addEventListener('change', () => load());

  mount(root, h('div', { class: 'stack' },
    h('div', { class: 'card stack-sm' },
      h('div', { class: 'row-between' },
        h('div', null, h('h2', { style: { margin: 0 } }, 'Second Brain'), stats),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => noteForm() }, '+ Tambah fakta')),
      h('p', { class: 'small muted', style: { margin: 0 } },
        'Pengetahuan bersama semua karyawan AI dan semua model. Setiap tugas kerja yang selesai otomatis menjadi catatan (ringkasan hasil, siapa yang mengerjakan, model apa). Balasan cepat obrolan tidak disimpan. Sebelum bekerja, AI menerima catatan paling relevan dari lingkup yang sama, jadi tidak mengulang dari nol dan bisa melanjutkan hasil model lain. Catatan bisnis A tidak pernah diberikan ke bisnis B. Sematkan fakta penting agar selalu dipakai, dan koreksi atau hapus catatan yang keliru.'),
      h('div', { class: 'brain-filters' }, search, scope, kind)),
    list,
    more));
  await load();
}
