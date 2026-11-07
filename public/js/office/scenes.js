// Scene generators: turn real data (employees, businesses) into an office map. No business or room is hardcoded:
// the HQ rooms are functional areas, and every business office is generated from its database row.
export const T = 16; // tile size (logical px)
const HALL_W = 2; // vertical hallway on the left connects all corridors

const ROLE_ROOM = { group_finance: 'finance', finance: 'finance', secretary: 'reception', researcher: 'research', developer: 'dev', hr: 'hr', marketing: 'marketing' };

// ---------- generic layout ----------
function layoutBands(bands, mapW) {
  const rooms = [];
  const corridors = [];
  let y = 0;
  for (const band of bands) {
    let used = HALL_W;
    band.forEach((r, i) => {
      if (i === band.length - 1) r.w = mapW - used; // last room fills the band
      used += r.w;
      r.rows = r.kind === 'desks' ? Math.max(1, Math.ceil(r.deskCount / r.cols)) : 0;
    });
    const need = (r) => (r.kind === 'desks' ? 2 + 2 + r.rows * 4 + 1 : r.minH || 9);
    const h = Math.max(...band.map(need));
    let x = HALL_W;
    for (const r of band) {
      rooms.push({ ...r, x, y, h });
      x += r.w;
    }
    y += h;
    corridors.push({ y, h: 2 });
    y += 2;
  }
  return { rooms, corridors, mapW, mapH: y };
}

function door(room) {
  return { x: (room.x + room.w / 2) * T, y: (room.y + room.h) * T - 10, corridorY: (room.y + room.h) * T + T };
}

// Desk geometry (desk 32x20, monitor on top, chair below, idle spot to the right).
function makeDesk(x, y, room, opts = {}) {
  const exec = opts.exec;
  const w = exec ? 48 : 32;
  const cx = x + w / 2;
  return {
    x, y, w, frame: exec ? 'exec_desk' : 'desk', room,
    monitors: opts.dual ? [{ x: cx - 15, y: y - 6 }, { x: cx + 1, y: y - 6 }] : [{ x: cx - 7, y: y - 6 }],
    chair: { x: cx - 7, y: y + (exec ? 21 : 19) },
    seat: { x: cx, y: y + (exec ? 35 : 33) },
    stand: { x: x + w + 10, y: y + 26 },
    flag: opts.flag || null,
    owner: opts.owner ?? null,
    rect: { x, y: y - 6, w, h: 40 },
  };
}

function placeDesks(room, ids, opts = {}) {
  const out = [];
  const step = opts.exec ? 72 : 56;
  ids.forEach((id, i) => {
    const col = i % room.cols;
    const row = Math.floor(i / room.cols);
    const x = room.x * T + 12 + col * step;
    const y = (room.y + 4 + row * 4) * T;
    out.push(makeDesk(x, y, room, { ...opts, owner: id, flag: opts.flagOf?.(id) || null }));
  });
  return out;
}

// Meeting table (9-slice) + seats around it.
function makeMeeting(room, scope) {
  const x0 = (room.x + 2) * T;
  const w = Math.max(4, room.w - 4) * T;
  const y0 = (room.y + 4) * T + 8;
  const hgt = 2 * T;
  const seats = [];
  const n = Math.max(2, Math.floor((w - 16) / 32));
  for (let i = 0; i < n; i++) {
    const sx = x0 + 16 + i * ((w - 32) / Math.max(1, n - 1));
    seats.push({ x: Math.round(sx), y: y0 + 3, pose: 'sit_front', chair: { f: 'chair_back_n', x: Math.round(sx) - 7, y: y0 - 22 } });
    seats.push({ x: Math.round(sx), y: y0 + hgt + 20, pose: 'sit_back', chair: { f: 'chair', x: Math.round(sx) - 7, y: y0 + hgt + 7 } });
  }
  // Order: alternate north/south so small meetings face each other.
  return {
    room, scope, table: { x: x0, y: y0, w, h: hgt },
    seats, leader: { x: x0 - 12, y: y0 + hgt - 2, pose: 'stand' },
    rect: { x: room.x * T, y: (room.y + 2) * T, w: room.w * T, h: (room.h - 2) * T },
  };
}

// ---------- decoration per room kind (positions adapt to the generated room size) ----------
function decorate(room) {
  const X = room.x * T;
  const Y = room.y * T;
  const W = room.w * T;
  const H = room.h * T;
  const floorBottom = Y + H - 4;
  const wallDeco = [];
  const props = [];
  const wallY = Y + 8;
  const add = (f, x, y) => props.push({ f, x, y });
  switch (room.key) {
    case 'ceo':
      wallDeco.push({ f: 'painting', x: X + W - 64 });
      add('bookshelf', X + 8, Y + 2 * T);
      add('plant_big', X + W - 22, Y + 2 * T + 2);
      add('trophy', X + 46, Y + 2 * T + 18);
      add('armchair', X + W - 34, floorBottom - 26);
      break;
    case 'meeting':
      wallDeco.push({ f: 'whiteboard', x: X + 2 * T }, { f: 'tv', x: X + W - 3.5 * T }, { f: 'clock', x: X + W / 2 - 6 });
      add('plant_small', X + 6, floorBottom - 16);
      add('plant_small', X + W - 18, floorBottom - 16);
      break;
    case 'bm':
      wallDeco.push({ f: 'notice_board', x: X + W - 48 });
      add('plant_big', X + W - 22, Y + 2 * T + 2);
      add('water_cooler', X + 8, Y + 2 * T + 4);
      break;
    case 'finance':
      add('cabinet', X + 8, Y + 2 * T + 6);
      add('cabinet', X + 26, Y + 2 * T + 6);
      add('safe', X + W - 24, Y + 2 * T + 12);
      break;
    case 'reception':
      wallDeco.push({ f: 'clock', x: X + W / 2 - 6 });
      add('printer', X + W - 26, Y + 2 * T + 14);
      add('plant_small', X + 8, Y + 2 * T + 14);
      break;
    case 'research':
      add('bookshelf', X + 6, Y + 2 * T);
      add('bookshelf', X + 40, Y + 2 * T);
      add('globe', X + W - 22, Y + 2 * T + 12);
      break;
    case 'dev':
      add('server_rack', X + 8, Y + 2 * T + 2);
      add('server_rack', X + 26, Y + 2 * T + 2);
      add('lamp', X + W - 18, Y + 2 * T + 2);
      break;
    case 'hr':
      wallDeco.push({ f: 'notice_board', x: X + 12 });
      add('plant_big', X + W - 22, Y + 2 * T + 2);
      break;
    case 'marketing':
      wallDeco.push({ f: 'tv', x: X + W - 3.5 * T }, { f: 'notice_board', x: X + 2 * T });
      add('plant_small', X + 8, Y + 2 * T + 14);
      break;
    case 'shared':
      wallDeco.push({ f: 'painting', x: X + 2 * T });
      add('cabinet', X + W - 24, Y + 2 * T + 6);
      add('plant_small', X + 8, Y + 2 * T + 14);
      break;
    case 'workspace':
      wallDeco.push({ f: 'notice_board', x: X + 2 * T }, { f: 'clock', x: X + W - 3 * T });
      add('plant_big', X + W - 22, Y + 2 * T + 2);
      add('printer', X + 8, Y + 2 * T + 14);
      break;
    case 'manager':
      add('bookshelf', X + 8, Y + 2 * T);
      add('plant_big', X + W - 22, Y + 2 * T + 2);
      break;
    case 'guests':
      wallDeco.push({ f: 'painting', x: X + 2 * T });
      add('water_cooler', X + W - 18, Y + 2 * T + 4);
      break;
    case 'lounge': {
      wallDeco.push({ f: 'painting', x: X + W / 2 - 12 }, { f: 'clock', x: X + 24 });
      const cy = Y + 3 * T + 4;
      add('sofa_blue', X + W / 2 - 24, cy);
      add('coffee_table', X + W / 2 - 12, cy + 28);
      add('sofa_green', X + W / 2 - 24, cy + 46);
      add('coffee_machine', X + 8, Y + 2 * T + 8);
      if (W > 200) add('vending', X + W - 26, Y + 2 * T + 2);
      add('plant_big', X + W - 22, floorBottom - 30);
      add('lamp', X + 8, floorBottom - 30);
      break;
    }
  }
  wallDeco.forEach((d) => (d.y = wallY));
  return { wallDeco, props };
}

function finishScene(base, extra) {
  const { rooms } = base;
  const walls = [];
  const props = [];
  for (const r of rooms) {
    const d = decorate(r);
    walls.push({ room: r, deco: d.wallDeco });
    props.push(...d.props);
    r.door = door(r);
  }
  return { ...base, ...extra, walls, props, hallX: T, rooms };
}

// ---------- HQ ----------
export function buildHQScene(data) {
  const active = (e) => e.state !== 'off';
  const emps = data.employees.filter(active);
  const ceo = emps.find((e) => e.is_manager);
  const managers = emps.filter((e) => !e.is_manager && (e.role_key === 'business_manager' || e.manages_business_id));
  const shared = emps.filter((e) => e.org_unit === 'shared' && !e.is_manager);
  const byRoom = { finance: [], reception: [], research: [], dev: [], hr: [], marketing: [], shared: [] };
  for (const e of shared) byRoom[ROLE_ROOM[e.role_key] || 'shared'].push(e.id);
  // Marketing hub: shared marketers, or (if none) the business marketers shown as a mirror of their business desks.
  let marketingMirror = false;
  if (!byRoom.marketing.length) {
    byRoom.marketing = emps.filter((e) => e.org_unit === 'business' && e.role_key === 'marketing').map((e) => e.id);
    marketingMirror = byRoom.marketing.length > 0;
  }
  const bizColor = new Map(data.businesses.map((b) => [b.id, b.color]));
  const empById = new Map(data.employees.map((e) => [e.id, e]));
  const flagOf = (id) => {
    const e = empById.get(id);
    const bid = e?.manages_business_id ?? e?.business_ids?.[0];
    return bid ? bizColor.get(bid) : null;
  };

  const R = (key, name, w, extra) => ({ key, name, w, floor: 'wood', tint: null, kind: 'desks', cols: 2, deskCount: 0, ...extra });
  const bands = [
    [
      R('ceo', 'CEO Office', 11, { floor: 'carpet', tint: '#8a6fb0', cols: 1, deskCount: ceo ? 1 : 0, exec: true }),
      R('meeting', 'Meeting Room', 15, { floor: 'tile', kind: 'meeting', minH: 11 }),
      R('bm', 'Business Managers', 18, { tint: '#5b7fbf', cols: 3, deskCount: managers.length }),
    ],
    [
      R('finance', 'Group Finance', 9, { floor: 'carpet', tint: '#5f9e54', deskCount: byRoom.finance.length }),
      R('reception', 'Secretary & Reception', 9, { floor: 'tile', deskCount: byRoom.reception.length }),
      R('research', 'Research Library', 9, { floor: 'woodb', deskCount: byRoom.research.length }),
      R('dev', 'Developer Lab', 9, { floor: 'tile', tint: '#3d434e', deskCount: byRoom.dev.length }),
      R('hr', 'HR', 8, { floor: 'carpet', tint: '#d65a4a', deskCount: byRoom.hr.length }),
    ],
    [
      R('marketing', marketingMirror ? 'Marketing Hub (tim bisnis)' : 'Marketing Hub', 15, { floor: 'carpet', tint: '#e07a2f', cols: 3, deskCount: byRoom.marketing.length }),
      R('shared', 'Shared Services', 13, { cols: 3, deskCount: byRoom.shared.length }),
      R('lounge', 'Lounge', 16, { floor: 'woodb', kind: 'lounge', minH: 10 }),
    ],
  ];
  const base = layoutBands(bands, 46);
  const room = (k) => base.rooms.find((r) => r.key === k);
  const desks = [];
  if (ceo) desks.push(...placeDesks(room('ceo'), [ceo.id], { exec: true }));
  desks.push(...placeDesks(room('bm'), managers.map((e) => e.id), { flagOf }));
  for (const k of ['finance', 'reception', 'research', 'hr', 'marketing', 'shared']) desks.push(...placeDesks(room(k), byRoom[k], { flagOf: k === 'marketing' ? flagOf : null }));
  desks.push(...placeDesks(room('dev'), byRoom.dev, { dual: true }));
  const meeting = makeMeeting(room('meeting'), { scope: 'hq', business_id: null });
  return finishScene(base, {
    id: 'hq',
    title: 'Kantor Pusat (Holding)',
    desks,
    deskByOwner: new Map(desks.map((d) => [d.owner, d])),
    meeting,
    visitorDesks: [],
    visitorFilter: () => false,
    entrance: { x: T, y: base.corridors[0].y * T + T },
  });
}

// ---------- business office ----------
export function buildBusinessScene(data, business) {
  const emps = data.employees.filter((e) => e.state !== 'off');
  const manager = emps.find((e) => e.id === business.manager_employee_id) || null;
  const staff = emps.filter((e) => e.id !== manager?.id && e.business_ids?.includes(business.id) && e.org_unit === 'business');
  const assignedShared = emps.filter((e) => e.org_unit === 'shared' && e.business_ids?.includes(business.id));
  const tint = business.color || '#3b82f6';
  const bands = [
    [
      { key: 'manager', name: `Ruang Manager · ${business.name}`, w: 11, kind: 'desks', cols: 1, deskCount: 1, floor: 'carpet', tint },
      { key: 'workspace', name: `Area Kerja Tim · ${business.name}`, w: 27, kind: 'desks', cols: 4, deskCount: Math.max(1, staff.length + assignedShared.length), floor: 'wood', tint },
    ],
    [
      { key: 'meeting', name: 'Ruang Rapat Bisnis', w: 14, kind: 'meeting', minH: 11, floor: 'tile' },
      { key: 'guests', name: 'Meja Tamu · Shared Services', w: 12, kind: 'desks', cols: 2, deskCount: 3, floor: 'tile' },
      { key: 'lounge', name: 'Pantry', w: 12, kind: 'lounge', minH: 10, floor: 'woodb' },
    ],
  ];
  const base = layoutBands(bands, 40);
  const room = (k) => base.rooms.find((r) => r.key === k);
  const desks = [];
  // Manager desk exists even without a manager (shown empty) so the office still reads as a business.
  desks.push(...placeDesks(room('manager'), [manager?.id ?? null], { exec: true, flagOf: () => tint }));
  desks.push(...placeDesks(room('workspace'), [...staff, ...assignedShared].map((e) => e.id)));
  const visitorDesks = placeDesks(room('guests'), [null, null, null]);
  const meeting = makeMeeting(room('meeting'), { scope: 'business', business_id: business.id });
  return finishScene(base, {
    id: `biz-${business.id}`,
    title: business.name,
    business,
    desks,
    deskByOwner: new Map(desks.filter((d) => d.owner).map((d) => [d.owner, d])),
    meeting,
    visitorDesks,
    // Shared services appear here only while they actually work/meet for this business.
    visitorFilter: (e) => e.org_unit === 'shared' && !e.business_ids?.includes(business.id) && (e.visiting_business_id === business.id || (e.meeting?.scope === 'business' && e.meeting.business_id === business.id)),
    entrance: { x: T, y: base.corridors[0].y * T + T },
  });
}

// Layout signature: rebuild the scene only when the roster/structure changes (not on every state change).
export function sceneKey(data, sceneId) {
  return JSON.stringify([
    sceneId,
    data.businesses.map((b) => [b.id, b.status, b.color, b.name, b.manager_employee_id]),
    data.employees.map((e) => [e.id, e.org_unit, e.role_key, e.state === 'off', e.business_ids, e.manages_business_id]),
  ]);
}
