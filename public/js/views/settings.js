import { get, post, put } from '../api.js';
import { h, mount, field, toast, errToast, fmtDate, emptyState } from '../ui.js';

const GROUPS = [
  ['Antrean & concurrency', ['max_concurrency', 'queue_paused', 'max_task_attempts', 'retry_delay_minutes']],
  ['Batas AI', ['max_daily_requests', 'max_tokens_per_task', 'max_output_tokens', 'max_model_attempts', 'memory_items']],
  ['Second Brain', ['knowledge_enabled', 'knowledge_items']],
  ['Riset web & persetujuan', ['web_research_enabled', 'web_research_pages', 'approval_important_only']],
  ['Agen & alat', ['agent_enabled', 'agent_max_steps', 'agent_max_tokens', 'drive_auto_save', 'drive_auto_save_min_chars']],
  ['Website & kode (Developer)', ['site_default_host', 'agent_code_max_steps', 'agent_code_max_tokens', 'agent_code_max_output_tokens']],
  ['Orkestrasi holding', ['group_ceo_cross_business', 'max_business_tasks', 'max_shared_tasks', 'bm_max_subtasks', 'max_subtasks']],
  ['Waktu & backup', ['timezone', 'backup_enabled', 'backup_time', 'backup_retention', 'log_retention_days']],
  ['Keamanan', ['session_ttl_hours']],
];

// Settings with a fixed set of values: shown as a choice list.
const CHOICES = {
  site_default_host: [['vercel', 'Vercel'], ['netlify', 'Netlify'], ['cloudflare', 'Cloudflare Pages'], ['github_pages', 'GitHub Pages']],
};

export async function render(root) {
  const draw = async () => {
    const [s, backups, audit] = await Promise.all([get('/api/settings'), get('/api/backups'), get('/api/audit')]);
    const inputs = {};
    const input = (k) => {
      const v = s.values[k];
      let el;
      if (typeof v === 'boolean') el = h('input', { type: 'checkbox', checked: v });
      else if (typeof v === 'number') el = h('input', { type: 'number', value: v });
      else if (CHOICES[k]) el = h('select', null, CHOICES[k].map(([val, label]) => h('option', { value: val, selected: v === val }, label)));
      else if (/_time$/.test(k)) el = h('input', { type: 'time', value: v });
      else el = h('input', { value: v ?? '' });
      inputs[k] = el;
      return typeof v === 'boolean' ? h('label', { class: 'check' }, el, s.labels[k]) : field(s.labels[k], el);
    };
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10 });
    mount(root, h('div', { class: 'stack' },
      h('div', { class: 'grid grid-2' }, GROUPS.map(([title, keys]) => h('div', { class: 'card stack' }, h('h3', null, title), keys.map(input)))),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        const body = {};
        for (const [k, el] of Object.entries(inputs)) {
          const old = s.values[k];
          const v = el.type === 'checkbox' ? el.checked : typeof old === 'number' ? Number(el.value) : el.value;
          if (v !== old) body[k] = v;
        }
        if (!Object.keys(body).length) return toast('Tidak ada perubahan');
        await put('/api/settings', body).then(() => toast('Pengaturan disimpan', 'ok')).catch(errToast);
        draw();
      } }, 'Simpan pengaturan'), h('span', { class: 'small muted' }, 'Concurrency default 1 menghemat RAM dan kuota API. Naikkan hanya bila VPS dan kuota provider memadai.')),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'card stack' },
          h('div', { class: 'row-between' }, h('h3', null, 'Backup database'), h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: async () => {
            const b = await post('/api/backups').catch(errToast);
            if (b) toast(`Backup ${b.name} dibuat`, 'ok');
            draw();
          } }, 'Backup sekarang')),
          backups.length
            ? h('div', { class: 'list' }, backups.slice(0, 15).map((b) => h('div', { class: 'list-item' }, h('div', { class: 'grow mono small' }, b.name), h('span', { class: 'small muted' }, `${Math.ceil(b.size / 1024)} KB`), h('a', { class: 'btn btn-sm', href: `/api/backups/${encodeURIComponent(b.name)}`, download: b.name }, 'Unduh'))))
            : emptyState('Belum ada backup.'),
          h('p', { class: 'small muted' }, 'Restore: hentikan container, salin file backup menjadi data/office.db, jalankan kembali. Lihat README.')),
        h('div', { class: 'card stack' },
          h('h3', null, 'Ganti password admin'),
          field('Password saat ini', current), field('Password baru (min. 10 karakter)', next),
          h('div', null, h('button', { class: 'btn', type: 'button', onclick: async () => {
            await post('/api/auth/password', { current: current.value, next: next.value }).then(() => toast('Password diganti. Sesi lain dikeluarkan.', 'ok')).catch(errToast);
            current.value = '';
            next.value = '';
          } }, 'Ganti password')))),
      h('div', { class: 'card card-flush' },
        h('div', { style: { padding: '12px 16px' } }, h('h3', null, 'Audit log')),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Waktu'), h('th', null, 'Aktor'), h('th', null, 'Aksi'), h('th', null, 'Target'), h('th', null, 'Bisnis'), h('th', null, 'IP'))),
          h('tbody', null, audit.items.map((a) => h('tr', null, h('td', { class: 'small nowrap' }, fmtDate(a.created_at)), h('td', { class: 'small' }, a.actor), h('td', { class: 'small' }, a.action), h('td', { class: 'small mono' }, a.target || ''), h('td', { class: 'small' }, a.business_name || ''), h('td', { class: 'small mono' }, a.ip || '')))))))));
  };
  await draw();
}
