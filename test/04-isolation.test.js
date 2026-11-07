// Business data isolation: two test businesses with secret documents, finance, and memories.
// Verifies via the HTTP API and by inspecting every prompt actually sent to the (mock) AI provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let app, s, mock, q, worker, settings;
let alpha, beta, alphaDoc, betaDoc;
const ALPHA_SECRET = 'ALPHA-RAHASIA-77341';
const BETA_SECRET = 'BETA-RAHASIA-99120';

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

const promptsFor = (taskIds) =>
  mock.calls
    .filter((c) => c.url === '/v1/chat/completions')
    .map((c) => c.body.messages.map((m) => m.content).join('\n'))
    .filter((p) => taskIds.some((t) => p.includes(t)));

before(async () => {
  await setupEnv();
  mock = await startMockProvider();
  ({ q } = await import('../src/db/index.js'));
  ({ worker } = await import('../src/queue/worker.js'));
  settings = await import('../src/lib/settings.js');
  app = await buildTestApp();
  s = await login(app);
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 100 });
  const p = await s.post('/api/providers', { preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  assert.equal(p.statusCode, 201, p.body);
});
after(async () => {
  await worker.stop(1000);
  await app?.close();
  await mock?.close();
});

test('create two test businesses with their own staff via the API', async () => {
  const mk = async (name) => {
    const r = await s.post('/api/businesses', { name, industry: 'Uji', description: `Bisnis uji ${name}` });
    assert.equal(r.statusCode, 201, r.body);
    const b = r.json();
    const mgr = (await s.post('/api/employees', { name: `Manager ${name}`, role: 'Business Manager', role_key: 'business_manager', org_unit: 'business', business_ids: [b.id] })).json();
    const fin = (await s.post('/api/employees', { name: `Finance ${name}`, role: 'Finance', role_key: 'finance', org_unit: 'business', business_ids: [b.id] })).json();
    const upd = await s.put(`/api/businesses/${b.id}`, { manager_employee_id: mgr.id });
    assert.equal(upd.statusCode, 200, upd.body);
    return { ...upd.json(), mgr, fin };
  };
  alpha = await mk('Alpha Test');
  beta = await mk('Beta Test');
  assert.equal(alpha.manager.id, alpha.mgr.id);
  assert.notEqual(alpha.slug, beta.slug);
  // The same employee cannot manage two businesses.
  const dup = await s.put(`/api/businesses/${beta.id}`, { manager_employee_id: alpha.mgr.id });
  assert.equal(dup.statusCode, 400);
});

test('documents and finance are stored per business and not visible across businesses', async () => {
  alphaDoc = (await s.post(`/api/businesses/${alpha.id}/documents`, { title: 'Strategi harga Alpha', content: `Harga rahasia ${ALPHA_SECRET} untuk paket premium.` })).json();
  betaDoc = (await s.post(`/api/businesses/${beta.id}/documents`, { title: 'Strategi harga Beta', content: `Harga rahasia ${BETA_SECRET} untuk paket premium.` })).json();
  await s.post(`/api/businesses/${alpha.id}/finance`, { record_date: '2026-11-01', type: 'income', category: 'penjualan', amount: 1234567 });
  await s.post(`/api/businesses/${beta.id}/finance`, { record_date: '2026-11-01', type: 'income', category: 'penjualan', amount: 7654321 });

  const aDocs = (await s.get(`/api/businesses/${alpha.id}/documents`)).json();
  assert.deepEqual(aDocs.map((d) => d.id), [alphaDoc.id]);
  assert.equal((await s.get(`/api/businesses/${beta.id}/documents/${alphaDoc.id}`)).statusCode, 404, 'cannot read Alpha doc through Beta');
  assert.equal((await s.del(`/api/businesses/${beta.id}/documents/${alphaDoc.id}`)).statusCode, 404, 'cannot delete Alpha doc through Beta');

  const search = (await s.get(`/api/businesses/${beta.id}/knowledge/search?q=harga%20rahasia%20premium`)).json();
  assert.ok(search.length >= 1);
  assert.ok(search.every((d) => !d.snippet.includes(ALPHA_SECRET)), 'Beta KB search never returns Alpha content');

  const af = (await s.get(`/api/businesses/${alpha.id}/finance?from=2026-11-01&to=2026-11-30`)).json();
  assert.equal(af.summary.currencies[0].income, 1234567);
  assert.equal(af.records.length, 1);
  assert.equal((await s.del(`/api/businesses/${beta.id}/finance/${af.records[0].id}`)).statusCode, 404, 'cannot delete Alpha record through Beta');
});

test('AI prompts for one business never contain another business\'s data or memories', async () => {
  const gf = q.get("SELECT id FROM employees WHERE slug = 'group-finance'").id;
  const run = async (body) => {
    const r = await s.post('/api/tasks', body);
    assert.equal(r.statusCode, 201, r.body);
    const t = r.json();
    await waitFor(async () => ['completed', 'failed'].includes((await s.get(`/api/tasks/${t.id}`)).json().task.status));
    const d = (await s.get(`/api/tasks/${t.id}`)).json();
    assert.equal(d.task.status, 'completed', d.task.error);
    return t;
  };
  // Business tasks (Business Manager -> staff) for each business, plus the shared Group Finance working for both.
  const tA = await run({ mode: 'business', business_id: alpha.id, title: 'TASKA strategi harga premium', description: 'Gunakan knowledge base harga rahasia premium' });
  const tSA = await run({ mode: 'direct', employee_id: gf, business_id: alpha.id, title: 'TASKSA analisis harga premium', description: 'harga rahasia premium' });
  const tB = await run({ mode: 'business', business_id: beta.id, title: 'TASKB strategi harga premium', description: 'Gunakan knowledge base harga rahasia premium' });
  const tSB = await run({ mode: 'direct', employee_id: gf, business_id: beta.id, title: 'TASKSB analisis harga premium', description: 'harga rahasia premium' });

  const alphaPrompts = promptsFor(['TASKA', 'TASKSA']);
  const betaPrompts = promptsFor(['TASKB', 'TASKSB']);
  assert.ok(alphaPrompts.length >= 3 && betaPrompts.length >= 3);
  assert.ok(alphaPrompts.some((p) => p.includes(ALPHA_SECRET)), 'Alpha prompts do use Alpha knowledge base');
  assert.ok(betaPrompts.some((p) => p.includes(BETA_SECRET)), 'Beta prompts do use Beta knowledge base');
  for (const p of betaPrompts) {
    assert.ok(!p.includes(ALPHA_SECRET), 'Alpha document leaked into Beta prompt');
    assert.ok(!p.includes('1.234.567') && !p.includes('1234567'), 'Alpha finance leaked into Beta prompt');
    assert.ok(!p.includes('TASKA') && !p.includes('TASKSA'), 'Alpha task/memory leaked into Beta prompt');
    assert.ok(!/Alpha Test/.test(p), 'Alpha business name leaked into Beta prompt');
  }
  for (const p of alphaPrompts) {
    assert.ok(!p.includes(BETA_SECRET));
    assert.ok(!p.includes('7.654.321'));
  }
  // Shared employee memory is stored per business and recalled only within that business.
  const mem = q.all('SELECT business_id FROM memories WHERE employee_id = ? ORDER BY id', gf).map((m) => m.business_id);
  assert.deepEqual(mem, [alpha.id, beta.id]);
  const betaShared = promptsFor(['TASKSB']).join('\n');
  assert.ok(!betaShared.includes('TASKSA'), 'Group Finance recalled Alpha memory while working for Beta');
  // Conversations and usage logs carry the business id.
  assert.equal(q.get('SELECT COUNT(*) n FROM conversations WHERE task_id = ? AND business_id IS NOT ?', tSB.id, beta.id).n, 0);
  assert.ok(q.get('SELECT COUNT(*) n FROM usage_logs WHERE business_id = ?', alpha.id).n >= 2);
  assert.ok(tA.id && tB.id);
});

test('business staff cannot be assigned work for another business', async () => {
  const r = await s.post('/api/tasks', { mode: 'direct', employee_id: alpha.fin.id, business_id: beta.id, title: 'Coba lintas bisnis' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /tidak menangani bisnis/);
});

test('explicit document sharing makes a document visible to the target business only', async () => {
  const r = await s.put(`/api/businesses/${alpha.id}/documents/${alphaDoc.id}/shares`, { business_ids: [beta.id] });
  assert.deepEqual(r.json().shared_with, [beta.id]);
  const bDocs = (await s.get(`/api/businesses/${beta.id}/documents`)).json();
  assert.ok(bDocs.some((d) => d.id === alphaDoc.id && d.shared_in));
  // Beta still cannot modify or re-share Alpha's document.
  assert.equal((await s.put(`/api/businesses/${beta.id}/documents/${alphaDoc.id}`, { title: 'x' })).statusCode, 404);
  await s.put(`/api/businesses/${alpha.id}/documents/${alphaDoc.id}/shares`, { business_ids: [] });
  assert.ok(!(await s.get(`/api/businesses/${beta.id}/documents`)).json().some((d) => d.id === alphaDoc.id));
});

test('Group CEO cross-business view follows the owner permission', async () => {
  const { holdingOverviewText } = await import('../src/holding/context.js');
  const on = holdingOverviewText({ business_id: null }).text;
  assert.match(on, /Alpha Test/);
  assert.match(on, /Beta Test/);
  settings.setSetting('group_ceo_cross_business', false);
  const off = holdingOverviewText({ business_id: null }).text;
  assert.ok(!off.includes('1.234.567') && !off.includes('Keuangan bulan ini'));
  settings.setSetting('group_ceo_cross_business', true);
  // A holding task focused on one business only sees that business.
  const focused = holdingOverviewText({ business_id: beta.id }).text;
  assert.ok(!focused.includes('Alpha Test'));
});

test('holding overview, organization and office endpoints respond', async () => {
  const o = (await s.get('/api/overview')).json();
  assert.equal(o.holding.businesses_active, 5);
  assert.ok(o.system.rss_mb > 0);
  const org = (await s.get('/api/organization')).json();
  assert.equal(org.group_ceo.role, 'Group CEO');
  assert.equal(org.shared.length, 5);
  assert.ok(org.businesses.find((b) => b.business.id === alpha.id).manager.id === alpha.mgr.id);
  const office = (await s.get('/api/office')).json();
  assert.ok(office.employees.length >= 22);
  assert.ok(office.employees.every((e) => typeof e.state === 'string'));
  const reports = (await s.get(`/api/businesses/${alpha.id}/reports`)).json();
  assert.ok(reports.length >= 1 && reports.every((r) => r.business_id === alpha.id));
});

test('business with history cannot be hard-deleted, only deactivated', async () => {
  assert.equal((await s.del(`/api/businesses/${alpha.id}`)).statusCode, 400);
  const r = await s.put(`/api/businesses/${alpha.id}`, { status: 'inactive' });
  assert.equal(r.json().status, 'inactive');
  const t = await s.post('/api/tasks', { mode: 'business', business_id: alpha.id, title: 'Tidak boleh' });
  assert.equal(t.statusCode, 400);
  await s.put(`/api/businesses/${alpha.id}`, { status: 'active' });
});

test('logo upload accepts real PNG and rejects SVG / spoofed content', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const ok = await s.post(`/api/businesses/${beta.id}/logo`, { data_url: png });
  assert.equal(ok.statusCode, 200, ok.body);
  const img = await s.get(`/api/businesses/${beta.id}/logo`);
  assert.equal(img.headers['content-type'], 'image/png');
  const svg = await s.post(`/api/businesses/${beta.id}/logo`, { data_url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
  assert.equal(svg.statusCode, 400);
  const fake = await s.post(`/api/businesses/${beta.id}/logo`, { data_url: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' });
  assert.equal(fake.statusCode, 400);
});
