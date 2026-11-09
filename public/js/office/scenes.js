// Scene generators: turn real data (employees, businesses) into an office map. No business or room is hardcoded:
// the HQ rooms are functional areas, and every business office is generated from its database row.
// v2: every room gets wallpaper, rug, sign and function-specific furniture placed with collision checks
// (no overlapping objects, desks/characters keep their positions).
export const T = 16; // tile size (logical px)
const HALL_W = 2; // vertical hallway on the left connects all corridors
// Front yard above the building (tiles): sky 3, road 2, sidewalk 1, parking lot 4. Shows time of day and weather.
export const YARD_H = 10;

const ROLE_DESK = { marketing: 'desk_mkt', finance: 'desk_fin', group_finance: 'desk_fin', secretary: 'desk_rec', researcher: 'desk_res', developer: 'desk_dev', hr: 'desk_hr', business_manager: 'desk_bm' };
// Startup HQ: the central team sits together in one Open Space, grouped by function (finance, secretary, research,
// developers, HR, marketing, then custom roles). Each desk keeps its role-specific items.
const ROLE_ORDER = ['group_finance', 'finance', 'secretary', 'researcher', 'developer', 'hr', 'marketing'];
const roleRank = (e) => {
  const i = ROLE_ORDER.indexOf(e.role_key);
  return i === -1 ? ROLE_ORDER.length : i;
};

// Office boys: decorative NPCs (not AI employees, no data). Same uniform, different faces.
const OB_UNIFORM = { shirt: '#7cc0e8', pants: '#2f3b52', accent: '#1f4e79' };
export const OFFICE_BOYS = [
  { id: 'ob-1', name: 'Ujang', avatar: { ...OB_UNIFORM, skin: '#e0ac69', hair: '#2b1a10', hairStyle: 'cap' } },
  { id: 'ob-2', name: 'Dedi', avatar: { ...OB_UNIFORM, skin: '#c68642', hair: '#1b1b1b', hairStyle: 'short' } },
  { id: 'ob-3', name: 'Bayu', avatar: { ...OB_UNIFORM, skin: '#f1c27d', hair: '#3b2416', hairStyle: 'messy' } },
  { id: 'ob-4', name: 'Asep', avatar: { ...OB_UNIFORM, skin: '#d9a066', hair: '#24160d', hairStyle: 'cap' } },
];

// ---------- generic layout ----------
// Landscape map: every band is stretched to mapW and the extra width is shared by all rooms of the band in proportion
// to their base width (rooms get roomier, nothing is squeezed). Wider rooms fit more desks per row, which keeps the
// map low, so "Pas" (fit) can show the whole office on a landscape screen.
function layoutBands(bands, mapW) {
  const rooms = [];
  const corridors = [];
  let y = YARD_H;
  for (const band of bands) {
    const base = band.reduce((n, r) => n + r.w, 0);
    const extra = Math.max(0, mapW - HALL_W - base);
    let used = HALL_W;
    band.forEach((r, i) => {
      r.w = i === band.length - 1 ? mapW - used : r.w + Math.floor((extra * r.w) / base);
      used += r.w;
      if (r.kind === 'desks') {
        const step = r.exec ? 72 : 56;
        const fit = Math.max(1, Math.floor((r.w * T - 30) / step));
        r.cols = Math.max(1, Math.min(fit, r.maxCols || 6, Math.max(r.deskCount, 1)));
      }
      r.rows = r.kind === 'desks' ? Math.max(1, Math.ceil(r.deskCount / r.cols)) : 0;
    });
    // wall (2) + furniture strip (2) + desk rows (4 each) + floor space for props (2)
    const need = (r) => (r.kind === 'desks' ? 2 + 2 + r.rows * 4 + 2 : r.minH || 10);
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

// Map width for a target aspect ratio (canvas width / height) so that "Pas" fills the whole canvas: rooms simply get
// wider. Height barely depends on width (only through desks per row), so two passes converge.
const MAX_MAP_W = 120;
function layoutFor(makeBands, { aspect, minW, defaultW }) {
  let w = defaultW;
  if (aspect && Number.isFinite(aspect)) {
    for (let i = 0; i < 2; i++) {
      const h = layoutBands(makeBands(), w).mapH;
      w = Math.min(MAX_MAP_W, Math.max(minW, Math.round(aspect * h)));
    }
  }
  return layoutBands(makeBands(), w);
}

function door(room) {
  return { x: (room.x + room.w / 2) * T, y: (room.y + room.h) * T - 10, corridorY: (room.y + room.h) * T + T };
}

// Front yard: road, sidewalk with street lamps and trees, a parking lot laid out like a real office lot and a
// walkway to the main entrance (top of the left hallway):
//  - motor zone: scooters parked perpendicular in two rows facing away from a shared aisle (top row seen from
//    behind, bottom row from the front), a few empty spots, helmets on some seats/mirrors;
//  - car zone: marked parallel bays along the building, a driving aisle and a driveway from the road,
//    one lifted off-road double-cabin pickup (3/4 front view);
//  - a small lawn with trees and bushes.
// Decoration only: vehicles do not represent employees. Objects never overlap (checked by findCollisions).
function buildYard(mapW, size, { title, motorCols }) {
  const W = mapW * T;
  const yard = {
    h: YARD_H * T,
    sky: { y: 0, h: 3 * T },
    road: { y: 3 * T, h: 2 * T },
    walk: { y: 5 * T, h: T },
    lot: { y: 6 * T, h: 4 * T },
    entry: { x: 0, w: HALL_W * T },
    objects: [], // static sprites (vehicles, lamps, signs, bushes) drawn into the background
    decals: [], // drawn on top of objects: helmets on bikes (not part of the overlap check)
    paint: [], // white parking lines
    trees: [], // drawn as ambient (they sway)
    lamps: [], // lamp heads for night lighting
    lawn: null,
    driveway: null,
    puddles: [],
  };
  const top = yard.lot.y;
  const bottom = yard.lot.y + yard.lot.h;
  const put = (f, x, y, extra = {}) => {
    const s = size(f);
    const o = { f, x: Math.round(x), y: Math.round(y), w: s.w, h: s.h, ...extra };
    yard.objects.push(o);
    return o;
  };
  const line = (x, y, w, h) => yard.paint.push({ x: Math.round(x), y: Math.round(y), w, h });
  // Building name on a plank beside the entrance walkway (sidewalk).
  const signW = Math.min(170, Math.round(title.length * 5.4) + 22);
  yard.sign = { x: HALL_W * T + 6, y: yard.walk.y + 2, w: signW, h: 12, name: title };

  // ---- motor zone ----
  const mz = { x: HALL_W * T + 8, w: motorCols * 13 + 6 };
  line(mz.x, top + 1, mz.w, 1);
  line(mz.x, bottom - 2, mz.w, 1);
  line(mz.x, top + 1, 1, yard.lot.h - 2);
  line(mz.x + mz.w - 1, top + 1, 1, yard.lot.h - 2);
  const COLORS = ['red', 'blue', 'black', 'white', 'yellow'];
  const rowA = [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0];
  const rowB = [1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1];
  for (let i = 0; i < motorCols; i++) {
    const x = mz.x + 4 + i * 13 + (((i * 7) % 3) - 1) * 0.5;
    if (rowA[i % rowA.length]) {
      const b = put(`motor_r_${COLORS[(i * 2 + 1) % 5]}`, x, top + 3, { vehicle: true });
      if (i % 3 === 0) yard.decals.push({ f: 'helmet', x: b.x + 3, y: b.y + 4 });
    }
    if (rowB[i % rowB.length]) {
      const b = put(`motor_f_${COLORS[(i * 3 + 2) % 5]}`, x, bottom - 3 - 22, { vehicle: true });
      if (i % 4 === 1) yard.decals.push({ f: 'helmet_w', x: b.x + 7, y: b.y });
    }
  }

  // ---- car zone: parallel bays along the building, driving aisle + driveway on the road side ----
  put('p_sign', mz.x + mz.w + 3, top + 2);
  const car = size('raptor');
  const bayW = car.w + 8;
  const bayH = car.h + 4;
  const cz = { x: mz.x + mz.w + 20 };
  const nBays = Math.max(1, Math.min(4, Math.floor((W - cz.x - 110) / bayW)));
  cz.w = nBays * bayW;
  const bayTop = bottom - 2 - bayH;
  line(cz.x, bayTop, cz.w + 1, 1); // bay edge toward the aisle
  line(cz.x, bottom - 2, cz.w + 1, 1);
  for (let i = 0; i <= nBays; i++) line(cz.x + i * bayW, bayTop, 1, bayH); // bay separators
  yard.driveway = { x: cz.x + Math.round(bayW / 2), w: bayW };
  const carBay = Math.min(1, nBays - 1);
  put('raptor', cz.x + carBay * bayW + 4, bottom - 3 - car.h, { vehicle: true });

  // ---- lawn with trees and bushes ----
  const lx = cz.x + cz.w + 12;
  if (W - 6 - lx >= 40) {
    yard.lawn = { x: lx, y: top + 4, w: W - 6 - lx, h: yard.lot.h - 8 };
    const tree = size('tree');
    const bush = size('bush');
    let tx = lx + 6;
    let n = 0;
    while (tx + tree.w <= yard.lawn.x + yard.lawn.w - 4) {
      if (n % 2 === 0) yard.trees.push({ type: 'plant', f: 'tree', x: tx, y: bottom - 6 - tree.h, w: tree.w, h: tree.h, z: bottom - 6 });
      else {
        put('bush', tx + 2, bottom - 8 - bush.h);
        if (tx + 6 + bush.w <= yard.lawn.x + yard.lawn.w - 4) put('bush', tx + 4, top + 8);
      }
      tx += n % 2 === 0 ? tree.w + 8 : bush.w + 14;
      n++;
    }
  }

  // ---- street lamps and trees on the sidewalk (right of the sign, never on the driveway) ----
  const lamp = size('lamp_post');
  const tree = size('tree');
  let sx = yard.sign.x + signW + 18;
  let k = 0;
  const dw = yard.driveway;
  while (sx + tree.w < W - 8) {
    const w = k % 2 === 0 ? lamp.w : tree.w;
    if (sx + w > dw.x - 4 && sx < dw.x + dw.w + 4) {
      sx = dw.x + dw.w + 8;
      continue;
    }
    if (k % 2 === 0) {
      const o = put('lamp_post', sx, yard.walk.y + yard.walk.h - lamp.h);
      yard.lamps.push({ x: o.x + 8, y: o.y + 4, gx: o.x + 5, gy: yard.lot.y + 6 });
      sx += lamp.w + 70;
    } else {
      yard.trees.push({ type: 'plant', f: 'tree', x: sx, y: yard.walk.y + yard.walk.h - tree.h + 2, w: tree.w, h: tree.h, z: yard.walk.y + yard.walk.h + 2 });
      sx += tree.w + 70;
    }
    k++;
  }
  // Where rain water collects (drawn only while it rains).
  for (let i = 0; i < 7; i++) {
    yard.puddles.push({ x: Math.round(((i * 0.37 + 0.11) % 1) * (W - 60)) + 30, y: i % 2 ? yard.road.y + 8 + (i % 3) * 6 : yard.lot.y + 6 + (i % 3) * 3, w: 14 + (i % 3) * 6 });
  }
  return yard;
}

// Desk geometry (desk 32x20, monitor on top, chair below, idle spot to the right).
function makeDesk(x, y, room, opts = {}) {
  const exec = opts.exec;
  const w = exec ? 48 : 32;
  const cx = x + w / 2;
  return {
    x, y, w, frame: opts.frame || (exec ? 'exec_desk' : 'desk'), room, exec: Boolean(exec),
    monitors: opts.dual || exec ? [{ x: cx - 15, y: y - 6 }, { x: cx + 1, y: y - 6 }] : [{ x: cx - 7, y: y - 6 }],
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
  // The desk group is centred in the room (rooms are wider in the landscape layout); +20 keeps the idle spot free.
  const perRow = Math.max(1, Math.min(room.cols, ids.length));
  const blockW = (perRow - 1) * step + (opts.exec ? 48 : 32) + 20;
  const x0 = room.x * T + Math.max(12, Math.floor((room.w * T - blockW) / 2));
  ids.forEach((id, i) => {
    const col = i % room.cols;
    const row = Math.floor(i / room.cols);
    const x = x0 + col * step;
    const y = (room.y + 4 + row * 4) * T;
    out.push(makeDesk(x, y, room, { ...opts, owner: id, flag: opts.flagOf?.(id) || null, frame: opts.frameOf?.(id) || opts.frame, dual: opts.dual || opts.dualOf?.(id) }));
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
  return {
    room, scope, table: { x: x0, y: y0, w, h: hgt },
    seats, leader: { x: x0 - 12, y: y0 + hgt - 2, pose: 'stand' },
    rect: { x: room.x * T, y: (room.y + 2) * T, w: room.w * T, h: (room.h - 2) * T },
  };
}

// ---------- furnishing with collision checks ----------
const PAD = 2;
const overlap = (a, b, p = PAD) => a.x < b.x + b.w + p && a.x + a.w + p > b.x && a.y < b.y + b.h + p && a.y + a.h + p > b.y;
const RUG_COLORS = ['red', 'blue', 'green'];
const AMBIENT_PLANTS = new Set(['plant_small', 'plant_big', 'palm']);

// What each room contains. wall = hung on the wallpaper, back = against the wall, floor = free-standing.
const FURNITURE = {
  ceo: { wall: ['kpi_board', 'certificate', 'plaque'], back: [['bookshelf', 'left'], ['trophy_cabinet', 'right']], floor: [['plant_big', 'right'], ['plant_small', 'left']], rug: 'red' },
  meeting: { wall: ['present_screen', 'agenda_board', 'clock_face'], back: [], floor: [['plant_small', 'left'], ['plant_small', 'right']], rug: 'blue' },
  bm: { wall: ['perf_board', 'notice_board', 'clock_face'], back: [['water_cooler', 'left'], ['cabinet', 'right']], floor: [['plant_big', 'right'], ['plant_small', 'left']] },
  finance: { wall: ['finance_board', 'dash_screen'], back: [['cabinet_tall', 'right'], ['cabinet', 'right'], ['safe', 'right']], floor: [['plant_small', 'right']] },
  reception: { wall: ['welcome_sign', 'calendar_board', 'clock_face'], back: [['doc_shelf', 'right'], ['printer', 'right']], floor: [['chair_visit', 'right'], ['chair_visit', 'right'], ['plant_small', 'left']] },
  research: { wall: ['research_board'], back: [['bookshelf_tall', 'right'], ['bookshelf_tall', 'right']], floor: [['research_table', 'right'], ['globe', 'right'], ['book_stack', 'left']], rug: 'green' },
  dev: { wall: ['network_board', 'status_panel'], back: [['server_rack', 'right'], ['server_rack', 'right']], floor: [['workstation', 'right'], ['plant_small', 'left']] },
  hr: { wall: ['recruit_board', 'hr_board'], back: [['cabinet_tall', 'right'], ['binder_shelf', 'right']], floor: [['side_table', 'right'], ['chair_visit', 'right'], ['plant_big', 'right']] },
  marketing: { wall: ['campaign_board', 'moodboard', 'content_calendar', 'analytics_screen'], back: [['art_cart', 'right'], ['easel', 'right']], floor: [['plant_small', 'right'], ['plant_big', 'left']] },
  shared: { wall: ['kanban_board', 'painting', 'clock_face'], back: [['archive_shelf', 'right'], ['copier', 'right'], ['printer', 'right']], floor: [['plant_small', 'right'], ['plant_big', 'left']] },
  lounge: { wall: ['painting', 'clock_face', 'tv'], back: [['coffee_machine', 'left'], ['vending', 'right'], ['bookshelf', 'right']], floor: [['plant_big', 'right'], ['lamp', 'left'], ['plant_small', 'left']], rug: 'red', lounge: true },
  manager: { wall: ['kpi_board', 'certificate'], back: [['bookshelf', 'right'], ['trophy_cabinet', 'right']], floor: [['plant_big', 'right']], rug: 'biz' },
  workspace: { wall: ['perf_board', 'kanban_board', 'clock_face'], back: [['printer', 'right'], ['cabinet', 'right'], ['water_cooler', 'right']], floor: [['plant_big', 'right'], ['plant_small', 'left']] },
  guests: { wall: ['painting', 'clock_face'], back: [['water_cooler', 'right']], floor: [['plant_small', 'right']] },
  // v5 startup HQ
  open: {
    wall: ['neon_sign', 'kanban_board', 'analytics_screen', 'moodboard', 'clock_face'],
    back: [['phone_booth', 'right'], ['bike_rack', 'right'], ['water_cooler', 'left'], ['printer', 'left']],
    floor: [['plant_big', 'right'], ['plant_big', 'left'], ['plant_small', 'left']],
  },
  // Lounge: sofa cluster in the middle, coffee corner on the left, game corner on the right.
  startup_lounge: {
    wall: ['coffee_menu', 'tv', 'dartboard', 'clock_face', 'painting'],
    back: [], floor: [['plant_big', 'left'], ['plant_small', 'right']], rug: 'blue', lounge: true, startup: true,
  },
  pool: {
    wall: ['lifebuoy', 'clock_face', 'lifebuoy'],
    back: [['palm', 'left'], ['towel_rack', 'left'], ['palm', 'right'], ['pool_shower', 'right']], floor: [], pool: true,
  },
};
const WALL_STYLE = {
  ceo: 'wood', meeting: 'glass', bm: 'concrete', finance: 'sage', reception: 'peach', research: 'wood', dev: 'slate', hr: 'rose', marketing: 'lav', shared: 'cream',
  lounge: 'sage', manager: 'wood', workspace: 'brick', guests: 'peach', open: 'brick', pool: 'pooltile',
};

function furnish(scene, room, size, rugIndex) {
  const spec = FURNITURE[room.spec || room.key] || { wall: [], back: [], floor: [] };
  const X = room.x * T;
  const Y = room.y * T;
  const W = room.w * T;
  const H = room.h * T;
  // spots: where the office boys work (coffee machine, their cart, pool edge); snapped to free cells by the engine.
  const out = { wallDeco: [], props: [], rugs: [], ambient: [], restSeats: [], extras: [], spots: {}, pool: null };
  // ---- obstacles: desks, idle spots, meeting area, door path ----
  const occ = [];
  for (const d of [...scene.desks, ...scene.visitorDesks].filter((d) => d.room === room)) {
    occ.push({ x: d.x - 2, y: d.y - 8, w: d.w + 4, h: 46 });
    occ.push({ x: d.stand.x - 8, y: d.stand.y - 26, w: 16, h: 28 });
  }
  if (scene.meeting?.room === room) {
    const t = scene.meeting.table;
    occ.push({ x: t.x - 24, y: t.y - 26, w: t.w + 48, h: t.h + 52 });
  }
  occ.push({ x: room.door.x - 22, y: Y + H - 30, w: 44, h: 30 });
  const inside = (r, top = Y + 2 * T - 12) => r.x >= X + 4 && r.x + r.w <= X + W - 4 && r.y >= top && r.y + r.h <= Y + H - 4;
  const tryAt = (f, cands, opts = {}) => {
    const s = opts.size || size(f);
    for (const [x, y] of cands) {
      const r = { x, y, w: s.w, h: s.h };
      if (!inside(r, opts.top) || occ.some((o) => overlap(r, o))) continue;
      occ.push(r);
      return r;
    }
    return null;
  };
  const xs = (w, side) => {
    const list = [];
    for (let x = X + 4; x <= X + W - 4 - w; x += 2) list.push(x);
    return side === 'right' ? list.reverse() : list;
  };
  const ys = (h) => {
    const list = [];
    for (let y = Y + H - 6 - h; y >= Y + 4 * T - 4; y -= 2) list.push(y);
    return list;
  };
  const place = (f, r) => {
    if (AMBIENT_PLANTS.has(f)) out.ambient.push({ type: 'plant', f, x: r.x, y: r.y, w: r.w, h: r.h, z: r.y + r.h });
    else out.props.push({ f, x: r.x, y: r.y, w: r.w, h: r.h });
  };
  const backY = (f) => Y + 4 * T - 2 - size(f).h; // standing against the wall

  // ---- sign plank on the wall + wall decorations ----
  const signW = Math.min(W - 12, Math.round(room.name.length * 5.4) + 22);
  const sign = { x: X + 6, y: Y + 8, w: signW, h: 13 };
  out.sign = sign;
  const wallOcc = [sign];
  for (const f of spec.wall) {
    const s = size(f);
    if (!s.w) continue;
    const y = s.h >= 22 ? Y + 5 : Y + 9;
    for (let x = sign.x + sign.w + 6; x + s.w <= X + W - 6; x += 2) {
      const r = { x, y, w: s.w, h: s.h };
      if (wallOcc.some((o) => overlap(r, o, 4))) continue;
      wallOcc.push(r);
      out.wallDeco.push({ f, x, y });
      if (f === 'clock_face') out.ambient.push({ type: 'clock', x, y });
      if (f === 'status_panel') out.ambient.push({ type: 'panel', x, y });
      break;
    }
  }
  out.wallOcc = wallOcc;

  // ---- swimming pool: water basin in the middle, loungers + parasols on the deck below it ----
  if (spec.pool) {
    // Layout (top to bottom): wall strip with palms/towels, deck path, water, a free walkway around the pool,
    // loungers + parasols along the bottom wall (left and right of the door). Every deck area stays reachable.
    const pw = Math.max(6 * T, Math.min(W - 8 * T, 24 * T));
    const ph = Math.max(3 * T, Math.min(4 * T, H - 8 * T));
    const pool = { x: X + Math.round((W - pw) / 2), y: Y + 4 * T + 6, w: pw, h: ph };
    out.pool = pool;
    occ.push({ x: pool.x - 4, y: pool.y - 4, w: pool.w + 8, h: pool.h + 8 });
    out.extras.push({ f: 'pool_ladder', x: pool.x + pool.w - 26, y: pool.y - 3 });
    out.ambient.push({ type: 'pool', x: pool.x, y: pool.y, w: pool.w, h: pool.h });
    out.ambient.push({ type: 'float', x: pool.x + Math.round(pool.w * 0.28), y: pool.y + Math.round(pool.h * 0.4), w: 12, h: 12 });
    // Free walkway below the water so the side decks connect to the door.
    occ.push({ x: X + 4, y: pool.y + pool.h + 4, w: W - 8, h: 16 });
    const row = (f, fromRight) => {
      const s = size(f);
      const y = Y + H - 6 - s.h;
      const r = tryAt(f, xs(s.w, fromRight ? 'right' : 'left').map((x) => [x, y]));
      if (r) out.props.push({ f, ...r });
    };
    for (const side of [false, true]) for (const f of ['lounger', 'parasol', 'lounger']) row(f, side);
    // The office boy skims the pool from the side decks.
    out.spots.pool = [{ x: pool.x - 12, y: pool.y + Math.round(pool.h / 2) }, { x: pool.x + pool.w + 12, y: pool.y + Math.round(pool.h / 2) }];
  }

  // ---- lounge: seating cluster with real seats for RESTING employees ----
  if (spec.lounge) {
    const sofa = size('sofa_blue');
    const cx = Math.round(X + W / 2 - sofa.w / 2);
    const top = Y + 4 * T - 6;
    const s1 = tryAt('sofa_blue', [[cx, top], [cx - 16, top], [cx + 16, top]]);
    if (s1) {
      out.props.push({ f: 'sofa_blue', ...s1 });
      out.restSeats.push({ x: s1.x + 15, y: s1.y + 17, pose: 'sit_front' }, { x: s1.x + 33, y: s1.y + 17, pose: 'sit_front' });
      const ct = tryAt('coffee_table', [[s1.x + 12, s1.y + 26]]);
      if (ct) out.props.push({ f: 'coffee_table', ...ct });
      if (H - (s1.y - Y) > 90) {
        const s2 = tryAt('sofa_green_up', [[s1.x, (ct ? ct.y + ct.h : s1.y + 40) + 4]]);
        if (s2) {
          out.props.push({ f: 'sofa_green_up', ...s2 });
          out.restSeats.push({ x: s2.x + 15, y: s2.y + 9, pose: 'sit_back' }, { x: s2.x + 33, y: s2.y + 9, pose: 'sit_back' });
        }
      }
      for (const bb of ['bean_bag', 'bean_bag_b']) {
        const r = tryAt(bb, [[s1.x + sofa.w + 6, s1.y + 30], [s1.x - 22, s1.y + 30], [s1.x + sofa.w + 6, s1.y + 56], [s1.x - 22, s1.y + 56]]);
        if (r) {
          out.props.push({ f: bb, ...r });
          out.restSeats.push({ x: r.x + 8, y: r.y + 9, pose: 'sit_front' });
        }
      }
      const minX = Math.min(...out.props.map((p) => p.x)) - 6;
      const maxX = Math.max(...out.props.map((p) => p.x + p.w)) + 6;
      out.rugs.push({ x: minX, y: s1.y + 10, w: maxX - minX, h: Math.min(Y + H - 8, s1.y + 92) - (s1.y + 10), color: spec.rug });
      // Free aisle beside the seating group: resting employees enter/leave the sofas along it instead of walking
      // through furniture. It is reserved so no later furniture is placed on it.
      const aisleX = maxX + 8 <= X + W - 10 ? maxX + 8 : minX - 8;
      occ.push({ x: aisleX - 6, y: s1.y - 4, w: 12, h: Y + H - s1.y });
      for (const seat of out.restSeats) seat.aisleX = aisleX;
    }
  }

  // ---- startup lounge: coffee corner on the left, game corner on the right ----
  if (spec.startup) {
    const bar = tryAt('coffee_bar', xs(size('coffee_bar').w, 'left').map((x) => [x, backY('coffee_bar')]));
    if (bar) {
      out.props.push({ f: 'coffee_bar', ...bar });
      out.ambient.push({ type: 'steam', x: bar.x + 10, y: bar.y });
      for (let i = 0; i < 3; i++) {
        const st = tryAt('bar_stool', [[bar.x + 8 + i * 16, bar.y + bar.h + 3]]);
        if (st) out.props.push({ f: 'bar_stool', ...st });
      }
      const fridge = tryAt('drink_fridge', [[bar.x + bar.w + 4, backY('drink_fridge')]]);
      if (fridge) out.props.push({ f: 'drink_fridge', ...fridge });
      const cart = tryAt('ob_cart', xs(size('ob_cart').w, 'left').filter((x) => x >= (fridge || bar).x + (fridge || bar).w + 4).map((x) => [x, backY('ob_cart')]));
      if (cart) {
        out.props.push({ f: 'ob_cart', ...cart });
        out.spots.station = { x: cart.x + Math.round(cart.w / 2), y: cart.y + cart.h + 8 };
      }
      out.spots.coffee = { x: bar.x + bar.w - 6, y: bar.y + bar.h + 8 };
    }
    for (let i = 0; i < 2; i++) {
      const r = tryAt('arcade', xs(size('arcade').w, 'right').map((x) => [x, backY('arcade')]));
      if (r) {
        out.props.push({ f: 'arcade', ...r });
        out.ambient.push({ type: 'arcade', x: r.x, y: r.y });
      }
    }
    // Game tables keep 18 px of free floor on both short sides: that is where the two players stand.
    for (const f of ['pingpong', 'foosball']) {
      const s = size(f);
      const M = 18;
      const cands = [];
      for (const y of ys(s.h)) for (const x of xs(s.w + 2 * M, 'right')) cands.push([x, y]);
      const r = tryAt(f, cands, { top: Y + 4 * T + 4, size: { w: s.w + 2 * M, h: s.h } });
      if (r) out.props.push({ f, x: r.x + M, y: r.y, w: s.w, h: s.h });
    }
  }

  // ---- against the wall ----
  for (const [f, side] of spec.back) {
    const s = size(f);
    if (!s.w) continue;
    const bottomY = Y + 4 * T - 2 - s.h;
    const topY = Y + 2 * T + 1;
    const cands = [];
    for (const x of xs(s.w, side)) cands.push([x, bottomY]);
    if (s.h <= 22) for (const x of xs(s.w, side)) cands.push([x, topY]);
    const r = tryAt(f, cands);
    if (r) {
      place(f, r);
      // Small offices: the office boy makes coffee at the coffee machine of the pantry.
      if (f === 'coffee_machine' && !out.spots.coffee) out.spots.coffee = { x: r.x + Math.round(r.w / 2), y: r.y + r.h + 8 };
    }
  }
  if (out.spots.coffee && !out.spots.station) out.spots.station = { x: out.spots.coffee.x + 18, y: out.spots.coffee.y + 6 };

  // ---- free-standing ----
  for (const [f, side] of spec.floor) {
    if (f === 'workstation') {
      // Extra (unassigned) workstation: desk + dual monitors + chair, all furniture.
      const ds = size('desk_dev');
      const cands = [];
      for (const y of ys(ds.h + 22)) for (const x of xs(ds.w, side)) cands.push([x, y + 8]);
      const r = tryAt('desk_dev', cands, { size: { w: ds.w, h: ds.h + 22 } });
      if (r) {
        out.props.push({ f: 'desk_dev', x: r.x, y: r.y, w: ds.w, h: ds.h });
        out.extras.push({ f: 'monitor_off', x: r.x + 1, y: r.y - 6 }, { f: 'monitor_off', x: r.x + 17, y: r.y - 6 }, { f: 'chair', x: r.x + 9, y: r.y + 19 });
      }
      continue;
    }
    const s = size(f);
    if (!s.w) continue;
    const cands = [];
    for (const y of ys(s.h)) for (const x of xs(s.w, side)) cands.push([x, y]);
    const r = tryAt(f, cands, { top: Y + 4 * T - 4 });
    if (r) place(f, r);
  }

  // ---- rugs under the main furniture group ----
  if (spec.rug && !spec.lounge) {
    const color = spec.rug === 'biz' ? RUG_COLORS[rugIndex % 3] : spec.rug;
    if (scene.meeting?.room === room) {
      const t = scene.meeting.table;
      out.rugs.push({ x: t.x - 12, y: t.y - 14, w: t.w + 24, h: t.h + 30, color });
    } else {
      const ds = scene.desks.filter((d) => d.room === room);
      if (ds.length) {
        const x0 = Math.min(...ds.map((d) => d.x)) - 10;
        const x1 = Math.max(...ds.map((d) => d.x + d.w)) + 10;
        const y0 = Math.min(...ds.map((d) => d.y)) + 6;
        const y1 = Math.max(...ds.map((d) => d.y)) + 46;
        out.rugs.push({ x: x0, y: y0, w: x1 - x0, h: Math.min(y1, Y + H - 8) - y0, color });
      }
    }
  }

  // ---- items on the meeting table (projector, laptops, water) ----
  if (scene.meeting?.room === room) {
    const t = scene.meeting.table;
    out.extras.push({ f: 'projector', x: Math.round(t.x + t.w / 2 - 7), y: t.y + 12 });
    for (const seat of scene.meeting.seats) {
      if (seat.pose === 'sit_front') out.extras.push({ f: 'laptop', x: seat.x - 5, y: t.y + 3 });
      else out.extras.push({ f: 'water_bottle', x: seat.x + 6, y: t.y + t.h - 10 });
    }
  }
  return out;
}

function finishScene(base, extra, size) {
  const scene = { ...base, ...extra, hallX: T };
  const walls = [];
  const props = [];
  const rugs = [];
  const ambient = [];
  const extras = [];
  const restSeats = [];
  const spots = { coffee: null, station: null, pool: [] };
  scene.pool = null;
  scene.rooms.forEach((r, i) => {
    r.door = door(r);
    r.wall = r.wallStyle || WALL_STYLE[r.key] || 'cream';
  });
  scene.rooms.forEach((r, i) => {
    const f = furnish(scene, r, size, i + (scene.business?.id || 0));
    r.sign = f.sign;
    walls.push({ room: r, deco: f.wallDeco, occ: f.wallOcc });
    props.push(...f.props);
    rugs.push(...f.rugs);
    ambient.push(...f.ambient);
    extras.push(...f.extras);
    restSeats.push(...f.restSeats.map((s) => ({ ...s, room: r })));
    for (const k of ['coffee', 'station']) if (f.spots[k] && !spots[k]) spots[k] = { ...f.spots[k], room: r };
    for (const p of f.spots.pool || []) spots.pool.push({ ...p, room: r });
    if (f.pool) scene.pool = { ...f.pool, room: r };
  });
  // Office boys (decoration): HQ has three, every business office one. They start at their cart / the pantry.
  scene.spots = spots;
  scene.npcs = (scene.business ? [OFFICE_BOYS[3]] : OFFICE_BOYS.slice(0, 3)).map((n) => ({ ...n }));
  // Server racks blink (ambient) — they are static furniture plus a dynamic LED overlay.
  for (const p of props) if (p.f === 'server_rack') ambient.push({ type: 'rack', x: p.x, y: p.y });
  scene.yard = buildYard(scene.mapW, size, { title: scene.business?.name || 'AI Virtual Holding', motorCols: scene.business ? 7 : 10 });
  ambient.push(...scene.yard.trees);
  Object.assign(scene, { walls, props, rugs, ambient, extras, restSeats });
  scene.collisions = () => findCollisions(scene);
  return scene;
}

// Debug/acceptance helper: overlapping objects (should always be empty).
export function findCollisions(scene) {
  const items = [
    ...scene.props.map((p) => ({ name: p.f, r: p })),
    ...scene.ambient.filter((a) => a.type === 'plant').map((a) => ({ name: a.f, r: { x: a.x, y: a.y, w: a.w ?? (a.f === 'plant_big' ? 16 : 12), h: a.h ?? (a.f === 'plant_big' ? 28 : 14) } })),
    ...(scene.yard ? [...scene.yard.objects.map((o) => ({ name: `yard:${o.f}`, r: o })), { name: 'yard:sign', r: scene.yard.sign }] : []),
    ...(scene.pool ? [{ name: 'pool', r: scene.pool }] : []),
    ...[...scene.desks, ...scene.visitorDesks].map((d) => ({ name: `desk:${d.owner ?? '-'}`, r: { x: d.x - 1, y: d.y - 6, w: d.w + 2, h: 40 } })),
  ];
  const out = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (overlap(items[i].r, items[j].r, 0)) out.push(`${items[i].name} × ${items[j].name}`);
  for (const w of scene.walls) {
    for (let i = 0; i < w.occ.length; i++) for (let j = i + 1; j < w.occ.length; j++) if (overlap(w.occ[i], w.occ[j], 0)) out.push(`wall:${w.room.key}`);
  }
  return out;
}

// ---------- HQ ----------
// opts.aspect: canvas width/height; the map is laid out to that ratio (default: 64 tiles wide).
export function buildHQScene(data, size, opts = {}) {
  const active = (e) => e.state !== 'off';
  const emps = data.employees.filter(active);
  const ceo = emps.find((e) => e.is_manager);
  const managers = emps.filter((e) => !e.is_manager && (e.role_key === 'business_manager' || e.manages_business_id));
  // Central team (shared services + any other non-business role): one Open Space, grouped by function.
  const team = emps.filter((e) => e.org_unit !== 'business' && !e.is_manager && !managers.includes(e)).sort((a, b) => roleRank(a) - roleRank(b) || a.id - b.id);
  const bizColor = new Map(data.businesses.map((b) => [b.id, b.color]));
  const empById = new Map(data.employees.map((e) => [e.id, e]));
  const flagOf = (id) => {
    const e = empById.get(id);
    const bid = e?.manages_business_id ?? e?.business_ids?.[0];
    return bid ? bizColor.get(bid) : null;
  };

  // Startup HQ: no department rooms. Glass meeting room, an Open Space for the whole central team, a lounge with a
  // coffee corner and a game corner, and a swimming pool.
  const R = (key, name, w, extra) => ({ key, name, w, floor: 'wood', tint: null, kind: 'desks', cols: 2, deskCount: 0, ...extra });
  const makeBands = () => [
    [
      R('ceo', 'CEO Office', 11, { floor: 'parquet', tint: '#8a6fb0', cols: 1, deskCount: ceo ? 1 : 0, exec: true }),
      R('meeting', 'Meeting Room', 15, { floor: 'tile', kind: 'meeting', minH: 11, tint: '#4f6d8a' }),
      R('bm', 'Business Managers', 18, { floor: 'concrete', tint: '#5b7fbf', cols: 3, deskCount: managers.length }),
    ],
    [
      R('open', 'Open Space', 44, { floor: 'concrete', tint: '#2fa6a0', cols: 8, maxCols: 8, deskCount: team.length }),
    ],
    [
      R('lounge', 'Lounge · Coffee & Game Corner', 26, { floor: 'terrazzo', kind: 'lounge', minH: 11, tint: '#e07a2f', spec: 'startup_lounge', wallStyle: 'concrete' }),
      R('pool', 'Kolam Renang', 18, { floor: 'deck', kind: 'pool', minH: 11, tint: '#45aed6' }),
    ],
  ];
  const base = layoutFor(makeBands, { aspect: opts.aspect, minW: 46, defaultW: 64 });
  const room = (k) => base.rooms.find((r) => r.key === k);
  const roleOf = (id) => empById.get(id)?.role_key;
  const desks = [];
  if (ceo) desks.push(...placeDesks(room('ceo'), [ceo.id], { exec: true }));
  desks.push(...placeDesks(room('bm'), managers.map((e) => e.id), { flagOf, frame: 'desk_bm' }));
  desks.push(...placeDesks(room('open'), team.map((e) => e.id), {
    frameOf: (id) => ROLE_DESK[roleOf(id)],
    dualOf: (id) => roleOf(id) === 'developer',
    flagOf: (id) => (roleOf(id) === 'marketing' ? flagOf(id) : null),
  }));
  const meeting = makeMeeting(room('meeting'), { scope: 'hq', business_id: null });
  return finishScene(base, {
    id: 'hq',
    title: 'Kantor Pusat (Holding)',
    desks,
    deskByOwner: new Map(desks.map((d) => [d.owner, d])),
    meeting,
    visitorDesks: [],
    visitorFilter: () => false,
    entrance: { x: T, y: YARD_H * T + 8 }, // main door at the top of the hallway (front yard side)
  }, size);
}

// ---------- business office ----------
export function buildBusinessScene(data, business, size, opts = {}) {
  const emps = data.employees.filter((e) => e.state !== 'off');
  const manager = emps.find((e) => e.id === business.manager_employee_id) || null;
  const staff = emps.filter((e) => e.id !== manager?.id && e.business_ids?.includes(business.id) && e.org_unit === 'business');
  const assignedShared = emps.filter((e) => e.org_unit === 'shared' && e.business_ids?.includes(business.id));
  const empById = new Map(data.employees.map((e) => [e.id, e]));
  const tint = business.color || '#3b82f6';
  const makeBands = () => [
    [
      { key: 'manager', name: `Ruang Manager · ${business.name}`, w: 11, kind: 'desks', cols: 1, deskCount: 1, exec: true, floor: 'carpet', tint },
      { key: 'workspace', name: `Area Kerja Tim · ${business.name}`, w: 27, kind: 'desks', cols: 4, deskCount: Math.max(1, staff.length + assignedShared.length), floor: 'wood', tint },
    ],
    [
      { key: 'meeting', name: 'Ruang Rapat Bisnis', w: 14, kind: 'meeting', minH: 11, floor: 'tile', tint: '#4f6d8a' },
      { key: 'guests', name: 'Hot Desk Tamu', w: 12, kind: 'desks', cols: 2, deskCount: 3, floor: 'warm', tint: '#64748b' },
      { key: 'lounge', name: 'Pantry', w: 12, kind: 'lounge', minH: 10, floor: 'parquet', tint: '#5f9e54' },
    ],
  ];
  const base = layoutFor(makeBands, { aspect: opts.aspect, minW: 40, defaultW: 56 });
  const room = (k) => base.rooms.find((r) => r.key === k);
  const desks = [];
  // Manager desk exists even without a manager (shown empty) so the office still reads as a business.
  desks.push(...placeDesks(room('manager'), [manager?.id ?? null], { exec: true, flagOf: () => tint }));
  desks.push(...placeDesks(room('workspace'), [...staff, ...assignedShared].map((e) => e.id), { frameOf: (id) => ROLE_DESK[empById.get(id)?.role_key] }));
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
    entrance: { x: T, y: YARD_H * T + 8 }, // main door at the top of the hallway (front yard side)
  }, size);
}

// Layout signature: rebuild the scene only when the roster/structure changes (not on every state change).
export function sceneKey(data, sceneId) {
  return JSON.stringify([
    sceneId,
    data.businesses.map((b) => [b.id, b.status, b.color, b.name, b.manager_employee_id, b.has_logo]),
    data.employees.map((e) => [e.id, e.org_unit, e.role_key, e.state === 'off', e.business_ids, e.manages_business_id]),
  ]);
}
