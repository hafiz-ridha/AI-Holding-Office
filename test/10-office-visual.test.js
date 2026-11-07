// Office visual layer (v2): scene generation is pure JS, so layout rules can be checked without a browser.
// Acceptance: no overlapping furniture/desks, every room has wallpaper + sign + door, lounge seats are reachable via a
// free aisle, desks keep the same owners/positions regardless of decoration, and nothing depends on screen size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildHQScene, buildBusinessScene, findCollisions, T } from '../public/js/office/scenes.js';
import atlasModule from '../public/js/office/atlas-data.js';

const atlas = JSON.parse(fs.readFileSync(new URL('../public/assets/office-atlas.json', import.meta.url), 'utf8'));
const size = (name) => atlas.frames[name] || { w: 0, h: 0 };

test('frame map module (loaded by the app) matches the JSON and the PNG it versions', () => {
  // The app loads atlas-data.js together with its code; a stale or mismatched map made the front yard invisible.
  assert.deepEqual(atlasModule, atlas);
  const png = fs.readFileSync(new URL('../public/assets/office-atlas.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), atlasModule.width);
  assert.equal(png.readUInt32BE(20), atlasModule.height);
  // The PNG URL version is the content hash, so a changed image always gets a new URL.
  assert.equal(atlasModule.version, crypto.createHash('sha1').update(png).digest('hex').slice(0, 12));
});

function makeData({ businesses = 3, staffPerBiz = 2, shared = ['group_finance', 'secretary', 'researcher', 'developer', 'hr'], extraShared = 0 } = {}) {
  const employees = [];
  const biz = [];
  let id = 1;
  const emp = (o) => {
    const e = { id: id++, name: `E${id}`, state: 'idle', avatar: {}, business_ids: [], manages_business_id: null, is_manager: false, ...o };
    employees.push(e);
    return e;
  };
  emp({ role_key: 'ceo', org_unit: 'holding', is_manager: true });
  for (const r of shared) emp({ role_key: r, org_unit: 'shared' });
  for (let i = 0; i < extraShared; i++) emp({ role_key: 'analyst', org_unit: 'shared' });
  for (let b = 1; b <= businesses; b++) {
    const m = emp({ role_key: 'business_manager', org_unit: 'holding', manages_business_id: b, business_ids: [b] });
    biz.push({ id: b, name: `Bisnis ${b}`, color: ['#16a34a', '#b45309', '#2563eb'][b % 3], status: 'active', manager_employee_id: m.id, has_logo: false });
    for (let s = 0; s < staffPerBiz; s++) emp({ role_key: s === 0 ? 'marketing' : 'operations', org_unit: 'business', business_ids: [b] });
  }
  return { employees, businesses: biz, queue: { paused: false } };
}

function checkScene(scene) {
  assert.deepEqual(findCollisions(scene), [], `${scene.id}: overlapping objects`);
  const W = scene.mapW * T;
  const H = scene.mapH * T;
  for (const r of scene.rooms) {
    assert.ok(r.wall, `${scene.id}/${r.key}: wallpaper style`);
    assert.ok(r.sign && r.sign.w > 20, `${scene.id}/${r.key}: sign plank`);
    assert.ok(r.sign.x + r.sign.w <= (r.x + r.w) * T, `${scene.id}/${r.key}: sign inside the room`);
    assert.ok(r.door && r.door.x > r.x * T && r.door.x < (r.x + r.w) * T, `${scene.id}/${r.key}: door inside the room`);
  }
  // Every static object lies inside the map and inside exactly the room it was generated for.
  for (const p of scene.props) {
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= W && p.y + p.h <= H, `${scene.id}: ${p.f} inside the map`);
    const room = scene.rooms.find((r) => p.x >= r.x * T && p.x + p.w <= (r.x + r.w) * T && p.y >= r.y * T && p.y + p.h <= (r.y + r.h) * T);
    assert.ok(room, `${scene.id}: ${p.f} at ${p.x},${p.y} fully inside one room`);
  }
  // Lounge: real seats with an aisle that is not blocked by furniture.
  assert.ok(scene.restSeats.length >= 2, `${scene.id}: lounge seats`);
  for (const s of scene.restSeats) {
    assert.ok(typeof s.aisleX === 'number', `${scene.id}: seat has an aisle`);
    const lane = { x: s.aisleX - 4, y: s.y, w: 8, h: (s.room.y + s.room.h) * T - s.y - 8 };
    const hit = scene.props.find((p) => lane.x < p.x + p.w && lane.x + lane.w > p.x && lane.y < p.y + p.h && lane.y + lane.h > p.y);
    assert.equal(hit, undefined, `${scene.id}: aisle at x=${s.aisleX} blocked by ${hit?.f}`);
  }
  // Ambient objects come from real furniture (plants, clocks, racks, status panel) only.
  for (const a of scene.ambient) assert.ok(['plant', 'clock', 'rack', 'panel'].includes(a.type));
}

test('HQ and business offices have no overlapping objects (default holding)', () => {
  const data = makeData();
  checkScene(buildHQScene(data, size));
  for (const b of data.businesses) checkScene(buildBusinessScene(data, b, size));
});

test('layouts stay collision-free with many businesses and staff', () => {
  const data = makeData({ businesses: 8, staffPerBiz: 9, extraShared: 7 });
  checkScene(buildHQScene(data, size));
  for (const b of data.businesses.slice(0, 3)) checkScene(buildBusinessScene(data, b, size));
});

test('layouts stay collision-free for an almost empty holding', () => {
  const data = makeData({ businesses: 1, staffPerBiz: 0, shared: [] });
  checkScene(buildHQScene(data, size));
  checkScene(buildBusinessScene(data, data.businesses[0], size));
});

test('every employee keeps one desk; decoration does not move desks', () => {
  const data = makeData({ businesses: 3, staffPerBiz: 3 });
  const hq = buildHQScene(data, size);
  const owners = hq.desks.map((d) => d.owner);
  assert.equal(new Set(owners).size, owners.length, 'one desk per employee');
  const notBizStaff = data.employees.filter((e) => e.org_unit !== 'business');
  for (const e of notBizStaff) assert.ok(hq.deskByOwner.has(e.id), `HQ desk for ${e.role_key}`);
  // Same data -> identical desk coordinates (deterministic, independent of screen size).
  const again = buildHQScene(data, size);
  assert.deepEqual(again.desks.map((d) => [d.owner, d.x, d.y]), hq.desks.map((d) => [d.owner, d.x, d.y]));
  const biz = buildBusinessScene(data, data.businesses[0], size);
  for (const e of data.employees.filter((x) => x.org_unit === 'business' && x.business_ids.includes(1))) assert.ok(biz.deskByOwner.has(e.id));
});

test('atlas contains every frame the scenes and renderer reference', () => {
  const data = makeData();
  const scenes = [buildHQScene(data, size), buildBusinessScene(data, data.businesses[0], size)];
  const names = new Set(['doormat', 'flag_pole', 'chair', 'exec_chair', 'chair_back_n', 'monitor_off', 'bub_rest', 'ico_ai', 'bub_meet', 'bub_wait', 'bub_check', 'bub_warn']);
  for (const f of ['floor_wood', 'floor_wood_b', 'floor_tile', 'floor_carpet', 'floor_parquet', 'floor_dark', 'floor_warm', 'asphalt', 'paving', 'grass']) names.add(f);
  for (const i of [0, 1]) for (const f of ['monitor_on', 'monitor_term', 'ico_gear', 'sparkle']) names.add(`${f}_${i}`);
  for (const s of scenes) {
    for (const r of s.rooms) names.add(`wall_${r.wall}`).add(`wallwin_${r.wall}`);
    for (const p of s.props) names.add(p.f);
    for (const e of s.extras) names.add(e.f);
    for (const w of s.walls) for (const d of w.deco) names.add(d.f);
    for (const a of s.ambient) if (a.type === 'plant') names.add(a.f).add(`${a.f}_b`);
    for (const d of s.desks) names.add(d.frame);
    for (const rg of s.rugs) for (const piece of ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br']) names.add(`rug_${rg.color}_${piece}`);
    for (const o of [...s.yard.objects, ...s.yard.decals]) names.add(o.f);
  }
  const missing = [...names].filter((n) => !atlas.frames[n]);
  assert.deepEqual(missing, []);
});

test('front yard: parking lot is realistic and stays clear of the building and walkway', () => {
  for (const [label, data, pick] of [['hq', makeData(), (d) => buildHQScene(d, size)], ['biz', makeData(), (d) => buildBusinessScene(d, d.businesses[0], size)]]) {
    const s = pick(data);
    const y = s.yard;
    assert.equal(y.h, s.rooms.reduce((m, r) => Math.min(m, r.y * T), Infinity), `${label}: building starts right below the yard`);
    const cars = y.objects.filter((o) => o.f === 'raptor');
    assert.equal(cars.length, 1, `${label}: exactly one double-cabin pickup`);
    const bikes = y.objects.filter((o) => o.f.startsWith('motor_'));
    assert.ok(bikes.length >= 6, `${label}: several scooters`);
    // Both rows exist (seen from behind on the far row, from the front on the near row).
    assert.ok(bikes.some((b) => b.f.startsWith('motor_r_')) && bikes.some((b) => b.f.startsWith('motor_f_')));
    for (const o of y.objects) {
      assert.ok(o.y + o.h <= y.h, `${label}: ${o.f} stays in the yard`);
      assert.ok(o.x >= y.entry.x + y.entry.w || o.y + o.h <= y.lot.y, `${label}: ${o.f} keeps the entrance walkway free`);
      if (o.vehicle) assert.ok(o.y >= y.lot.y - 10 && o.y + o.h <= y.lot.y + y.lot.h, `${label}: ${o.f} is parked inside the lot`);
    }
    // Nothing stands on the driveway.
    const dw = y.driveway;
    for (const o of [...y.objects.filter((x) => x.f === 'lamp_post'), ...y.trees.filter((t) => t.y < y.lot.y)]) {
      assert.ok(o.x + o.w <= dw.x || o.x >= dw.x + dw.w, `${label}: ${o.f} not on the driveway`);
    }
    assert.deepEqual(findCollisions(s), []);
  }
});
