// AI Virtual Office: HQ + one office per business (built lazily), interactive panels, real task states only.
import { get } from '../api.js';
import { h, mount, clear, badge, fmtRel, fmtDate, fmtNum, taskCode, md, KIND_LABEL, ORG_LABEL, emptyState } from '../ui.js';
import { loadAtlas } from '../office/sprite-atlas.js';
import { buildHQScene, buildBusinessScene, sceneKey } from '../office/scenes.js';
import { OfficeEngine, dayPeriod } from '../office/engine.js';
import { avatarCanvas } from '../office/sprites.js';
import { createSound } from '../office/sound.js';
import { KINDS, loadWeatherSettings, saveWeatherSettings, fetchCurrentWeather, searchPlaces, REFRESH_MS } from '../office/weather.js';
import { createChat } from './chat.js';
import { roomPanel } from './officePanels.js';

export const STATE = {
  idle: { label: 'IDLE', text: 'Tidak ada tugas (jalan-jalan di ruangannya)', color: '#9aa4b2' },
  resting: { label: 'RESTING', text: 'Duduk santai di mejanya (tidak ada aktivitas ≥ 20 menit)', color: '#7dd3fc' },
  pending: { label: 'IDLE', text: 'Menunggu antrean (duduk santai)', color: '#f0b354' },
  thinking: { label: 'THINKING', text: 'Menganalisis & merencanakan (panggilan AI berjalan)', color: '#8da4ff' },
  working: { label: 'WORKING', text: 'Mengerjakan tugas (panggilan AI berjalan)', color: '#3b82f6' },
  meeting: { label: 'MEETING', text: 'Rapat menggabungkan hasil', color: '#8b5cf6' },
  completed: { label: 'COMPLETED', text: 'Baru menyelesaikan tugas', color: '#30a46c' },
  error: { label: 'ERROR', text: 'Perlu perhatian', color: '#e5484d' },
  off: { label: 'OFF', text: 'Nonaktif', color: '#666' },
};
const ACTIVE = new Set(['working', 'thinking', 'meeting']);
const PHASE = { planning: 'Perencanaan', executing: 'Dikerjakan tim', synthesizing: 'Menggabungkan hasil (rapat)' };
const PERIOD = { morning: 'Pagi', afternoon: 'Siang', evening: 'Sore', night: 'Malam' };

const stateBadge = (s) => h('span', { class: 'state-chip', style: { '--c': STATE[s]?.color || '#999' } }, STATE[s]?.label || s);

export async function render(root, [initial = 'hq'], ctx) {
  let engine = null;
  const sound = createSound();
  const tabs = h('div', { class: 'office-tabs', role: 'tablist', 'aria-label': 'Pilih kantor' });
  const canvas = h('canvas', { tabindex: 0, 'aria-label': 'Kantor virtual pixel art. Seret untuk menggeser, tombol + / − untuk zoom, 0 untuk pas layar. Detail tersedia di panel dan tabel.' });

  // ---- top status bar (numbers from /api/office + /api/overview) ----
  const sb = {};
  const sbItem = (k, label) => h('span', { class: 'os-item' }, h('small', null, label), (sb[k] = h('b', null, '–')));
  const statusBar = h('div', { class: 'office-status', role: 'status', 'aria-label': 'Status holding' },
    h('div', { class: 'os-brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), h('b', null, 'AI Virtual Holding'), (sb.clock = h('span', { class: 'os-clock' }))),
    h('div', { class: 'os-stats' },
      h('button', { class: 'os-item os-btn', type: 'button', title: 'Atur cuaca: otomatis atau manual', onclick: () => openFloat({ kind: 'weather' }, 0) }, h('small', null, 'Cuaca'), (sb.wx = h('b', null, '–'))),
      sbItem('emp', 'Karyawan'), sbItem('working', 'Bekerja'), sbItem('active', 'Tugas aktif'), sbItem('done', 'Selesai hari ini'), sbItem('biz', 'Bisnis'),
      (sb.sysWrap = h('span', { class: 'os-item os-sys', dataset: { level: 'ok' } }, h('small', null, 'Sistem'), (sb.sys = h('b', null, '–'))))));

  // ---- overlays inside the canvas frame ----
  const tip = h('div', { class: 'office-tip px', hidden: true, role: 'tooltip' });
  const float = h('div', { class: 'office-float', hidden: true, role: 'dialog', 'aria-label': 'Informasi karyawan' });
  const notes = h('div', { class: 'office-notes', 'aria-live': 'polite' });
  // Minimap is off by default; the "Peta" button shows it.
  const minimap = h('canvas', { class: 'office-minimap', 'aria-label': 'Minimap: klik untuk memindahkan kamera', hidden: true });
  const btnMap = h('button', { class: 'btn btn-sm', type: 'button', title: 'Tampilkan/sembunyikan minimap', 'aria-pressed': String(!minimap.hidden), onclick: () => {
    minimap.hidden = !minimap.hidden;
    btnMap.setAttribute('aria-pressed', String(!minimap.hidden));
    engine?.draw(performance.now());
  } }, 'Peta');
  const btnSound = h('button', { class: 'btn btn-sm', type: 'button', title: 'Suara kantor (default mati)', 'aria-pressed': 'false', onclick: () => {
    const on = sound.toggle();
    btnSound.setAttribute('aria-pressed', String(on));
    btnSound.textContent = on ? '♪ On' : '♪ Off';
  } }, '♪ Off');
  const wrap = h('div', { class: 'office-wrap' }, canvas,
    h('div', { class: 'office-zoom' },
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Perbesar', title: 'Perbesar (+)', onclick: () => engine?.zoom(1.25) }, '+'),
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Perkecil', title: 'Perkecil (−)', onclick: () => engine?.zoom(0.8) }, '−'),
      h('button', { class: 'btn btn-sm', type: 'button', title: 'Reset kamera: pas layar (0)', onclick: () => engine?.fit() }, 'Pas'),
      btnMap, btnSound),
    tip, float, notes, minimap);

  const panel = h('aside', { class: 'office-panel card', 'aria-live': 'polite', hidden: true });
  const chat = createChat({ onAgentMessage: (m) => engine?.say(m.sender_employee_id, m.content) });
  // Obrolan | Detail column on the right of the office (below it on narrow screens).
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
  const legend = h('div', { class: 'legend' }, ['idle', 'resting', 'pending', 'thinking', 'working', 'meeting', 'completed', 'error'].map((k) =>
    h('span', null, h('span', { class: 'dot', style: { background: STATE[k].color } }), `${STATE[k].label}${k === 'pending' ? ' (antre)' : ''}`)), h('span', null, '· WALKING: saat status berubah · Klik karakter, meja, atau ruangan untuk detail'));
  const tableBody = h('tbody');
  mount(root, h('div', { class: 'stack' },
    tabs,
    h('div', { class: 'office-layout' }, h('div', { class: 'stack-sm', style: { minWidth: 0 } }, statusBar, wrap, legend), side),
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
  let ov = null; // /api/overview, refreshed every 10 s
  let ovAt = 0;
  let current = initial;
  let selection = null;
  const scenes = new Map(); // lazy cache: sceneId -> { key, scene }

  // RESTING is not a backend state: it is derived from real task history. An employee without a task whose last
  // known activity is at least REST_AFTER_MS ago sits relaxed at its own desk (strolling in its room now and then).
  // No known activity (fresh install, or nothing in the latest 100 tasks) = IDLE: strolls around its own room.
  // Nobody ever leaves their room unless a real task or meeting calls them.
  const REST_AFTER_MS = 20 * 60 * 1000;
  const lastActive = new Map(); // employeeId -> ms of the latest real activity (task updated / state seen active)
  let historyAt = 0;
  async function loadHistory() {
    historyAt = Date.now();
    const r = await get('/api/tasks?limit=100');
    for (const t of r.items) {
      for (const id of [t.employee_id, t.manager_employee_id]) {
        if (id) lastActive.set(id, Math.max(lastActive.get(id) || 0, t.updated_at || t.created_at || 0));
      }
    }
  }
  function restingSet() {
    const now = Date.now();
    const out = new Set();
    for (const e of data.employees) {
      if (e.state === 'off') continue;
      if (e.state !== 'idle') {
        lastActive.set(e.id, now);
        continue;
      }
      const last = lastActive.get(e.id);
      if (last && now - last >= REST_AFTER_MS) out.add(e.id);
    }
    return out;
  }
  const shownState = (e) => engine.chars.get(e.id)?.state || e.state;

  async function loadOverview(force = false) {
    if (!force && ov && Date.now() - ovAt < 10000) return ov;
    ovAt = Date.now();
    ov = await get('/api/overview').catch(() => ov);
    return ov;
  }

  function systemStatus() {
    if (!ov) return { level: 'ok', text: '–' };
    if (ov.queue?.paused) return { level: 'paused', text: 'Antrean dijeda' };
    const prov = (ov.providers || []).filter((p) => p.enabled);
    if (!prov.length) return { level: 'error', text: 'Belum ada provider AI' };
    if (prov.every((p) => p.status === 'error' || (p.cooldown_until && p.cooldown_until > Date.now()))) return { level: 'error', text: 'Provider AI bermasalah' };
    return { level: 'ok', text: 'Normal' };
  }

  function updateStatusBar() {
    const now = new Date();
    sb.clock.textContent = `${now.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · ${now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} · ${PERIOD[dayPeriod(now)]}`;
    const emps = data.employees.filter((e) => e.state !== 'off');
    sb.emp.textContent = fmtNum(emps.length);
    sb.working.textContent = fmtNum(emps.filter((e) => ACTIVE.has(e.state)).length);
    sb.biz.textContent = fmtNum(data.businesses.filter((b) => b.status === 'active').length);
    if (ov) {
      sb.active.textContent = fmtNum((ov.holding.tasks.pending || 0) + (ov.holding.tasks.processing || 0));
      sb.done.textContent = fmtNum(ov.holding.tasks_today.completed || 0);
    }
    const sys = systemStatus();
    sb.sys.textContent = sys.text;
    sb.sysWrap.dataset.level = sys.level;
    engine.setSystemStatus(sys);
  }

  // ---- notifications: derived from real state changes between two polls ----
  let prev = null;
  let prevApprovals = null;
  function pushNote(kind, title, text, employeeId) {
    const el = h('button', { class: `office-note k-${kind}`, type: 'button', onclick: () => {
      if (employeeId && engine.chars.has(employeeId)) selectEmployee(employeeId, true);
      else if (kind === 'approval') location.hash = '#/approvals';
      el.remove();
    } }, h('b', null, title), text ? h('span', null, text.length > 70 ? `${text.slice(0, 68)}…` : text) : null);
    notes.append(el);
    while (notes.children.length > 3) notes.firstElementChild.remove();
    setTimeout(() => el.remove(), 6000);
    sound.notify(kind);
  }
  function detectChanges() {
    const now = new Map(data.employees.map((e) => [e.id, e]));
    if (prev) {
      for (const e of data.employees) {
        const p = prev.get(e.id);
        if (!p || p.state === e.state || !engine.chars.has(e.id)) continue;
        const title = e.task?.title || '';
        if (ACTIVE.has(e.state) && e.state !== 'meeting' && !ACTIVE.has(p.state)) pushNote('start', `${e.name} mulai bekerja`, title, e.id);
        else if (e.state === 'completed') pushNote('done', `${e.name} menyelesaikan tugas`, title, e.id);
        else if (e.state === 'error') pushNote('fail', e.reason?.startsWith('Tugas tertunda') ? `Tugas ${e.name} tertunda` : `Tugas ${e.name} gagal`, title || e.reason || '', e.id);
        else if (e.state === 'meeting' && e.meeting?.leader) pushNote('meet', 'Rapat dimulai', `Dipimpin ${e.name}${title ? `: ${title}` : ''}`, e.id);
      }
    }
    if (ov && prevApprovals !== null && ov.approvals_pending > prevApprovals) pushNote('approval', 'Approval menunggu', `${ov.approvals_pending} menunggu keputusan owner`);
    if (ov) prevApprovals = ov.approvals_pending;
    prev = now;
  }

  // ---- hover tooltip: name, status, active task ----
  let tipKey = null;
  function onHover(hv) {
    if (!hv || (float.dataset.id && Number(float.dataset.id) === hv.id && !float.hidden)) {
      tip.hidden = true;
      tipKey = null;
      return;
    }
    const e = hv.employee;
    const st = hv.char?.state || e.state;
    const key = `${e.id}:${st}:${e.task?.id || ''}`;
    if (key !== tipKey) {
      tipKey = key;
      mount(tip, h('div', { class: 'row', style: { gap: '6px' } }, h('b', null, e.name), stateBadge(st)),
        h('div', { class: 'small muted' }, STATE[st]?.text || ''),
        e.task && st !== 'idle' && st !== 'resting' ? h('div', { class: 'small' }, `${taskCode(e.task.id)} ${e.task.title}`) : null);
    }
    tip.hidden = false;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    let x = hv.sx + 14;
    let y = hv.sy + 16;
    if (x + tip.offsetWidth > W - 6) x = hv.sx - tip.offsetWidth - 10;
    if (y + tip.offsetHeight > H - 6) y = hv.sy - tip.offsetHeight - 10;
    tip.style.left = `${Math.max(6, x)}px`;
    tip.style.top = `${Math.max(6, y)}px`;
  }

  // ---- weather & time (front yard): automatic (Open-Meteo, chosen city) or manual ----
  const wx = loadWeatherSettings();
  let wxErr = null;
  let wxBusy = false;
  let wxQuery = '';
  let wxResults = [];
  function weatherNow() {
    if (wx.mode === 'manual') return { kind: wx.manual, text: `${KINDS[wx.manual]} (manual)` };
    if (!wx.place) return { kind: 'cerah', text: 'Atur lokasi' };
    const l = wx.last;
    // Never show stale data as current: older than 3 hours counts as unavailable.
    if (!l || l.place !== wx.place.name || Date.now() - l.at > 3 * 3600 * 1000) return { kind: 'cerah', text: wxErr ? 'Tidak tersedia' : 'Memuat…' };
    return { kind: l.kind, text: `${l.label} ${l.temp}°C` };
  }
  function applyWeather() {
    const w = weatherNow();
    engine.setWeather(w.kind);
    sb.wx.textContent = w.text;
    if (!float.hidden && float.dataset.kind === 'weather') renderWeatherCard();
  }
  async function refreshWeather(force = false) {
    if (wx.mode !== 'auto' || !wx.place || wxBusy) return;
    const fresh = wx.last && wx.last.place === wx.place.name && Date.now() - wx.last.at < REFRESH_MS;
    if (fresh && !force) return;
    if (!force && wxErr && Date.now() - (refreshWeather.failedAt || 0) < 60000) return; // retry at most once a minute
    wxBusy = true;
    applyWeather();
    try {
      wx.last = { ...(await fetchCurrentWeather(wx.place)), place: wx.place.name };
      wxErr = null;
      saveWeatherSettings(wx);
    } catch (e) {
      wxErr = e.message;
      refreshWeather.failedAt = Date.now();
    } finally {
      wxBusy = false;
      applyWeather();
    }
  }
  async function searchCity() {
    const q = wxQuery.trim();
    if (q.length < 2) return;
    wxErr = null;
    wxResults = [];
    try {
      wxResults = await searchPlaces(q);
      if (!wxResults.length) wxErr = `Kota "${q}" tidak ditemukan`;
    } catch (e) {
      wxErr = e.message;
    }
    renderWeatherCard();
  }
  function renderWeatherCard() {
    if (float.hidden || float.dataset.kind !== 'weather') return;
    const now = new Date();
    const w = weatherNow();
    const modeBtn = (m, label) => h('button', {
      class: `btn btn-sm ${wx.mode === m ? 'btn-primary' : ''}`, type: 'button', 'aria-pressed': String(wx.mode === m),
      onclick: () => {
        wx.mode = m;
        wxErr = null;
        saveWeatherSettings(wx);
        applyWeather();
        refreshWeather();
      },
    }, label);
    const input = h('input', { type: 'search', placeholder: 'Nama kota, mis. Jakarta', value: wxQuery, 'aria-label': 'Cari kota', oninput: (e) => (wxQuery = e.target.value), onkeydown: (e) => e.key === 'Enter' && searchCity() });
    const auto = [
      h('div', { class: 'small' }, 'Lokasi: ', h('b', null, wx.place ? wx.place.name : 'belum diatur')),
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, input, h('button', { class: 'btn btn-sm', type: 'button', onclick: searchCity }, 'Cari')),
      wxResults.length ? h('div', { class: 'stack-xs' }, wxResults.map((p) => h('button', {
        class: 'office-biz-link', type: 'button',
        onclick: () => {
          wx.place = p;
          wx.last = null;
          wxResults = [];
          wxErr = null;
          saveWeatherSettings(wx);
          refreshWeather(true);
        },
      }, p.name))) : null,
      wxBusy ? h('div', { class: 'small muted' }, 'Mengambil cuaca dari Open-Meteo…') : null,
      wx.place && wx.last && wx.last.place === wx.place.name ? h('div', { class: 'small' }, `Sekarang: ${wx.last.label}, ${wx.last.temp}°C · diperbarui ${fmtRel(wx.last.at)}`) : null,
      wxErr ? h('p', { class: 'small', style: { color: 'var(--err)', margin: 0 } }, wxErr) : null,
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Sumber: Open-Meteo (gratis, tanpa API key). Koordinat kota (dibulatkan ±1 km) dikirim ke Open-Meteo; diperbarui tiap 15 menit.'),
    ];
    const manual = [
      h('div', { class: 'small muted' }, 'Cuaca yang ditampilkan di halaman depan:'),
      h('div', { class: 'row' }, Object.entries(KINDS).map(([k, l]) => h('button', {
        class: `btn btn-sm ${wx.manual === k ? 'btn-primary' : ''}`, type: 'button', 'aria-pressed': String(wx.manual === k),
        onclick: () => {
          wx.manual = k;
          saveWeatherSettings(wx);
          applyWeather();
        },
      }, l))),
    ];
    mount(float, floatClose(), h('div', { class: 'stack-sm' },
      h('div', { class: 'room-head', style: { '--c': '#5fb2ec' } }, h('h3', null, 'Cuaca & waktu'),
        h('div', { class: 'small muted' }, `${now.toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' })} · ${PERIOD[dayPeriod(now)]} (jam browser)`)),
      h('div', { class: 'small' }, 'Ditampilkan: ', h('b', null, w.text)),
      h('div', { class: 'row' }, modeBtn('auto', 'Otomatis'), modeBtn('manual', 'Manual')),
      wx.mode === 'auto' ? auto : manual,
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Pengaturan cuaca disimpan di browser ini.')));
  }

  // ---- floating card inside the office: employee (character/desk click) or room (room click) ----
  let floatSeq = 0;
  let floatRoom = null;
  let floatAt = 0;
  function selectEmployee(id, fromList = false) {
    const c = engine.chars.get(id);
    engine.selected = { type: 'employee', id };
    if (c && fromList) engine.focusOn(c.x, c.y - 12);
    engine.draw(performance.now());
    const sx = c ? (c.x - engine.cam.x) * engine.scale : 0;
    openFloat({ kind: 'employee', id }, sx);
    // The Detail panel follows the clicked employee when it is already showing an employee.
    if (selection?.type === 'employee' && selection.id !== id) {
      selection = { type: 'employee', id };
      showPanel();
    }
  }
  function openFloat(target, sx) {
    floatRoom = target.kind === 'room' ? target.room : null;
    float.dataset.kind = target.kind;
    if (target.kind === 'employee') float.dataset.id = String(target.id);
    else delete float.dataset.id;
    float.dataset.side = sx > wrap.clientWidth / 2 ? 'left' : 'right';
    float.setAttribute('aria-label', floatRoom ? `Ruangan ${floatRoom.name}` : target.kind === 'weather' ? 'Cuaca dan waktu' : 'Informasi karyawan');
    float.hidden = false;
    float.scrollTop = 0;
    tip.hidden = true;
    mount(float, h('p', { class: 'small muted', style: { margin: 0 } }, 'Memuat…'));
    renderFloat();
  }
  function closeFloat() {
    float.hidden = true;
    floatRoom = null;
    delete float.dataset.id;
    if (engine) {
      engine.selected = null;
      engine.draw(performance.now());
    }
  }
  const floatClose = () => h('button', { class: 'float-x float-close', type: 'button', 'aria-label': 'Tutup', onclick: closeFloat }, '×');
  const roomEnv = (room) => ({
    data, scene: engine.scene, room, business: engine.scene.business || null, chars: engine.chars, ctx,
    shownState, stateBadge, selectEmployee: (id) => selectEmployee(id, true), switchTo, overview: () => loadOverview(), meetingPanel, businessSummary,
  });
  async function renderFloat() {
    if (float.hidden) return;
    if (float.dataset.kind === 'weather') return renderWeatherCard();
    const seq = ++floatSeq;
    floatAt = Date.now();
    if (floatRoom) {
      const room = floatRoom;
      try {
        const node = await roomPanel(roomEnv(room));
        if (seq === floatSeq && floatRoom === room) mount(float, floatClose(), node);
      } catch (e) {
        if (seq === floatSeq) mount(float, floatClose(), h('p', { class: 'form-error' }, e.message));
      }
      return;
    }
    const id = Number(float.dataset.id);
    if (!id) return;
    try {
      const d = await get(`/api/office/employees/${id}`);
      const cur = d.active_tasks[0] || null;
      let progress = null;
      if (cur && (cur.kind === 'instruction' || cur.kind === 'business')) {
        const t = await get(`/api/tasks/${cur.id}`).catch(() => null);
        const kids = t?.children || [];
        if (kids.length) progress = { done: kids.filter((k) => k.status === 'completed').length, total: kids.length };
      }
      if (seq !== floatSeq || Number(float.dataset.id) !== id) return;
      mount(float, floatCard(d, cur, progress));
    } catch (e) {
      if (seq === floatSeq) mount(float, floatClose(), h('p', { class: 'form-error' }, e.message));
    }
  }
  function floatCard(d, cur, progress) {
    const e = d.employee;
    const st = engine.chars.get(e.id)?.state === 'resting' ? 'resting' : d.state?.state || 'idle';
    const last = Math.max(d.last_ai_call?.created_at || 0, ...d.recent_tasks.map((t) => t.completed_at || t.updated_at || 0), ...d.active_tasks.map((t) => t.started_at || t.created_at || 0));
    const shownTask = cur || (d.state?.task && ['completed', 'error'].includes(d.state.state) ? d.state.task : null);
    const biz = d.businesses.length ? d.businesses.map((b) => `${b.name}${b.is_manager ? ' (manager)' : ''}`).join(', ') : e.org_unit === 'shared' ? 'Semua bisnis (sesuai tugas)' : e.org_unit === 'holding' ? 'Seluruh holding' : '-';
    const provider = d.last_ai_call ? d.last_ai_call.provider_name : d.configured_model.provider || 'belum ada provider';
    const model = d.last_ai_call ? d.last_ai_call.model : d.configured_model.model || 'default';
    return h('div', { class: 'stack-sm' },
      h('div', { class: 'row', style: { alignItems: 'flex-start' } }, avatarCanvas(e.avatar, 2),
        h('div', { class: 'grow' }, h('h3', null, e.name), h('div', { class: 'small muted' }, e.role)),
        h('button', { class: 'float-x', type: 'button', 'aria-label': 'Tutup', onclick: closeFloat }, '×')),
      h('div', null, stateBadge(st), ' ', h('span', { class: 'small' }, STATE[st]?.text || '')),
      d.state?.reason ? h('p', { class: 'small', style: { color: 'var(--err)', margin: 0 } }, d.state.reason) : null,
      h('dl', { class: 'kv small' },
        h('dt', null, 'Departemen'), h('dd', null, ORG_LABEL[e.org_unit] || e.org_unit),
        h('dt', null, 'Bisnis'), h('dd', null, biz),
        h('dt', null, 'Tugas'), h('dd', null, shownTask ? h('a', { href: `#/task/${shownTask.id}` }, `${taskCode(shownTask.id)} ${shownTask.title}`) : 'Tidak ada tugas aktif'),
        progress ? [h('dt', null, 'Progres'), h('dd', null, `${progress.done}/${progress.total} subtugas selesai`, h('div', { class: 'bar', style: { marginTop: '3px' } }, h('span', { style: { width: `${(progress.done / progress.total) * 100}%`, background: 'var(--ok)' } })))]
          : cur?.phase ? [h('dt', null, 'Fase'), h('dd', null, PHASE[cur.phase] || cur.phase)] : null,
        h('dt', null, 'Provider AI'), h('dd', { class: 'mono' }, provider),
        h('dt', null, 'Model'), h('dd', { class: 'mono' }, model),
        h('dt', null, 'Token'), h('dd', null, `${fmtNum(d.usage.today.tokens_in + d.usage.today.tokens_out)} hari ini · ${fmtNum(d.usage.total.tokens_in + d.usage.total.tokens_out)} total`),
        h('dt', null, 'Aktivitas'), h('dd', null, last ? fmtRel(last) : 'belum ada')),
      h('div', { class: 'small muted' }, 'Riwayat tugas'),
      d.recent_tasks.length ? h('div', { class: 'list' }, d.recent_tasks.slice(0, 3).map((t) => h('div', { class: 'list-item small' }, h('a', { class: 'grow', href: `#/task/${t.id}` }, `${taskCode(t.id)} ${t.title}`), badge(t.status)))) : h('p', { class: 'small muted', style: { margin: 0 } }, 'Belum ada riwayat.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
          selection = { type: 'employee', id: e.id };
          showSide('detail');
          showPanel();
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } }, 'Detail lengkap'),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => ctx.openNewTask({ mode: 'direct', employee_id: e.id }) }, '+ Tugas')));
  }

  engine = new OfficeEngine(canvas, {
    atlas,
    onHover,
    // Clicks open a card inside the office (visible without scrolling); the Detail panel below keeps the summary.
    onSelect: (sel) => {
      if (sel?.type === 'employee' || sel?.type === 'desk') return selectEmployee(sel.id);
      if (sel?.type === 'room') return openFloat({ kind: 'room', room: sel.room }, sel.sx);
      if (sel?.type === 'yard') return openFloat({ kind: 'weather' }, sel.sx);
      closeFloat();
    },
  });
  sound.setTypingSource(() => engine.anyVisible((c) => c.state === 'working' && !c.path.length));
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) engine.setAmbient(false);
  engine.attachMinimap(minimap);
  // Wide screens: the canvas fills the viewport height next to the chat column (no empty space beside it).
  engine.maxHeight = () => {
    if (window.innerWidth <= 1100) return Math.round(window.innerHeight * 0.72);
    const top = wrap.getBoundingClientRect().top + window.scrollY;
    return Math.max(360, Math.round(window.innerHeight - top - legend.offsetHeight - 28));
  };

  function sceneFor(id) {
    const key = sceneKey(data, id);
    const cached = scenes.get(id);
    if (cached && cached.key === key) return cached.scene;
    let scene;
    if (id === 'hq') scene = buildHQScene(data, atlas.size);
    else {
      const b = data.businesses.find((x) => `biz-${x.id}` === id && x.status === 'active');
      if (!b) return null;
      scene = buildBusinessScene(data, b, atlas.size);
    }
    scenes.set(id, { key, scene });
    return scene;
  }

  function renderTabs() {
    const items = [{ id: 'hq', name: 'Kantor Pusat', color: '#6b5444', count: data.employees.filter((e) => ACTIVE.has(e.state) && (e.org_unit !== 'business')).length }];
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
    closeFloat();
    history.replaceState(null, '', `#/office/${id}`);
    const scene = sceneFor(id);
    engine.setScene(scene);
    engine.setData(data, { resting: restingSet() });
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
      tableBody.append(h('tr', null, h('td', null, e.name), h('td', null, e.role), h('td', null, stateBadge(shownState(e)), ' ', STATE[shownState(e)]?.text || ''),
        h('td', null, e.task ? h('a', { href: `#/task/${e.task.id}` }, `${taskCode(e.task.id)} ${e.task.title}`) : '-')));
    }
  }

  async function refresh() {
    data = await get('/api/office');
    const scene = sceneFor(current);
    if (!scene) return switchTo('hq');
    if (engine.scene !== scene) engine.setScene(scene);
    if (Date.now() - historyAt > 60000) await loadHistory().catch(() => {});
    await loadOverview();
    engine.setData(data, { resting: restingSet() });
    renderTabs();
    fillTable();
    updateStatusBar();
    detectChanges();
    chat.setData(data);
  }

  // ---------------- panels ----------------
  let panelSeq = 0;
  let panelAt = 0;
  async function showPanel(quiet = false) {
    const seq = ++panelSeq;
    panelAt = Date.now();
    const back = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { selection = null; showPanel(); } }, '← Ringkasan kantor');
    try {
      if (!selection) {
        const node = current === 'hq' ? hqSummary() : await businessSummary();
        if (seq === panelSeq) mount(panel, node);
        return;
      }
      if (!quiet) mount(panel, h('p', { class: 'muted' }, 'Memuat…'));
      if (selection.type === 'room') {
        const node = await roomPanel({
          data, scene: engine.scene, room: selection.room, business: engine.scene.business || null, chars: engine.chars, ctx,
          shownState, stateBadge, selectEmployee: (id) => selectEmployee(id, true), switchTo, overview: () => loadOverview(), meetingPanel, businessSummary,
        });
        if (seq === panelSeq) mount(panel, back, node);
      } else if (selection.type === 'meeting') {
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
    for (const e of data.employees.filter((x) => inHQ.has(x.id))) counts[shownState(e)] = (counts[shownState(e)] || 0) + 1;
    return h('div', { class: 'stack-sm' },
      h('h3', null, 'Kantor Pusat (Holding)'),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Group CEO, Business Managers, dan Shared Services. Klik karakter, meja, atau ruangan untuk detail.'),
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
      detail.team.length ? detail.team.map((e) => h('button', { class: 'office-biz-link', type: 'button', onclick: () => selectEmployee(e.id, true) },
        avatarCanvas(e.avatar, 1), h('span', { class: 'grow' }, e.name, h('span', { class: 'small muted' }, ` · ${e.role.split(' — ')[0]}`)), stateBadge(empState.get(e.id) ? shownState(empState.get(e.id)) : 'idle'))) : h('p', { class: 'small muted' }, 'Belum ada karyawan.'),
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
    const s = { ...(d.state || { state: 'idle' }) };
    if (engine.chars.get(e.id)?.state === 'resting') s.state = 'resting';
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
      work, result,
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
      h('h4', { class: 'small muted' }, 'Rapat aktif'),
      c.active.length
        ? c.active.map((t) => h('div', { class: 'card', style: { padding: '10px', background: 'var(--surface-2)' } },
            h('div', { class: 'row-between' }, h('a', { href: `#/task/${t.id}`, class: 'small' }, `${taskCode(t.id)} ${t.title}`), t.in_meeting_now ? badge('processing', 'Rapat berlangsung') : badge(t.status)),
            h('div', { class: 'small muted' }, `Dipimpin ${t.leader || '-'} · fase ${PHASE[t.phase] || t.phase || '-'}`),
            t.participants.length ? h('ul', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '18px' } }, t.participants.map((p) => h('li', null, `${p.name || '-'}${p.business_name ? ` @ ${p.business_name}` : ''}: `, h('a', { href: `#/task/${p.task_id}` }, p.title), ' ', badge(p.status)))) : null))
        : h('p', { class: 'small muted', style: { margin: 0 } }, 'Tidak ada koordinasi yang sedang berjalan.'),
      h('h4', { class: 'small muted' }, 'Riwayat rapat'),
      c.recent.length ? h('div', { class: 'list timeline' }, c.recent.map((r) => h('div', { class: 'list-item' }, h('div', { class: 'grow small' }, h('a', { href: `#/task/${r.task_id}` }, r.title), h('div', { class: 'muted' }, `${r.event}${r.message ? `: ${r.message.slice(0, 120)}` : ''}`)), h('span', { class: 'small muted nowrap' }, fmtDate(r.created_at))))) : emptyState('Belum ada rapat.'));
  }

  // ---------------- lifecycle ----------------
  data = await get('/api/office');
  await Promise.all([loadHistory().catch(() => {}), loadOverview(true)]);
  switchTo(initial.startsWith('biz-') ? initial : 'hq');
  applyWeather();
  refreshWeather();
  updateStatusBar();
  detectChanges();
  engine.start();
  ctx.poll(async () => {
    await refresh();
    await chat.poll().catch(() => {});
    // Room cards and office summaries aggregate several endpoints: refresh them every 10 s instead of every 2 s.
    if (!float.hidden && float.dataset.kind !== 'weather' && (!floatRoom || Date.now() - floatAt > 10000)) renderFloat();
    refreshWeather(); // only fetches when the automatic reading is older than 15 minutes
    if (!panel.hidden && (selection || Date.now() - panelAt > 10000)) showPanel(true);
  }, 2000);
  const ro = new ResizeObserver(() => engine.resize());
  const onWinResize = () => engine.resize();
  window.addEventListener('resize', onWinResize);
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
  const onKey = (e) => {
    if (e.key === 'Escape' && !float.hidden) closeFloat();
  };
  document.addEventListener('keydown', onKey);
  return () => {
    engine.stop();
    sound.destroy();
    ro.disconnect();
    window.removeEventListener('resize', onWinResize);
    io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('keydown', onKey);
  };
}
