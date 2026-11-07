// AI Virtual Office: HQ + one office per business (built lazily), interactive panels, real task states only.
import { get } from '../api.js';
import { h, mount, clear, badge, fmtRel, fmtDate, fmtNum, taskCode, md, KIND_LABEL, emptyState } from '../ui.js';
import { loadAtlas } from '../office/atlas.js';
import { buildHQScene, buildBusinessScene, sceneKey } from '../office/scenes.js';
import { OfficeEngine } from '../office/engine.js';
import { avatarCanvas } from '../office/sprites.js';
import { createChat } from './chat.js';

export const STATE = {
  idle: { label: 'IDLE', text: 'Tidak ada tugas', color: '#9aa4b2' },
  pending: { label: 'IDLE', text: 'Menunggu antrean (duduk santai)', color: '#f0b354' },
  thinking: { label: 'THINKING', text: 'Menganalisis & merencanakan (panggilan AI berjalan)', color: '#8da4ff' },
  working: { label: 'WORKING', text: 'Mengerjakan tugas (panggilan AI berjalan)', color: '#3b82f6' },
  meeting: { label: 'MEETING', text: 'Rapat menggabungkan hasil', color: '#8b5cf6' },
  completed: { label: 'COMPLETED', text: 'Baru menyelesaikan tugas', color: '#30a46c' },
  error: { label: 'ERROR', text: 'Perlu perhatian', color: '#e5484d' },
  off: { label: 'OFF', text: 'Nonaktif', color: '#666' },
};

const stateBadge = (s) => h('span', { class: 'state-chip', style: { '--c': STATE[s]?.color || '#999' } }, STATE[s]?.label || s);

export async function render(root, [initial = 'hq'], ctx) {
  let engine = null;
  const tabs = h('div', { class: 'office-tabs', role: 'tablist', 'aria-label': 'Pilih kantor' });
  const canvas = h('canvas', { tabindex: 0, 'aria-label': 'Kantor virtual pixel art. Seret untuk menggeser, tombol + / − untuk zoom. Detail tersedia di panel dan tabel.' });
  const wrap = h('div', { class: 'office-wrap' }, canvas,
    h('div', { class: 'office-zoom' },
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Perbesar', onclick: () => engine?.zoom(1.25) }, '+'),
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Perkecil', onclick: () => engine?.zoom(0.8) }, '−'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => engine?.fit() }, 'Pas')));
  const panel = h('aside', { class: 'office-panel card', 'aria-live': 'polite', hidden: true });
  const chat = createChat({ onAgentMessage: (m) => engine?.say(m.sender_employee_id, m.content) });
  let sideTab = 'chat';
  const tabChat = h('button', { class: 'office-tab active', type: 'button', onclick: () => showSide('chat') }, 'Obrolan');
  const tabInfo = h('button', { class: 'office-tab', type: 'button', onclick: () => { showSide('detail'); showPanel(); } }, 'Detail');
  function showSide(which) {
    sideTab = which;
    tabChat.classList.toggle('active', which === 'chat');
    tabInfo.classList.toggle('active', which === 'detail');
    chat.el.hidden = which !== 'chat';
    panel.hidden = which !== 'detail';
  }
  const side = h('div', { class: 'office-side' }, h('div', { class: 'office-tabs' }, tabChat, tabInfo), chat.el, panel);
  const legend = h('div', { class: 'legend' }, ['idle', 'pending', 'thinking', 'working', 'meeting', 'completed', 'error'].map((k) =>
    h('span', null, h('span', { class: 'dot', style: { background: STATE[k].color } }), `${STATE[k].label}${k === 'pending' ? ' (antre)' : ''}`)), h('span', null, '· WALKING: saat status berubah'));
  const tableBody = h('tbody');
  mount(root, h('div', { class: 'stack' },
    tabs,
    h('div', { class: 'office-layout' }, h('div', { class: 'stack-sm', style: { minWidth: 0 } }, wrap, legend), side),
    h('details', { class: 'card' }, h('summary', null, 'Tabel status karyawan di kantor ini'),
      h('div', { class: 'table-wrap', style: { marginTop: '10px' } }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Nama'), h('th', null, 'Jabatan'), h('th', null, 'Status'), h('th', null, 'Tugas'))), tableBody)))));

  mount(panel, h('p', { class: 'muted' }, 'Memuat kantor…'));
  let atlas;
  try {
    atlas = await loadAtlas();
  } catch (e) {
    showSide('detail');
    mount(panel, h('p', { class: 'form-error' }, `Aset kantor gagal dimuat: ${e.message}`));
    return;
  }

  let data = null;
  let current = initial;
  let selection = null;
  const scenes = new Map(); // lazy cache: sceneId -> { key, scene }
  engine = new OfficeEngine(canvas, { atlas, onSelect: (sel) => { selection = sel; if (sel) showSide('detail'); showPanel(); } });

  function sceneFor(id) {
    const key = sceneKey(data, id);
    const cached = scenes.get(id);
    if (cached && cached.key === key) return cached.scene;
    let scene;
    if (id === 'hq') scene = buildHQScene(data);
    else {
      const b = data.businesses.find((x) => `biz-${x.id}` === id && x.status === 'active');
      if (!b) return null;
      scene = buildBusinessScene(data, b);
    }
    scenes.set(id, { key, scene });
    return scene;
  }

  function renderTabs() {
    const items = [{ id: 'hq', name: 'Kantor Pusat', color: '#6b5444', count: data.employees.filter((e) => ['working', 'thinking', 'meeting'].includes(e.state) && (e.org_unit !== 'business')).length }];
    for (const b of data.businesses.filter((x) => x.status === 'active')) items.push({ id: `biz-${b.id}`, name: b.name, color: b.color, count: b.active_tasks });
    mount(tabs, items.map((it) => h('button', {
      class: `office-tab ${it.id === current ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(it.id === current),
      onclick: () => switchTo(it.id),
    }, h('span', { class: 'dot', style: { background: it.color } }), it.name, it.count ? h('span', { class: 'count' }, it.count) : null)));
  }

  function switchTo(id) {
    if (!data.businesses.some((b) => `biz-${b.id}` === id && b.status === 'active')) id = 'hq';
    current = id;
    selection = null;
    history.replaceState(null, '', `#/office/${id}`);
    const scene = sceneFor(id);
    engine.setScene(scene);
    engine.setData(data);
    renderTabs();
    showPanel();
    fillTable();
    chat.setData(data);
    const b = data.businesses.find((x) => `biz-${x.id}` === id);
    chat.setChannel(b ? String(b.id) : 'hq', b ? `Kantor ${b.name} · hanya obrolan bisnis ini` : 'Kantor Pusat · semua obrolan (pusat & bisnis)').catch(() => {});
  }

  function fillTable() {
    clear(tableBody);
    const ids = new Set(engine.chars.keys());
    for (const e of data.employees.filter((x) => ids.has(x.id))) {
      tableBody.append(h('tr', null, h('td', null, e.name), h('td', null, e.role), h('td', null, stateBadge(e.state), ' ', STATE[e.state]?.text || ''),
        h('td', null, e.task ? h('a', { href: `#/task/${e.task.id}` }, `${taskCode(e.task.id)} ${e.task.title}`) : '-')));
    }
  }

  async function refresh() {
    data = await get('/api/office');
    const scene = sceneFor(current);
    if (!scene) return switchTo('hq');
    if (engine.scene !== scene) engine.setScene(scene);
    engine.setData(data);
    renderTabs();
    fillTable();
    chat.setData(data);
    if (!selection && sideTab === 'detail') showPanel(true);
  }

  // ---------------- panels ----------------
  let panelSeq = 0;
  async function showPanel(quiet = false) {
    const seq = ++panelSeq;
    const back = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { selection = null; engine.selected = null; engine.draw(performance.now()); showPanel(); } }, '← Ringkasan kantor');
    try {
      if (!selection) {
        const node = current === 'hq' ? hqSummary() : await businessSummary();
        if (seq === panelSeq) mount(panel, node);
        return;
      }
      if (!quiet) mount(panel, h('p', { class: 'muted' }, 'Memuat…'));
      if (selection.type === 'meeting') {
        const bid = selection.scope.business_id;
        const c = await get(`/api/office/coordination${bid ? `?business_id=${bid}` : ''}`);
        if (seq === panelSeq) mount(panel, back, meetingPanel(c));
      } else {
        const d = await get(`/api/office/employees/${selection.id}`);
        if (seq === panelSeq) mount(panel, back, employeePanel(d, selection.type === 'desk'));
      }
    } catch (e) {
      if (seq === panelSeq) mount(panel, back, h('p', { class: 'form-error' }, e.message));
    }
  }

  function hqSummary() {
    const counts = {};
    const inHQ = new Set(engine.chars.keys());
    for (const e of data.employees.filter((x) => inHQ.has(x.id))) counts[e.state] = (counts[e.state] || 0) + 1;
    return h('div', { class: 'stack-sm' },
      h('h3', null, 'Kantor Pusat (Holding)'),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Group CEO, Business Managers, dan Shared Services. Klik karakter, meja, atau Meeting Room untuk detail.'),
      h('div', { class: 'row' }, Object.entries(counts).map(([k, v]) => h('span', { class: 'pill' }, stateBadge(k), ` ${v}`))),
      data.queue.paused ? h('p', { class: 'small', style: { color: 'var(--warn)', margin: 0 } }, 'Antrean dijeda: tidak ada pekerjaan AI yang berjalan.') : null,
      h('h4', { class: 'small muted', style: { marginTop: '8px' } }, 'Kantor bisnis'),
      data.businesses.filter((b) => b.status === 'active').map((b) =>
        h('button', { class: 'office-biz-link', type: 'button', onclick: () => switchTo(`biz-${b.id}`) },
          h('span', { class: 'dot', style: { background: b.color } }), h('span', { class: 'grow' }, b.name),
          h('span', { class: 'small muted' }, `${b.active_tasks} aktif · ${b.last_activity_at ? fmtRel(b.last_activity_at) : 'belum ada aktivitas'}`))));
  }

  async function businessSummary() {
    const b = data.businesses.find((x) => `biz-${x.id}` === current);
    const [detail, activity] = await Promise.all([get(`/api/businesses/${b.id}`), get(`/api/businesses/${b.id}/activity`)]);
    const empState = new Map(data.employees.map((e) => [e.id, e]));
    return h('div', { class: 'stack-sm' },
      h('div', { class: 'row' }, h('span', { class: 'dot', style: { background: b.color, width: '12px', height: '12px' } }), h('h3', { class: 'grow' }, b.name), h('a', { class: 'small', href: `#/business/${b.id}` }, 'Detail →')),
      h('div', { class: 'small muted' }, `${b.industry || '-'} · Manager: ${detail.business.manager?.name || 'belum ada'}`),
      h('div', { class: 'row' }, h('span', { class: 'pill' }, `${b.active_tasks} aktif`), h('span', { class: 'pill' }, `${b.completed_tasks} selesai`), b.failed_tasks ? h('span', { class: 'pill', style: { color: 'var(--err)' } }, `${b.failed_tasks} gagal`) : null),
      h('h4', { class: 'small muted', style: { marginTop: '6px' } }, `Karyawan (${detail.team.length})`),
      detail.team.length ? detail.team.map((e) => h('button', { class: 'office-biz-link', type: 'button', onclick: () => { selection = { type: 'employee', id: e.id }; engine.selected = selection; engine.draw(performance.now()); showPanel(); } },
        avatarCanvas(e.avatar, 1), h('span', { class: 'grow' }, e.name, h('span', { class: 'small muted' }, ` · ${e.role.split(' — ')[0]}`)), stateBadge(empState.get(e.id)?.state || 'idle'))) : h('p', { class: 'small muted' }, 'Belum ada karyawan.'),
      h('h4', { class: 'small muted', style: { marginTop: '6px' } }, 'Aktivitas terakhir'),
      activity.length ? h('div', { class: 'list timeline' }, activity.slice(0, 6).map((a) => h('div', { class: 'list-item' }, h('div', { class: 'grow small' }, h('a', { href: `#/task/${a.task_id}` }, a.title), h('div', { class: 'muted' }, `${a.event}${a.message ? `: ${a.message.slice(0, 90)}` : ''}`)), h('span', { class: 'small muted nowrap' }, fmtRel(a.created_at))))) : h('p', { class: 'small muted' }, 'Belum ada aktivitas.'),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => ctx.openNewTask({ mode: 'business', business_id: b.id }) }, '+ Business task'));
  }

  function taskRow(t) {
    return h('div', { class: 'list-item' },
      h('div', { class: 'grow small' }, h('a', { href: `#/task/${t.id}` }, `${taskCode(t.id)} ${t.title}`),
        h('div', { class: 'muted' }, [KIND_LABEL[t.kind], t.business_name, t.model_used ? `${t.provider_name}/${t.model_used}` : null, t.tokens_in + t.tokens_out ? `${fmtNum(t.tokens_in + t.tokens_out)} token` : null].filter(Boolean).join(' · '))),
      badge(t.status));
  }

  function employeePanel(d, deskFocus) {
    const e = d.employee;
    const s = d.state || { state: 'idle' };
    const work = h('div', { class: 'stack-sm' },
      h('h4', { class: 'small muted' }, deskFocus ? 'Pekerjaan di meja ini' : 'Tugas aktif'),
      d.active_tasks.length ? h('div', { class: 'list' }, d.active_tasks.map(taskRow)) : h('p', { class: 'small muted', style: { margin: 0 } }, 'Tidak ada tugas aktif.'));
    const result = d.last_result
      ? h('details', { open: deskFocus }, h('summary', { class: 'small' }, `Hasil terakhir: ${d.last_result.title}`), h('div', { class: 'result-box small', style: { maxHeight: '240px' } }, md(d.last_result.excerpt)), h('a', { class: 'small', href: `#/task/${d.last_result.task_id}` }, 'Buka tugas →'))
      : h('p', { class: 'small muted', style: { margin: 0 } }, 'Belum ada hasil pekerjaan.');
    return h('div', { class: 'stack-sm' },
      h('div', { class: 'row', style: { alignItems: 'flex-start' } }, avatarCanvas(e.avatar, 2.5),
        h('div', { class: 'grow' }, h('h3', null, e.name), h('div', { class: 'small muted' }, e.role), h('div', { style: { marginTop: '4px' } }, stateBadge(s.state), ' ', h('span', { class: 'small' }, STATE[s.state]?.text || '')))),
      s.reason ? h('p', { class: 'small', style: { color: 'var(--err)', margin: 0 } }, s.reason) : null,
      s.meeting ? h('p', { class: 'small muted', style: { margin: 0 } }, `Rapat ${s.meeting.scope === 'hq' ? 'di Kantor Pusat' : 'di kantor bisnis'}${s.meeting.leader ? ' (memimpin)' : ''}`) : null,
      h('dl', { class: 'kv small' },
        h('dt', null, 'Bisnis'), h('dd', null, d.businesses.length ? d.businesses.map((b) => `${b.name}${b.is_manager ? ' (manager)' : ''}`).join(', ') : e.org_unit === 'shared' ? 'Semua bisnis (sesuai tugas)' : e.org_unit === 'holding' ? 'Seluruh holding' : '-'),
        h('dt', null, 'Model diatur'), h('dd', { class: 'mono' }, `${d.configured_model.provider || 'belum ada provider'} / ${d.configured_model.model || 'default'}`, h('span', { class: 'muted' }, ` (${d.configured_model.source})`)),
        h('dt', null, 'AI terakhir'), h('dd', { class: 'mono' }, d.last_ai_call ? `${d.last_ai_call.provider_name} / ${d.last_ai_call.model} · ${fmtRel(d.last_ai_call.created_at)}` : 'belum pernah'),
        h('dt', null, 'Token hari ini'), h('dd', null, `${fmtNum(d.usage.today.tokens_in + d.usage.today.tokens_out)} (${d.usage.today.requests} request)`),
        h('dt', null, 'Token total'), h('dd', null, `${fmtNum(d.usage.total.tokens_in + d.usage.total.tokens_out)} (${d.usage.total.requests} request)`)),
      deskFocus ? [work, result] : [work, result],
      h('h4', { class: 'small muted' }, 'Riwayat tugas'),
      d.recent_tasks.length ? h('div', { class: 'list' }, d.recent_tasks.map(taskRow)) : h('p', { class: 'small muted', style: { margin: 0 } }, 'Belum ada riwayat.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => ctx.openNewTask({ mode: 'direct', employee_id: e.id }) }, '+ Tugas langsung'),
        h('a', { class: 'btn btn-sm btn-ghost', href: `#/employees/${e.id}` }, 'Edit profil')));
  }

  function meetingPanel(c) {
    return h('div', { class: 'stack-sm' },
      h('h3', null, c.scope === 'hq' ? 'Meeting Room — Kantor Pusat' : 'Ruang Rapat Bisnis'),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Koordinasi antar-karyawan dari data tugas: rencana dibagi, hasil digabung.'),
      h('h4', { class: 'small muted' }, 'Koordinasi aktif'),
      c.active.length
        ? c.active.map((t) => h('div', { class: 'card', style: { padding: '10px', background: 'var(--surface-2)' } },
            h('div', { class: 'row-between' }, h('a', { href: `#/task/${t.id}`, class: 'small' }, `${taskCode(t.id)} ${t.title}`), t.in_meeting_now ? badge('processing', 'Rapat berlangsung') : badge(t.status)),
            h('div', { class: 'small muted' }, `Dipimpin ${t.leader || '-'} · fase ${t.phase || '-'}`),
            t.participants.length ? h('ul', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '18px' } }, t.participants.map((p) => h('li', null, `${p.name || '-'}${p.business_name ? ` @ ${p.business_name}` : ''}: `, h('a', { href: `#/task/${p.task_id}` }, p.title), ' ', badge(p.status)))) : null))
        : h('p', { class: 'small muted', style: { margin: 0 } }, 'Tidak ada koordinasi yang sedang berjalan.'),
      h('h4', { class: 'small muted' }, 'Riwayat koordinasi'),
      c.recent.length ? h('div', { class: 'list timeline' }, c.recent.map((r) => h('div', { class: 'list-item' }, h('div', { class: 'grow small' }, h('a', { href: `#/task/${r.task_id}` }, r.title), h('div', { class: 'muted' }, `${r.event}${r.message ? `: ${r.message.slice(0, 120)}` : ''}`)), h('span', { class: 'small muted nowrap' }, fmtDate(r.created_at))))) : emptyState('Belum ada rapat.'));
  }

  // ---------------- lifecycle ----------------
  data = await get('/api/office');
  switchTo(initial.startsWith('biz-') ? initial : 'hq');
  engine.start();
  ctx.poll(async () => {
    await refresh();
    await chat.poll().catch(() => {});
    if (selection && sideTab === 'detail') showPanel(true);
  }, 2000);
  const ro = new ResizeObserver(() => engine.resize());
  ro.observe(wrap);
  // Pause rendering when the tab is hidden or the canvas is scrolled out of view.
  let onScreen = true;
  const io = new IntersectionObserver(([en]) => {
    onScreen = en.isIntersecting;
    onScreen && !document.hidden ? engine.start() : engine.stop();
  });
  io.observe(canvas);
  const onVis = () => (document.hidden || !onScreen ? engine.stop() : engine.start());
  document.addEventListener('visibilitychange', onVis);
  return () => {
    engine.stop();
    ro.disconnect();
    io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
  };
}
