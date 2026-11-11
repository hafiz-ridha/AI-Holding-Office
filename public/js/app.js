// SPA shell: auth, hash router, navigation, shared "new task" dialog, visibility-aware polling.
import { api, get, post, setCsrf, setUnauthorizedHandler } from './api.js';
import { h, $, mount, toast, errToast, modal, field, select } from './ui.js';

const ROUTES = [
  { group: 'Holding' },
  { path: 'overview', label: 'Holding Overview', icon: '◧', load: () => import('./views/overview.js') },
  { path: 'office', label: 'AI Virtual Office', icon: '▦', load: () => import('./views/office.js') },
  { path: 'businesses', label: 'Business Directory', icon: '▤', load: () => import('./views/businesses.js') },
  { path: 'business', hidden: true, label: 'Business Detail', load: () => import('./views/business.js') },
  { path: 'organization', label: 'Organization', icon: '⌬', load: () => import('./views/organization.js') },
  { path: 'shared', label: 'Shared Services', icon: '◎', load: () => import('./views/shared.js') },
  { path: 'reports', label: 'Consolidated Reports', icon: '▥', load: () => import('./views/reports.js') },
  { path: 'brain', label: 'Second Brain', icon: '✦', load: () => import('./views/brain.js') },
  { path: 'approvals', label: 'Approvals', icon: '✓', badge: 'approvals', load: () => import('./views/approvals.js') },
  { group: 'Operasional' },
  { path: 'tasks', label: 'Task Manager', icon: '☰', load: () => import('./views/tasks.js') },
  { path: 'task', hidden: true, label: 'Detail Tugas', load: () => import('./views/task.js') },
  { path: 'employees', label: 'AI Employees', icon: '☺', load: () => import('./views/employees.js') },
  { path: 'files', label: 'File', icon: '🗀', load: () => import('./views/files.js') },
  { path: 'sites', label: 'Website', icon: '◰', load: () => import('./views/sites.js') },
  { group: 'Konfigurasi' },
  { path: 'providers', label: 'AI Providers', icon: '⚡', load: () => import('./views/providers.js') },
  { path: 'telegram', label: 'Telegram', icon: '✈', load: () => import('./views/telegram.js') },
  { path: 'connections', label: 'Koneksi', icon: '⇄', load: () => import('./views/connections.js') },
  { path: 'settings', label: 'Settings', icon: '⚙', load: () => import('./views/settings.js') },
];

const state = { user: null, cleanup: [], badges: {}, cache: {} };

// ---------- polling bound to the current view, paused while the tab is hidden ----------
function makeCtx() {
  const timers = [];
  const ctx = {
    poll(fn, ms) {
      let t = null;
      let stopped = false;
      const run = async () => {
        if (!document.hidden) {
          try {
            await fn();
          } catch {}
        }
        if (!stopped) t = setTimeout(run, ms);
      };
      t = setTimeout(run, ms);
      timers.push(() => {
        stopped = true;
        clearTimeout(t);
      });
    },
    onCleanup(fn) {
      timers.push(fn);
    },
    navigate,
    refreshBadges,
    openNewTask,
    cache: state.cache,
  };
  state.cleanup.push(() => timers.forEach((f) => f()));
  return ctx;
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function renderNav(active) {
  const nav = $('#nav');
  mount(
    nav,
    ROUTES.filter((r) => !r.hidden).map((r) =>
      r.group
        ? h('div', { class: 'nav-group' }, r.group)
        : h(
            'a',
            { class: `nav-link ${active === r.path || (active === 'business' && r.path === 'businesses') || (active === 'task' && r.path === 'tasks') ? 'active' : ''}`, href: `#/${r.path}` },
            h('span', { class: 'nav-ico', 'aria-hidden': 'true' }, r.icon),
            r.label,
            r.badge && state.badges[r.badge] ? h('span', { class: 'count' }, state.badges[r.badge]) : null
          )
    )
  );
}

async function refreshBadges() {
  try {
    const o = await get('/api/overview');
    state.badges.approvals = o.approvals_pending;
    const pill = $('#queue-pill');
    mount(pill, h('span', { class: 'dot', style: { background: o.queue.paused ? 'var(--warn)' : o.queue.running.length ? 'var(--info)' : 'var(--ok)' } }),
      o.queue.paused ? 'Antrean dijeda' : o.queue.running.length ? `${o.queue.running.length} tugas berjalan` : 'Antrean siap');
    renderNav(currentPath());
    return o;
  } catch {
    return null;
  }
}

const currentPath = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'overview');

async function route() {
  if (!state.user) return;
  state.cleanup.forEach((f) => f());
  state.cleanup = [];
  const [path, ...params] = location.hash.replace(/^#\/?/, '').split('/');
  const r = ROUTES.find((x) => x.path === (path || 'overview')) || ROUTES[1];
  renderNav(r.path);
  $('#page-title').textContent = r.label;
  document.title = `${r.label} · AI Virtual Holding`;
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
  const view = $('#view');
  mount(view, h('p', { class: 'muted' }, 'Memuat…'));
  try {
    const mod = await r.load();
    const ctx = makeCtx();
    const out = await mod.render(view, params.map(decodeURIComponent), ctx);
    if (typeof out === 'function') state.cleanup.push(out);
    if (out?.title) $('#page-title').textContent = out.title;
  } catch (e) {
    mount(view, h('div', { class: 'card' }, h('h2', null, 'Gagal memuat halaman'), h('p', { class: 'muted' }, e.message)));
  }
  view.focus({ preventScroll: true });
}

// ---------- shared: create task dialog ----------
export async function openNewTask(preset = {}) {
  const [businesses, employees] = await Promise.all([get('/api/businesses'), get('/api/employees')]);
  const active = businesses.filter((b) => b.status === 'active');
  const mode = select(
    [
      ['holding', 'Holding task → Group CEO membagi ke bisnis/Shared Services'],
      ['business', 'Business task → langsung ke Business Manager (lebih hemat)'],
      ['direct', 'Tugas langsung ke satu karyawan'],
    ],
    preset.mode || (preset.business_id ? 'business' : 'holding')
  );
  const biz = select([['', '— Semua / holding —'], ...active.map((b) => [b.id, b.name])], preset.business_id || '');
  const emp = select(
    [['', '— pilih karyawan —'], ...employees.filter((e) => e.enabled).map((e) => [e.id, `${e.name} — ${e.role}`])],
    preset.employee_id || ''
  );
  const title = h('input', { maxlength: 200, required: true, placeholder: 'Contoh: Evaluasi seluruh bisnis bulan ini' });
  const desc = h('textarea', { rows: 6, maxlength: 20000, placeholder: 'Detail instruksi, target, batasan, format hasil yang diinginkan…' });
  const prio = select([['low', 'Rendah'], ['normal', 'Normal'], ['high', 'Tinggi'], ['urgent', 'Mendesak']], 'normal');
  const bizField = field('Bisnis', biz, 'Wajib untuk business task. Opsional untuk holding/langsung (menentukan konteks data).');
  const empField = field('Karyawan', emp);
  const hint = h('p', { class: 'small muted' });
  const sync = () => {
    empField.hidden = mode.value !== 'direct';
    hint.textContent =
      mode.value === 'holding'
        ? 'Perkiraan panggilan AI: 1 (rencana CEO) + per bisnis (rencana + subtugas + laporan) + 1 (laporan holding). CEO dapat menjawab langsung bila sederhana.'
        : mode.value === 'business'
          ? 'Perkiraan panggilan AI: 1–4 (rencana Business Manager, subtugas, laporan bisnis).'
          : 'Perkiraan panggilan AI: 1.';
  };
  mode.addEventListener('change', sync);
  sync();
  modal({
    title: 'Tugas baru',
    body: h('div', { class: 'stack' }, field('Jenis tugas', mode), bizField, empField, field('Judul', title), field('Instruksi', desc), field('Prioritas', prio), hint),
    actions: [
      { label: 'Batal' },
      {
        label: 'Buat tugas',
        kind: 'primary',
        onClick: async () => {
          if (title.value.trim().length < 3) {
            toast('Judul minimal 3 karakter', 'error');
            return false;
          }
          const t = await post('/api/tasks', {
            mode: mode.value,
            title: title.value.trim(),
            description: desc.value,
            priority: prio.value,
            business_id: biz.value ? Number(biz.value) : null,
            employee_id: mode.value === 'direct' && emp.value ? Number(emp.value) : null,
          });
          toast(`Tugas ${t.code} dibuat`, 'ok');
          navigate(`#/task/${t.id}`);
        },
      },
    ],
  });
}

// ---------- auth ----------
function showLogin() {
  state.user = null;
  $('#app').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form [name=username]').focus();
}

async function boot() {
  applyTheme(localStorage.getItem('avo-theme'));
  setUnauthorizedHandler(showLogin);
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#login-error').textContent = '';
    try {
      const r = await post('/api/auth/login', { username: f.username.value, password: f.password.value });
      f.password.value = '';
      start(r);
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });
  $('#logout-btn').addEventListener('click', async () => {
    try {
      await post('/api/auth/logout');
    } catch {}
    showLogin();
  });
  $('#menu-btn').addEventListener('click', () => {
    $('#sidebar').classList.add('open');
    $('#scrim').hidden = false;
  });
  $('#scrim').addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    $('#scrim').hidden = true;
  });
  $('#new-task-btn').addEventListener('click', () => openNewTask().catch(errToast));
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem('avo-theme', next);
    } catch {}
  });
  window.addEventListener('hashchange', route);
  try {
    start(await api('/api/auth/me'));
  } catch {
    showLogin();
  }
}

function applyTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function start({ user, csrfToken }) {
  state.user = user;
  setCsrf(csrfToken);
  $('#login-view').hidden = true;
  $('#app').hidden = false;
  $('#user-name').textContent = `Masuk sebagai ${user.username}`;
  if (!location.hash) location.hash = '#/overview';
  route();
  refreshBadges();
  setInterval(() => !document.hidden && refreshBadges(), 15000);
}

boot();
