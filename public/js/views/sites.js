// Websites and code the Developer keeps on GitHub: private preview, where each site is published, and publishing by
// the owner (the owner is the approver here). The AI asks for publishing through Approvals instead.
import { get, post } from '../api.js';
import { h, mount, select, toast, errToast, emptyState, fmtDate, taskCode, confirmDialog } from '../ui.js';

const DEPLOY = { ready: ['Online', 'b-completed'], building: ['Sedang terbit', 'b-processing'], queued: ['Antre', 'b-pending'], error: ['Gagal', 'b-failed'] };
const ext = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
const short = (sha) => (sha ? String(sha).slice(0, 7) : '-');

export async function render(root, _params, ctx) {
  const [businesses, conn] = await Promise.all([get('/api/businesses'), get('/api/connections')]);
  const github = conn.tokens.find((t) => t.provider === 'github');
  const scope = select([['', 'Semua bisnis'], ['hq', 'Holding (pusat)'], ...businesses.map((b) => [String(b.id), b.name])], '', { 'aria-label': 'Bisnis' });
  const body = h('div', { class: 'stack' });
  let last = null;
  let startedAt = 0; // a publish the owner just started: keep refreshing until it shows up

  const publish = (s, hostSel) => async (ev) => {
    const host = hostSel.value;
    const label = last.hosts.find((x) => x.id === host)?.label || host;
    const extra = host === 'github_pages' ? ' Repo GitHub-nya akan dijadikan publik (syarat GitHub Pages gratis).' : '';
    if (!(await confirmDialog(`Terbitkan "${s.title}" (commit ${short(s.head)}) ke ${label}? Website bisa dibuka siapa saja.${extra}`, { okLabel: 'Terbitkan' }))) return;
    ev.target.disabled = true;
    try {
      await post(`/api/sites/${s.id}/publish`, { host });
      startedAt = Date.now();
      toast(`Menerbitkan ke ${label}…`, 'ok');
    } catch (e) {
      errToast(e);
    } finally {
      draw();
    }
  };

  const deployRow = (d) => {
    const [label, cls] = DEPLOY[d.status] || [d.status, ''];
    return h('tr', null,
      h('td', null, d.label),
      h('td', null, h('span', { class: `badge ${cls}` }, label)),
      h('td', null, d.url ? ext(d.url, `${d.url.replace(/^https?:\/\//, '')} ↗`) : '-',
        d.error ? h('div', { class: `small ${d.status === 'error' ? 'form-error' : 'muted'}` }, d.error) : null),
      h('td', { class: 'mono small' }, short(d.commit)),
      h('td', { class: 'small muted nowrap' }, fmtDate(d.deployed_at || d.updated_at)));
  };

  const card = (s) => {
    const hosts = last.hosts.filter((x) => x.connected);
    const hostSel = select(hosts.map((x) => [x.id, x.label]), hosts.some((x) => x.id === last.default_host) ? last.default_host : hosts[0]?.id || '', { 'aria-label': 'Layanan', style: { width: 'auto' } });
    const busy = s.deployments.some((d) => d.status === 'building' || d.status === 'queued');
    return h('div', { class: 'card stack-sm' },
      h('div', { class: 'row-between' },
        h('div', null,
          h('h3', { style: { margin: 0 } }, s.title, ' ', h('span', { class: 'cat-chip' }, s.kind === 'site' ? 'Website' : 'Kode')),
          h('div', { class: 'small muted' }, `${s.business_name || 'Holding'} · ${s.employee_name || '-'} · `,
            s.task_id ? h('a', { href: `#/task/${s.task_id}` }, taskCode(s.task_id)) : 'tanpa tugas',
            ` · diperbarui ${fmtDate(s.updated_at)}`)),
        h('div', { class: 'row' },
          s.kind === 'site' && s.preview_url ? h('a', { class: 'btn btn-sm', href: s.preview_url, target: '_blank', rel: 'noopener noreferrer' }, 'Pratinjau ↗') : null,
          h('a', { class: 'btn btn-sm', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub ↗'))),
      h('div', { class: 'small muted' }, 'Repo ', h('span', { class: 'mono' }, s.full_name || '-'), ' · branch ', h('span', { class: 'mono' }, s.branch || 'main'), ' · commit terakhir ', h('span', { class: 'mono' }, short(s.head))),
      s.deployments.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['Layanan', 'Status', 'Alamat', 'Commit', 'Waktu'].map((t) => h('th', null, t)))),
            h('tbody', null, s.deployments.map(deployRow))))
        : h('div', { class: 'small muted' }, s.kind === 'site' ? 'Belum diterbitkan.' : 'Repo kode (bukan website).'),
      s.kind === 'site'
        ? hosts.length
          ? h('div', { class: 'row' }, hostSel, h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: busy, onclick: publish(s, hostSel) }, busy ? 'Sedang terbit…' : 'Terbitkan'))
          : h('div', { class: 'small muted' }, 'Belum ada layanan hosting yang terhubung. ', h('a', { href: '#/connections' }, 'Hubungkan Vercel, Netlify, Cloudflare, atau GitHub Pages →'))
        : null);
  };

  async function draw() {
    const d = await get('/api/sites');
    last = d;
    const items = d.items.filter((s) => !scope.value || (scope.value === 'hq' ? !s.business_id : String(s.business_id) === scope.value));
    mount(body, items.length
      ? items.map(card)
      : emptyState(github?.status === 'connected'
        ? 'Belum ada website. Minta Developer, misalnya: "Buatkan website profil untuk bisnis kita lalu terbitkan."'
        : 'Belum ada website. Hubungkan GitHub di halaman Koneksi, lalu minta Developer membuat website.',
        github?.status === 'connected' ? null : h('a', { class: 'btn btn-primary', href: '#/connections' }, 'Buka Koneksi')));
    return d;
  }

  const active = () => Date.now() - startedAt < 15_000 || last?.items.some((s) => s.deployments.some((x) => x.status === 'building' || x.status === 'queued'));
  ctx.poll(() => (active() ? draw() : null), 3000);
  scope.addEventListener('change', draw);
  mount(root, h('div', { class: 'stack' },
    h('div', { class: 'row-between' },
      h('p', { class: 'muted', style: { margin: 0 } },
        'Website dan kode buatan Developer disimpan di GitHub (repo privat). Pratinjau hanya bisa dibuka lewat tautan rahasianya. ',
        'Terbit dari sini langsung berjalan; permintaan terbit dari karyawan AI menunggu persetujuan Anda di Approvals.'),
      h('div', { class: 'approvals-filters' }, scope)),
    body));
  await draw();
}
