// Room panels for the virtual office: every room opens a panel matching its function. All numbers come from
// existing API endpoints (no new backend); anything the backend does not record is simply not shown.
import { get } from '../api.js';
import { h, badge, fmtRel, fmtDate, fmtNum, fmtMoney, taskCode, KIND_LABEL, ORG_LABEL, emptyState } from '../ui.js';
import { avatarCanvas } from '../office/sprites.js';

const ACTIVE = new Set(['working', 'thinking', 'meeting']);

const safe = (p) => get(p).catch(() => null);
const section = (title, ...body) => h('section', { class: 'room-sec' }, h('h4', null, title), ...body);
const note = (text) => h('p', { class: 'small muted', style: { margin: 0 } }, text);
const link = (href, text) => h('a', { class: 'small', href }, text);

function taskList(items, empty = 'Tidak ada tugas.') {
  if (!items?.length) return note(empty);
  return h('div', { class: 'list' }, items.map((t) => h('div', { class: 'list-item' },
    h('div', { class: 'grow small' }, h('a', { href: `#/task/${t.id}` }, `${taskCode(t.id)} ${t.title}`),
      h('div', { class: 'muted' }, [KIND_LABEL[t.kind], t.employee_name, t.business_name, fmtRel(t.updated_at || t.created_at)].filter(Boolean).join(' · '))),
    badge(t.status))));
}

// Several employees' tasks merged (one request per employee, max 4), newest first.
async function tasksOf(ids, extra = '', limit = 6) {
  const lists = await Promise.all(ids.slice(0, 4).map((id) => safe(`/api/tasks?employee_id=${id}&limit=${limit}${extra}`)));
  return lists.flatMap((r) => r?.items || []).sort((a, b) => b.id - a.id).slice(0, limit);
}

function personRow(e, env) {
  const st = env.shownState(e);
  return h('button', { class: 'office-biz-link', type: 'button', onclick: () => env.selectEmployee(e.id) },
    avatarCanvas(e.avatar, 1), h('span', { class: 'grow' }, e.name, h('span', { class: 'small muted' }, ` · ${String(e.role).split(' — ')[0]}`),
      e.task && ACTIVE.has(e.state) ? h('div', { class: 'small muted' }, `${taskCode(e.task.id)} ${e.task.title}`) : null),
    env.stateBadge(st));
}

function bizStats(b) {
  const s = b.stats || { total: b.total_tasks, completed: b.completed_tasks, active: b.active_tasks, failed: b.failed_tasks };
  const total = Math.max(1, s.total || 0);
  return h('div', { class: 'stack-xs' },
    h('div', { class: 'bar', title: `${s.completed || 0} selesai, ${s.active || 0} aktif, ${s.failed || 0} gagal dari ${s.total || 0}` },
      h('span', { style: { width: `${((s.completed || 0) / total) * 100}%`, background: 'var(--ok)' } }),
      h('span', { style: { width: `${((s.active || 0) / total) * 100}%`, background: 'var(--info)' } }),
      h('span', { style: { width: `${((s.failed || 0) / total) * 100}%`, background: 'var(--err)' } })),
    h('div', { class: 'small muted' }, `${s.total || 0} tugas · ${s.completed || 0} selesai · ${s.active || 0} aktif${s.failed ? ` · ${s.failed} gagal` : ''}`));
}

function kpis(items) {
  return h('div', { class: 'room-kpis' }, items.map(([label, value, sub]) => h('div', { class: 'room-kpi' }, h('b', null, value), h('span', null, label), sub ? h('small', null, sub) : null)));
}

const ROOM_INFO = {
  ceo: 'Ruang Group CEO: ringkasan holding, kinerja bisnis, tugas aktif, dan approval.',
  meeting: 'Ruang rapat: koordinasi antar-karyawan dari data tugas.',
  bm: 'Business Managers: daftar bisnis, status manager, dan kinerja tiap bisnis.',
  finance: 'Group Finance: ringkasan keuangan bulan ini per bisnis dan tugas keuangan.',
  reception: 'Secretary & Reception: dokumen, jadwal laporan, dan tindak lanjut yang menunggu.',
  research: 'Research Library: laporan, basis pengetahuan (dokumen), dan riset kompetitor.',
  dev: 'Developer Lab: tugas pengembangan, pemantauan sistem, status server, dan laporan error.',
  hr: 'HR: daftar karyawan, kinerja, rekrutmen, dan beban kerja.',
  marketing: 'Marketing Hub: kampanye dan tugas marketing.',
  shared: 'Shared Services: aktivitas departemen bersama dan tugas lintas bisnis.',
  lounge: 'Lounge dengan coffee corner dan game corner: siapa yang sedang istirahat, office boy, dan info kantor.',
  manager: 'Ruang manager bisnis.',
  workspace: 'Area kerja tim bisnis.',
  guests: 'Hot desk untuk tim pusat yang sedang bekerja untuk bisnis ini.',
  open: 'Open Space: seluruh tim pusat (keuangan, sekretariat, riset, developer, HR, marketing) bekerja bersama.',
  pool: 'Kolam renang kantor: tempat karyawan tanpa tugas bersantai.',
};

// Functions of the central team (they all sit in the Open Space; the panel groups them by role).
const FUNCTIONS = [
  ['finance', 'Keuangan', ['group_finance', 'finance']],
  ['reception', 'Sekretariat', ['secretary']],
  ['research', 'Riset', ['researcher']],
  ['dev', 'Developer', ['developer']],
  ['hr', 'HR', ['hr']],
  ['marketing', 'Marketing', ['marketing']],
];
const BREAK = { chat: 'ngobrol', game: 'main game', coffee: 'ngopi', sofa: 'bersantai di sofa', arcade: 'main arcade', swim: 'berenang' };

// env: { data, scene, business, room, shownState, stateBadge, selectEmployee, switchTo, ctx, overview, meetingPanel, businessSummary }
export async function roomPanel(env) {
  const { room, data } = env;
  const head = h('div', { class: 'room-head', style: { '--c': room.tint || '#6b5444' } }, h('h3', null, room.name), note(ROOM_INFO[room.key] || ''));
  const body = await (BUILDERS[room.key] || (async () => [note('Belum ada panel untuk ruangan ini.')]))(env, data);
  return h('div', { class: 'stack-sm room-panel' }, head, body);
}

// Employees of one function present in this office (by role; rooms no longer split the central team).
const inRoom = (env, key) => {
  const roles = FUNCTIONS.find((f) => f[0] === key)?.[2];
  const ids = new Set();
  for (const c of env.chars.values()) if (roles ? roles.includes(c.e?.role_key) : c.desk?.room?.key === key) ids.add(c.id);
  return env.data.employees.filter((e) => ids.has(e.id));
};

// People on a break right now (visual only) and the office boys' current jobs.
function breakList(env, filter = () => true) {
  const on = [...env.chars.values()].filter((c) => c.e && c.outing && filter(c));
  return on.length
    ? h('div', { class: 'stack-xs' }, on.map((c) => h('button', { class: 'office-biz-link', type: 'button', onclick: () => env.selectEmployee(c.id) },
        avatarCanvas(c.e.avatar, 1), h('span', { class: 'grow' }, c.e.name, h('span', { class: 'small muted' }, ` · ${BREAK[c.outing.kind] || 'istirahat'}`)), env.stateBadge(env.shownState(c.e)))))
    : note('Tidak ada yang sedang istirahat di sini.');
}
function obList(env) {
  const list = [...(env.npcs?.values() || [])];
  return list.length
    ? h('div', { class: 'stack-xs' }, list.map((n) => h('div', { class: 'office-biz-link' }, avatarCanvas(n.avatar, 1), h('span', { class: 'grow' }, `OB ${n.name}`, h('div', { class: 'small muted' }, n.note)))))
    : note('Tidak ada office boy di kantor ini.');
}

const BUILDERS = {
  async ceo(env, data) {
    const [ov, active, approvals, businesses] = await Promise.all([env.overview(), safe('/api/tasks?status=active&kind=top&limit=6'), safe('/api/approvals?status=pending'), safe('/api/businesses')]);
    const hld = ov?.holding;
    return [
      section('Ringkasan grup', hld ? kpis([
        ['Bisnis aktif', fmtNum(hld.businesses_active)],
        ['Karyawan aktif', fmtNum(hld.employees_enabled)],
        ['Tugas hari ini', fmtNum(hld.tasks_today.total), `${fmtNum(hld.tasks_today.completed)} selesai`],
        ['Gagal hari ini', fmtNum(hld.tasks_today.failed)],
      ]) : note('Ringkasan tidak tersedia.'), link('#/overview', 'Buka Holding Overview →')),
      section('Kinerja bisnis', (businesses || []).filter((b) => b.status === 'active').map((b) => h('div', { class: 'stack-xs' },
        h('button', { class: 'office-biz-link', type: 'button', onclick: () => env.switchTo(`biz-${b.id}`) }, h('span', { class: 'dot', style: { background: b.color } }), h('span', { class: 'grow' }, b.name), h('span', { class: 'small muted' }, 'Kantor →')),
        bizStats(b)))),
      section('Tugas aktif', taskList(active?.items, 'Tidak ada tugas aktif.'), link('#/tasks', 'Task Manager →')),
      section('Approval menunggu', approvals?.length ? h('div', { class: 'list' }, approvals.slice(0, 5).map((a) => h('div', { class: 'list-item small' }, h('div', { class: 'grow' }, a.title || a.detail || `Approval #${a.id}`, h('div', { class: 'muted' }, fmtRel(a.created_at))), badge('pending')))) : note('Tidak ada approval yang menunggu.'), link('#/approvals', 'Buka Approvals →')),
    ];
  },

  async meeting(env) {
    const bid = env.business?.id;
    const c = await safe(`/api/office/coordination${bid ? `?business_id=${bid}` : ''}`);
    return c ? env.meetingPanel(c) : note('Data rapat tidak tersedia.');
  },

  async bm(env, data) {
    const businesses = (await safe('/api/businesses')) || [];
    const byId = new Map(data.employees.map((e) => [e.id, e]));
    return [section('Bisnis & manager', businesses.filter((b) => b.status === 'active').map((b) => {
      const m = byId.get(b.manager_employee_id);
      return h('div', { class: 'room-card' },
        h('div', { class: 'row' }, h('span', { class: 'dot', style: { background: b.color } }), h('b', { class: 'grow' }, b.name), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => env.switchTo(`biz-${b.id}`) }, 'Kantor →')),
        m ? h('div', { class: 'row small' }, h('span', { class: 'grow' }, `Manager: ${m.name}`), env.stateBadge(env.shownState(m))) : note('Belum ada manager.'),
        bizStats(b),
        b.latest_report ? h('div', { class: 'small muted' }, 'Laporan terakhir: ', h('a', { href: `#/reports` }, b.latest_report.title), ` · ${fmtRel(b.latest_report.created_at)}`) : null);
    }))];
  },

  async finance(env, data) {
    const biz = data.businesses.filter((b) => b.status === 'active');
    const fins = await Promise.all(biz.map((b) => safe(`/api/businesses/${b.id}/finance`)));
    const staff = inRoom(env, 'finance');
    const tasks = await tasksOf(staff.map((e) => e.id));
    const rows = biz.map((b, i) => {
      const s = fins[i]?.summary;
      return h('div', { class: 'room-card' },
        h('div', { class: 'row' }, h('span', { class: 'dot', style: { background: b.color } }), h('b', { class: 'grow' }, b.name), link(`#/business/${b.id}/finance`, 'Detail →')),
        s ? s.currencies.map((c) => h('dl', { class: 'kv small' },
          h('dt', null, 'Pendapatan'), h('dd', null, fmtMoney(c.income, c.currency)),
          h('dt', null, 'Pengeluaran'), h('dd', null, fmtMoney(c.expense, c.currency)),
          h('dt', null, 'Arus kas bersih'), h('dd', { style: { color: c.net < 0 ? 'var(--err)' : 'var(--ok)' } }, fmtMoney(c.net, c.currency))))
          : note('Belum ada catatan keuangan bulan ini.'));
    });
    const period = fins.find((f) => f)?.from ? `${fins.find((f) => f).from} s.d. ${fins.find((f) => f).to}` : 'bulan ini';
    return [section(`Ringkasan keuangan (${period})`, rows), section('Tugas keuangan', staff.length ? null : note('Belum ada staf Group Finance.'), taskList(tasks))];
  },

  async reception(env, data) {
    const biz = data.businesses.filter((b) => b.status === 'active');
    const [docs, tg, approvals, pending] = await Promise.all([
      Promise.all(biz.map((b) => safe(`/api/businesses/${b.id}/documents`))),
      safe('/api/telegram'), safe('/api/approvals?status=pending'), safe('/api/tasks?status=pending&limit=6'),
    ]);
    const allDocs = biz.flatMap((b, i) => (docs[i] || []).map((d) => ({ ...d, business: b }))).sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at));
    const s = tg?.settings;
    return [
      section('Dokumen terbaru', allDocs.length ? h('div', { class: 'list' }, allDocs.slice(0, 6).map((d) => h('div', { class: 'list-item small' }, h('div', { class: 'grow' }, h('a', { href: `#/business/${d.business.id}/knowledge` }, d.title || d.name || `Dokumen #${d.id}`), h('div', { class: 'muted' }, `${d.business.name} · ${fmtRel(d.updated_at || d.created_at)}`))))) : note('Belum ada dokumen.')),
      section('Jadwal', s ? h('dl', { class: 'kv small' },
        h('dt', null, 'Laporan harian'), h('dd', null, s.report_enabled ? `Telegram pukul ${s.report_time} (${s.timezone})` : 'Nonaktif'),
        h('dt', null, 'Laporan hari ini'), h('dd', null, tg.today_report ? `${tg.today_report.status}${tg.today_report.sent_at ? ` · ${fmtDate(tg.today_report.sent_at)}` : ''}` : 'Belum dikirim')) : note('Jadwal tidak tersedia.'), link('#/telegram', 'Pengaturan Telegram →')),
      section('Tindak lanjut menunggu', approvals?.length ? note(`${approvals.length} approval menunggu keputusan owner.`) : note('Tidak ada approval menunggu.'), taskList(pending?.items, 'Tidak ada tugas dalam antrean.')),
    ];
  },

  async research(env, data) {
    const staff = inRoom(env, 'research');
    const biz = data.businesses.filter((b) => b.status === 'active');
    const [reports, tasks, comp, docs] = await Promise.all([
      safe('/api/reports'), tasksOf(staff.map((e) => e.id)), safe('/api/tasks?q=kompetitor&limit=5'),
      Promise.all(biz.map((b) => safe(`/api/businesses/${b.id}/documents`))),
    ]);
    return [
      section('Laporan riset & bisnis', reports?.length ? h('div', { class: 'list' }, reports.slice(0, 5).map((r) => h('div', { class: 'list-item small' }, h('div', { class: 'grow' }, h('a', { href: `#/task/${r.task_id}` }, r.title), h('div', { class: 'muted' }, `${r.business_name || 'Holding'} · ${r.employee_name || '-'} · ${fmtRel(r.created_at)}`))))) : note('Belum ada laporan.'), link('#/reports', 'Consolidated Reports →')),
      section('Tugas riset', taskList(tasks, 'Belum ada tugas riset.')),
      section('Basis pengetahuan', h('div', { class: 'list' }, biz.map((b, i) => h('div', { class: 'list-item small' }, h('span', { class: 'dot', style: { background: b.color } }), h('span', { class: 'grow' }, b.name), h('span', { class: 'muted' }, `${(docs[i] || []).length} dokumen`))))),
      section('Analisis kompetitor', taskList(comp?.items, 'Belum ada tugas berkata kunci "kompetitor".')),
    ];
  },

  async dev(env, data) {
    const staff = inRoom(env, 'dev');
    const [ov, health, usage, failed, tasks] = await Promise.all([env.overview(), safe('/api/health'), safe('/api/usage'), safe('/api/tasks?status=failed&limit=5'), tasksOf(staff.map((e) => e.id))]);
    const sys = ov?.system;
    return [
      section('Tugas pengembangan', taskList(tasks, 'Belum ada tugas pengembangan.')),
      section('Pemantauan sistem', sys ? kpis([
        ['RAM (RSS)', `${sys.rss_mb} MB`], ['Heap', `${sys.heap_mb} MB`], ['Uptime', fmtUptime(sys.uptime_sec)], ['Node', sys.node],
      ]) : note('Data sistem tidak tersedia.'),
      ov ? h('div', { class: 'small' }, `Antrean: ${ov.queue.paused ? 'dijeda' : 'berjalan'} · ${ov.queue.running.length}/${ov.queue.concurrency} berjalan`) : null),
      section('Status server', h('dl', { class: 'kv small' },
        h('dt', null, 'API'), h('dd', null, health ? `${health.status} · v${health.version}` : 'tidak terjangkau'),
        h('dt', null, 'Provider AI'), h('dd', null, ov?.providers?.length ? ov.providers.map((p) => `${p.name}: ${p.enabled ? p.status : 'nonaktif'}`).join(', ') : 'belum ada'),
        h('dt', null, 'Telegram'), h('dd', null, ov?.telegram ? `${ov.telegram.status}${ov.telegram.message ? ` · ${ov.telegram.message}` : ''}` : '-')), link('#/providers', 'AI Providers →')),
      section('Laporan error', usage?.recent_errors?.length ? h('div', { class: 'list' }, usage.recent_errors.slice(0, 4).map((e) => h('div', { class: 'list-item small' }, h('div', { class: 'grow' }, `${e.provider_name} / ${e.model}`, h('div', { class: 'muted' }, String(e.error || e.http_status || '').slice(0, 120))), h('span', { class: 'muted nowrap' }, fmtRel(e.created_at))))) : note('Tidak ada error AI terbaru.'),
        taskList(failed?.items, 'Tidak ada tugas gagal.')),
    ];
  },

  async hr(env, data) {
    const done = await safe('/api/tasks?status=completed&limit=100');
    const perf = new Map();
    for (const t of done?.items || []) if (t.employee_id) perf.set(t.employee_id, (perf.get(t.employee_id) || 0) + 1);
    const emps = data.employees.filter((e) => e.state !== 'off');
    const groups = ['holding', 'shared', 'business'].map((u) => [u, emps.filter((e) => e.org_unit === u)]).filter(([, l]) => l.length);
    const busiest = [...emps].sort((a, b) => (b.waiting || 0) - (a.waiting || 0)).filter((e) => e.waiting > 0).slice(0, 6);
    return [
      section(`Daftar karyawan (${emps.length} aktif)`, groups.map(([u, list]) => h('details', { open: u !== 'business' }, h('summary', { class: 'small' }, `${ORG_LABEL[u] || u} (${list.length})`), h('div', { class: 'stack-xs', style: { marginTop: '6px' } }, list.map((e) => personRow(e, env)))))),
      section('Kinerja', perf.size ? h('div', { class: 'list' }, [...perf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => {
        const e = data.employees.find((x) => x.id === id);
        return h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, e?.name || `#${id}`), h('span', { class: 'muted' }, `${n} tugas selesai`));
      })) : note('Belum ada tugas selesai.'), note(`Dihitung dari ${done?.items?.length || 0} tugas selesai terakhir.`)),
      section('Beban kerja (antrean)', busiest.length ? h('div', { class: 'list' }, busiest.map((e) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, e.name), h('span', { class: 'muted' }, `${e.waiting} tugas menunggu`)))) : note('Tidak ada karyawan dengan antrean.')),
      section('Rekrutmen', note('Tambah atau atur karyawan AI di halaman AI Employees.'), link('#/employees', 'AI Employees →')),
    ];
  },

  async marketing(env, data) {
    const staff = inRoom(env, 'marketing');
    const [tasks, camp] = await Promise.all([tasksOf(staff.map((e) => e.id)), safe('/api/tasks?q=kampanye&limit=5')]);
    return [
      section('Tim marketing', staff.length ? h('div', { class: 'stack-xs' }, staff.map((e) => personRow(e, env))) : note('Belum ada staf marketing.')),
      section('Kampanye', taskList(camp?.items, 'Belum ada tugas berkata kunci "kampanye".')),
      section('Tugas marketing', taskList(tasks, 'Belum ada tugas marketing.')),
    ];
  },

  async shared(env, data) {
    const shared = data.employees.filter((e) => e.org_unit === 'shared' && e.state !== 'off');
    const tasks = (await tasksOf(shared.map((e) => e.id), '', 10)).filter((t) => t.business_id);
    return [
      section('Aktivitas departemen bersama', h('div', { class: 'stack-xs' }, shared.map((e) => personRow(e, env)))),
      section('Tugas lintas bisnis', taskList(tasks, 'Belum ada tugas Shared Services untuk bisnis.')),
    ];
  },

  async lounge(env, data) {
    const ids = new Set(env.chars.keys());
    const here = data.employees.filter((e) => ids.has(e.id));
    const counts = {};
    for (const e of here) counts[env.shownState(e)] = (counts[env.shownState(e)] || 0) + 1;
    const free = here.filter((e) => ['idle', 'resting'].includes(env.shownState(e)));
    const now = new Date();
    return [
      section('Aktivitas karyawan', h('div', { class: 'row' }, Object.entries(counts).map(([k, v]) => h('span', { class: 'pill' }, env.stateBadge(k), ` ${v}`)))),
      section('Sedang istirahat', breakList(env),
        note('Karyawan tanpa tugas sesekali ngobrol, ngopi, main ping-pong/foosball/arcade, atau berenang. Obrolan santai hanya tampil di kantor dan tidak disimpan. Begitu ada tugas, mereka langsung kembali ke meja.')),
      section('Office boy', obList(env)),
      section(`Sedang tidak bertugas (${free.length})`, free.length ? h('div', { class: 'stack-xs' }, free.map((e) => personRow(e, env))) : note('Semua karyawan sedang bertugas.'),
        note('IDLE = tidak ada tugas. RESTING = tidak ada aktivitas ≥ 20 menit (dari riwayat tugas), lebih sering istirahat di lounge atau kolam.')),
      section('Info kantor', h('dl', { class: 'kv small' },
        h('dt', null, 'Kantor'), h('dd', null, env.scene.title),
        h('dt', null, 'Waktu lokal'), h('dd', null, now.toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' })),
        h('dt', null, 'Bisnis aktif'), h('dd', null, String(data.businesses.filter((b) => b.status === 'active').length)),
        h('dt', null, 'Antrean'), h('dd', null, data.queue?.paused ? 'Dijeda' : 'Berjalan'))),
    ];
  },

  async manager(env) {
    return env.businessSummary();
  },

  // Open Space: the whole central team grouped by function, their tasks, and per-function details on demand.
  async open(env, data) {
    const team = [...env.chars.values()].filter((c) => c.e && c.desk?.room?.key === 'open').map((c) => data.employees.find((e) => e.id === c.id)).filter(Boolean);
    const known = new Set(FUNCTIONS.flatMap((f) => f[2]));
    const groups = [...FUNCTIONS.map(([, label, roles]) => [label, team.filter((e) => roles.includes(e.role_key))]), ['Lainnya', team.filter((e) => !known.has(e.role_key))]].filter(([, l]) => l.length);
    const tasks = await tasksOf(team.filter((e) => ACTIVE.has(e.state)).map((e) => e.id).concat(team.map((e) => e.id)).filter((v, i, a) => a.indexOf(v) === i));
    const lazy = (title, key) => {
      const body = h('div', { class: 'stack-sm', style: { marginTop: '6px' } }, note('Memuat…'));
      let loaded = false;
      const el = h('details', { class: 'room-card' }, h('summary', { class: 'small' }, h('b', null, title)), body);
      el.addEventListener('toggle', async () => {
        if (!el.open || loaded) return;
        loaded = true;
        try {
          const nodes = await BUILDERS[key](env, data);
          body.replaceChildren(...[nodes].flat().filter(Boolean));
        } catch (e) {
          body.replaceChildren(note(e.message));
        }
      });
      return el;
    };
    return [
      section(`Tim (${team.length})`, groups.length ? groups.map(([label, list]) => h('div', { class: 'stack-xs' }, h('div', { class: 'small muted' }, label), list.map((e) => personRow(e, env)))) : note('Belum ada tim pusat.')),
      section('Tugas tim', taskList(tasks, 'Belum ada tugas tim pusat.')),
      section('Detail per fungsi', lazy('Keuangan grup', 'finance'), lazy('Sekretariat: dokumen & jadwal', 'reception'), lazy('Riset & laporan', 'research'), lazy('Sistem & server (developer)', 'dev'), lazy('SDM & kinerja', 'hr'), lazy('Marketing', 'marketing')),
    ];
  },

  async pool(env) {
    return [
      section('Sedang berenang', breakList(env, (c) => c.outing.kind === 'swim')),
      section('Office boy', obList(env)),
      note('Hanya suasana: karyawan tanpa tugas sesekali berenang, dan office boy membersihkan kolam. Tidak ada data yang disimpan.'),
    ];
  },

  async workspace(env, data) {
    const b = env.business;
    const [detail, active] = await Promise.all([safe(`/api/businesses/${b.id}`), safe(`/api/tasks?business_id=${b.id}&status=active&limit=8`)]);
    const team = (detail?.team || []).map((t) => data.employees.find((e) => e.id === t.id)).filter(Boolean);
    return [
      section(`Tim (${team.length})`, team.length ? h('div', { class: 'stack-xs' }, team.map((e) => personRow(e, env))) : note('Belum ada karyawan.')),
      section('Tugas aktif bisnis', taskList(active?.items, 'Tidak ada tugas aktif.')),
    ];
  },

  async guests(env, data) {
    const b = env.business;
    const visiting = data.employees.filter((e) => env.scene.visitorFilter(e));
    const assigned = data.employees.filter((e) => e.org_unit === 'shared' && e.business_ids?.includes(b.id));
    return [
      section('Sedang berkunjung', visiting.length ? h('div', { class: 'stack-xs' }, visiting.map((e) => personRow(e, env))) : note('Tidak ada tim pusat yang sedang bekerja untuk bisnis ini.')),
      section('Tim pusat yang ditugaskan tetap', assigned.length ? h('div', { class: 'stack-xs' }, assigned.map((e) => personRow(e, env))) : note('Tidak ada.')),
    ];
  },
};

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  return d ? `${d}h ${hh}j` : hh ? `${hh}j ${mm}m` : `${mm}m`;
}
