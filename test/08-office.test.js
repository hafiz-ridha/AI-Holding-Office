// Pixel office data integration: every visual state must come from real queue/task data (no fake activity).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let app, s, q, worker, tasks, mock, settings;
async function waitFor(fn, ms = 10000, step = 20) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('timeout');
}

before(async () => {
  await setupEnv();
  mock = await startMockProvider({ delayMs: 400 });
  ({ q } = await import('../src/db/index.js'));
  ({ worker } = await import('../src/queue/worker.js'));
  tasks = await import('../src/queue/tasks.js');
  settings = await import('../src/lib/settings.js');
  app = await buildTestApp();
  s = await login(app);
  await s.post('/api/providers', { preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 50 });
});
after(async () => {
  await worker.stop(1000);
  await app?.close();
  await mock?.close();
});

const office = async () => (await s.get('/api/office')).json();
const byName = (o, name, bizId) => o.employees.find((e) => e.name === name && (!bizId || e.business_ids.includes(bizId) || e.manages_business_id === bizId));

test('idle office: nobody is shown working without a running AI call', async () => {
  const o = await office();
  assert.ok(o.employees.every((e) => e.state === 'idle'), JSON.stringify(o.employees.map((e) => e.state)));
  assert.ok(o.businesses.every((b) => 'active_tasks' in b && 'manager_employee_id' in b));
});

test('business task: BM thinking -> staff working -> business meeting (leader + contributor) -> completed', async () => {
  const coffee = q.get("SELECT * FROM businesses WHERE slug = 'coffee'");
  const seen = { Kirana: new Set(), Maya: new Set() };
  const t = tasks.createTask({ kind: 'business', title: 'Promo', description: 'Rencana', businessId: coffee.id, employeeId: coffee.manager_employee_id });
  await waitFor(async () => {
    const o = await office();
    for (const n of ['Kirana', 'Maya']) {
      const e = byName(o, n, coffee.id);
      seen[n].add(e.meeting ? `${e.state}@${e.meeting.scope}:${e.meeting.business_id}:${e.meeting.leader}` : e.state);
    }
    return tasks.getTask(t.id).status === 'completed' && seen.Kirana.has('completed');
  });
  assert.ok(seen.Kirana.has('thinking'), [...seen.Kirana].join());
  assert.ok(seen.Kirana.has(`meeting@business:${coffee.id}:true`), [...seen.Kirana].join());
  assert.ok(seen.Maya.has('working'), [...seen.Maya].join());
  assert.ok(seen.Maya.has(`meeting@business:${coffee.id}:false`), [...seen.Maya].join());
  // Finished: only the short COMPLETED window, then back to idle (no lingering "work").
  const o = await office();
  assert.ok(['completed', 'idle'].includes(byName(o, 'Maya', coffee.id).state));
});

test('holding synthesis meeting happens in HQ and shared services working for a business are marked as visiting', async () => {
  const seenCeo = new Set();
  let visiting = null;
  const root = tasks.createTask({ kind: 'instruction', title: 'Review biaya', description: 'WITH_SHARED', employeeId: q.get('SELECT id FROM employees WHERE is_manager = 1').id });
  await waitFor(async () => {
    const o = await office();
    const ceo = o.employees.find((e) => e.is_manager);
    seenCeo.add(ceo.meeting ? `${ceo.state}@${ceo.meeting.scope}` : ceo.state);
    const gf = o.employees.find((e) => e.role_key === 'group_finance');
    if (gf.state === 'working' && gf.visiting_business_id) visiting = gf.visiting_business_id;
    return tasks.getTask(root.id).status === 'completed';
  }, 20000);
  assert.ok(seenCeo.has('thinking'));
  assert.ok(seenCeo.has('meeting@hq'));
  assert.equal(visiting, q.get("SELECT id FROM businesses WHERE slug = 'wins-court'").id);
});

test('error state comes from real failures/postponed tasks and is cleared by success', async () => {
  const p = (await s.get('/api/providers')).json()[0];
  await s.put(`/api/providers/${p.id}`, { default_model: 'fail-model', max_retries: 0 });
  const dev = q.get("SELECT id FROM employees WHERE slug = 'developer'").id;
  const t = tasks.createTask({ kind: 'direct', title: 'Akan gagal', employeeId: dev });
  await waitFor(() => tasks.getTask(t.id).status === 'pending' && tasks.getTask(t.id).attempts === 1);
  let o = await office();
  const e = o.employees.find((x) => x.id === dev);
  assert.equal(e.state, 'error');
  assert.match(e.reason, /AI tidak tersedia/);
  tasks.cancelTask(t.id);
  await s.put(`/api/providers/${p.id}`, { default_model: 'ok-model' });
  o = await office();
  assert.notEqual(o.employees.find((x) => x.id === dev).state, 'error', 'cancelled postponed task no longer shows as error');
});

test('employee panel endpoint: businesses, tasks, provider/model, token usage, last result', async () => {
  const maya = q.get("SELECT e.id FROM employees e JOIN business_employees be ON be.employee_id = e.id JOIN businesses b ON b.id = be.business_id WHERE e.name = 'Maya' AND b.slug = 'coffee'");
  const d = (await s.get(`/api/office/employees/${maya.id}`)).json();
  assert.equal(d.employee.name, 'Maya');
  assert.deepEqual(d.businesses.map((b) => b.name), ['Coffee Business']);
  assert.ok(d.recent_tasks.length >= 1);
  assert.equal(d.recent_tasks[0].model_used, 'ok-model');
  assert.ok(d.usage.total.tokens_in + d.usage.total.tokens_out > 0);
  assert.equal(d.last_ai_call.model, 'ok-model');
  assert.equal(d.configured_model.model, 'ok-model');
  assert.ok(d.last_result.excerpt.length > 0);
  assert.equal((await s.get('/api/office/employees/99999')).statusCode, 404);
});

test('meeting room endpoint: coordination history per scope, isolated by business', async () => {
  const coffee = q.get("SELECT id FROM businesses WHERE slug = 'coffee'").id;
  const wins = q.get("SELECT id FROM businesses WHERE slug = 'wins-court'").id;
  const c = (await s.get(`/api/office/coordination?business_id=${coffee}`)).json();
  assert.equal(c.scope, 'business');
  assert.ok(c.recent.some((r) => r.event === 'planned' || r.event === 'synthesizing'));
  assert.ok(c.recent.every((r) => q.get('SELECT business_id FROM tasks WHERE id = ?', r.task_id).business_id === coffee));
  const hq = (await s.get('/api/office/coordination')).json();
  assert.equal(hq.scope, 'hq');
  assert.ok(hq.recent.every((r) => q.get('SELECT kind FROM tasks WHERE id = ?', r.task_id).kind === 'instruction'));
  const w = (await s.get(`/api/office/coordination?business_id=${wins}`)).json();
  assert.ok(w.recent.every((r) => q.get('SELECT business_id FROM tasks WHERE id = ?', r.task_id).business_id === wins));
});

test('a newly added business appears in the office data without code changes', async () => {
  const b = (await s.post('/api/businesses', { name: 'Bakery Baru', industry: 'F&B', color: '#d97706' })).json();
  const o = await office();
  const found = o.businesses.find((x) => x.id === b.id);
  assert.equal(found.name, 'Bakery Baru');
  assert.equal(found.status, 'active');
});

test('sprite sheet asset is a small valid PNG with a matching frame map', () => {
  const png = fs.readFileSync(new URL('../public/assets/office-atlas.png', import.meta.url));
  const meta = JSON.parse(fs.readFileSync(new URL('../public/assets/office-atlas.json', import.meta.url), 'utf8'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.length < 32 * 1024, `atlas too big: ${png.length}`);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  assert.equal(w, meta.width);
  assert.equal(h, meta.height);
  for (const f of ['desk', 'monitor_on_0', 'chair', 'bub_think', 'bub_warn', 'bub_check', 'sofa_blue', 'server_rack', 'wall_window', 'tbl_c']) {
    const fr = meta.frames[f];
    assert.ok(fr && fr.x + fr.w <= w && fr.y + fr.h <= h, `frame ${f}`);
  }
  // Decompresses cleanly.
  let off = 8;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    if (png.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  assert.equal(zlib.inflateSync(Buffer.concat(idat)).length, (w * 4 + 1) * h);
  assert.ok(settings);
});
