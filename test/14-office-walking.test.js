// Walking in the virtual office never goes through walls or furniture.
// Every route (desk to desk across rooms, to the coffee bar stools, sofas, arcade, game tables, the pool, the office
// boys' work spots, and out of the pool) is sampled every 2 px: each point must be on free floor inside a room, in a
// door opening, in a corridor or in the hallway; inside rooms the feet never touch a piece of furniture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildHQScene, buildBusinessScene, T } from '../public/js/office/scenes.js';
import { OfficeEngine } from '../public/js/office/engine.js';

const atlas = JSON.parse(fs.readFileSync(new URL('../public/assets/office-atlas.json', import.meta.url), 'utf8'));
const size = (name) => atlas.frames[name] || { w: 0, h: 0 };

function makeData({ businesses = 3, staffPerBiz = 3, extraShared = 2 } = {}) {
  const employees = [];
  const biz = [];
  let id = 1;
  const emp = (o) => employees.push({ id: id++, name: `E${id}`, state: 'idle', avatar: {}, business_ids: [], manages_business_id: null, is_manager: false, ...o }) && employees.at(-1);
  emp({ role_key: 'ceo', org_unit: 'holding', is_manager: true });
  for (const r of ['group_finance', 'secretary', 'researcher', 'developer', 'hr']) emp({ role_key: r, org_unit: 'shared' });
  for (let i = 0; i < extraShared; i++) emp({ role_key: 'analyst', org_unit: 'shared' });
  for (let b = 1; b <= businesses; b++) {
    const m = emp({ role_key: 'business_manager', org_unit: 'holding', manages_business_id: b, business_ids: [b] });
    biz.push({ id: b, name: `Bisnis ${b}`, color: '#16a34a', status: 'active', manager_employee_id: m.id, has_logo: false });
    for (let s = 0; s < staffPerBiz; s++) emp({ role_key: s === 0 ? 'marketing' : 'operations', org_unit: 'business', business_ids: [b] });
  }
  return { employees, businesses: biz, queue: { paused: false } };
}

// Engine without a browser: only the walking logic is used (grids, routes, leisure spots).
function engineFor(scene) {
  const canvas = { getContext: () => ({}), addEventListener() {}, style: {} };
  const e = new OfficeEngine(canvas, { atlas: { size, draw() {} } });
  e.scene = scene;
  e.grids = new Map();
  e.leisureCache = null;
  return e;
}

function furniture(scene) {
  const list = [
    ...scene.props.map((p) => ({ f: p.f, x: p.x, y: p.y, w: p.w, h: p.h })),
    ...scene.ambient.filter((a) => a.type === 'plant').map((a) => ({ f: a.f, x: a.x, y: a.y, w: a.w ?? size(a.f).w, h: a.h ?? size(a.f).h })),
    ...scene.extras.filter((x) => x.f !== 'pool_ladder').map((x) => ({ f: x.f, ...size(x.f), x: x.x, y: x.y })),
    ...[...scene.desks, ...scene.visitorDesks].map((d) => ({ f: `desk:${d.owner}`, x: d.x, y: d.y, w: d.w, h: 20 })),
  ];
  if (scene.meeting) list.push({ f: 'meeting_table', ...scene.meeting.table });
  if (scene.pool) list.push({ f: 'pool', x: scene.pool.x, y: scene.pool.y, w: scene.pool.w, h: scene.pool.h });
  return list;
}

function where(scene, p, swimming) {
  const q = scene.pool;
  if (swimming && q && p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y - 26 && p.y <= q.y + q.h) return 'pool';
  for (const r of scene.rooms) {
    const x0 = r.x * T;
    const x1 = (r.x + r.w) * T;
    const y1 = (r.y + r.h) * T;
    if (p.x >= x0 + 5 && p.x <= x1 - 5 && p.y >= (r.y + 2) * T && p.y <= y1 - 4) return 'room';
    if (Math.abs(p.x - r.door.x) <= T - 4 && p.y >= y1 - 12 && p.y <= r.door.corridorY + 1) return 'door';
  }
  for (const k of scene.corridors) if (p.y >= k.y * T + 4 && p.y <= (k.y + k.h) * T - 4 && p.x >= 4 && p.x <= scene.mapW * T - 4) return 'corridor';
  if (p.x >= 4 && p.x <= 2 * T - 4 && p.y >= scene.yard.h && p.y <= scene.mapH * T) return 'hall';
  return null;
}

// Walk the path and report the first illegal point. The first 14 px and the last 22 px may touch furniture (getting up from a
// desk chair, sitting down on a stool or sofa).
function check(scene, label, from, path, { swimming = false } = {}) {
  const items = furniture(scene);
  const pts = [];
  let a = from;
  for (const b of path) {
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    assert.ok(Math.abs(b.x - a.x) < 0.5 || Math.abs(b.y - a.y) < 0.5, `${label}: diagonal step ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    for (let d = 0; d < len; d += 2) pts.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
    a = b;
  }
  pts.push(a);
  let walked = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i) walked += Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y);
    const left = pts.length - 1 - i;
    if (walked < 14 || left * 2 < 22) continue;
    const zone = where(scene, p, swimming);
    assert.ok(zone, `${label}: (${Math.round(p.x)}, ${Math.round(p.y)}) is inside a wall`);
    if (zone !== 'room') continue;
    const feet = { x: p.x - 4, y: p.y - 2, w: 8, h: 3 };
    const hit = items.find((o) => feet.x < o.x + o.w && feet.x + feet.w > o.x && feet.y < o.y + o.h && feet.y + feet.h > o.y);
    assert.equal(hit, undefined, `${label}: walks through ${hit?.f} at (${Math.round(p.x)}, ${Math.round(p.y)})`);
  }
}

function scenarios(scene) {
  const e = engineFor(scene);
  const L = e.leisureSpots();
  const seats = scene.desks.map((d) => ({ x: d.seat.x, y: d.seat.y, label: `desk ${d.owner}` }));
  const spots = [
    ...L.stools.map((s) => ({ ...s, label: 'stool' })),
    ...L.sofas.map((s) => ({ ...s, label: 'sofa' })),
    ...L.arcades.map((s) => ({ ...s, label: 'arcade' })),
    ...L.tables.flatMap((t) => t.ends.map((s) => ({ ...s, label: t.kind }))),
    ...(L.poolEntry ? [{ ...L.poolEntry, label: 'pool entry' }] : []),
    ...['coffee', 'station'].filter((k) => scene.spots[k]).map((k) => ({ ...e.snap(scene.spots[k]), label: `ob ${k}` })),
    ...scene.spots.pool.map((p) => ({ ...e.snap(p), label: 'ob pool' })),
    ...scene.desks.map((d) => ({ ...d.stand, label: `stand ${d.owner}` })),
  ];
  return { e, L, seats, spots };
}

for (const [name, build] of [
  ['HQ', (d) => buildHQScene(d, size)],
  ['HQ wide', (d) => buildHQScene(d, size, { aspect: 2.4 })],
  ['business office', (d) => buildBusinessScene(d, d.businesses[0], size)],
]) {
  test(`${name}: routes between desks, lounge, games and pool never cross walls or furniture`, () => {
    const scene = build(makeData());
    const { e, L, seats, spots } = scenarios(scene);
    if (scene.id === 'hq') {
      assert.ok(L.stools.length >= 2 && L.arcades.length >= 1 && L.tables.length >= 1 && L.poolEntry, 'HQ leisure spots are reachable');
    }
    assert.ok(L.sofas.length >= 1, 'at least one sofa seat / bean bag is reachable');
    // Desk to desk (also across rooms through doors, corridors and the hallway).
    for (const a of seats) for (const b of seats.slice(0, 6)) if (a !== b) check(scene, `${a.label} → ${b.label}`, a, e.route(a, b));
    // Every desk to every leisure / office boy spot and back.
    for (const a of seats) {
      for (const s of spots) {
        check(scene, `${a.label} → ${s.label}`, a, e.route(a, s));
        check(scene, `${s.label} → ${a.label}`, s, e.route(s, a));
      }
    }
    // Interrupted while passing through a door opening: back onto the corridor first.
    for (const r of scene.rooms) {
      const p = { x: r.door.x, y: (r.y + r.h) * T + 2 };
      check(scene, `door of ${r.key} → desk`, p, e.route(p, seats[0]));
    }
    // Swimming: into the pool at the ladder, laps, and out again to a desk.
    if (L.poolEntry) {
      const swimmer = { x: L.poolEntry.x, y: scene.pool.y + 6, path: [] };
      const laps = e.swimLaps(swimmer);
      check(scene, 'swim laps', swimmer, laps, { swimming: true });
      for (const q of laps) assert.ok(e.inPool(q), 'laps stay in the water');
      const end = laps.at(-1);
      check(scene, 'out of the pool', end, e.routeFrom(end, seats[0]), { swimming: true });
    }
  });
}
