// Stage 3: providers, model router (fallback, cooldown, limits), employees.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let mock, svc, router, q, settings;
before(async () => {
  await setupEnv();
  mock = await startMockProvider();
  svc = await import('../src/providers/service.js');
  router = await import('../src/router/modelRouter.js');
  ({ q } = await import('../src/db/index.js'));
  settings = await import('../src/lib/settings.js');
});
after(async () => mock?.close());
beforeEach(() => {
  router.resetRouterState();
  q.run('DELETE FROM providers');
  q.run('DELETE FROM usage_logs');
});

const msgs = [{ role: 'user', content: 'halo' }];

test('provider API key is encrypted and never exposed', () => {
  const p = svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  assert.equal(p.has_api_key, true);
  assert.equal(p.api_key_hint, '••••');
  assert.ok(!JSON.stringify(p).includes('test-key'));
  const row = svc.getProviderRow(p.id);
  assert.ok(row.api_key_enc.startsWith('v1:'));
  assert.equal(p.is_default, true, 'first provider becomes default');
});

test('test connection + model sync (OpenRouter adapter, free detection)', async () => {
  const p = svc.createProvider({ preset: 'openrouter', name: 'OR mock', base_url: mock.baseUrl, api_key: 'test-key' });
  const r = await svc.testProvider(p.id);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /49 \/ 50/);
  const s = await svc.syncModels(p.id);
  assert.equal(s.total, 3);
  assert.equal(s.free, 1);
  const free = svc.listModels(p.id, { free: true });
  assert.deepEqual(free.map((m) => m.id), ['free-model:free']);
});

test('wrong key -> auth_error status', async () => {
  const p = svc.createProvider({ preset: 'custom', name: 'Bad', base_url: mock.baseUrl, api_key: 'wrong' });
  const r = await svc.testProvider(p.id);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'auth_error');
});

test('9Router adapter: unreachable server reports error, non-OpenAI endpoint reports unsupported', async () => {
  const p = svc.createProvider({ preset: 'ninerouter', name: '9R', base_url: 'http://127.0.0.1:1/v1' });
  const r = await svc.testProvider(p.id);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  const p2 = svc.createProvider({ preset: 'ninerouter', name: '9R-bad', base_url: mock.baseUrl.replace('/v1', '/nope'), api_key: 'test-key' });
  const r2 = await svc.testProvider(p2.id);
  assert.equal(r2.status, 'unsupported');
});

test('router falls back from failing model to next candidate and logs usage', async () => {
  svc.createProvider({
    preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key',
    default_model: 'fail-model', fallback_models: ['missing-model', 'free-model:free'], max_retries: 0,
  });
  const res = await router.routeChat({ messages: msgs, purpose: 'work' });
  assert.equal(res.model, 'free-model:free');
  assert.equal(res.tokensIn, 100);
  const logs = q.all('SELECT model, ok FROM usage_logs ORDER BY id');
  assert.deepEqual(logs.map((l) => [l.model, l.ok]), [['fail-model', 0], ['missing-model', 0], ['free-model:free', 1]]);
});

test('employee preference is tried first, then backup provider', async () => {
  const a = svc.createProvider({ preset: 'custom', name: 'A', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'rate-model', max_retries: 0 });
  const b = svc.createProvider({ preset: 'custom', name: 'B', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model', priority: 50 });
  const res = await router.routeChat({ messages: msgs, employee: { id: null, provider_id: b.id, model: 'free-model:free' } });
  assert.equal(res.providerName, 'B');
  assert.equal(res.model, 'free-model:free');
  // Rate-limited model gets a cooldown and is skipped on the next call.
  const r2 = await router.routeChat({ messages: msgs });
  assert.equal(r2.providerName, 'B');
  const r3 = await router.routeChat({ messages: msgs });
  assert.ok(r3.attempts.some((x) => x.skipped === 'model cooldown'));
  assert.ok(a.id);
});

test('daily free-model limit puts provider in cooldown until UTC midnight', async () => {
  const p = svc.createProvider({ preset: 'custom', name: 'D', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'daily-model', max_retries: 0 });
  await assert.rejects(router.routeChat({ messages: msgs }), (e) => e.kind === 'all_failed');
  const row = svc.getProviderRow(p.id);
  assert.equal(row.status, 'rate_limited');
  assert.ok(row.cooldown_until > Date.now());
});

test('global daily request cap stops calls (no infinite retry)', async () => {
  svc.createProvider({ preset: 'custom', name: 'M', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  settings.setSetting('max_daily_requests', 2);
  await router.routeChat({ messages: msgs });
  await router.routeChat({ messages: msgs });
  await assert.rejects(router.routeChat({ messages: msgs }), (e) => e.kind === 'quota');
  settings.setSetting('max_daily_requests', 200);
});

test('max_model_attempts bounds the number of candidates tried', async () => {
  svc.createProvider({
    preset: 'custom', name: 'F', base_url: mock.baseUrl, api_key: 'test-key', max_retries: 0,
    default_model: 'fail-model', fallback_models: ['missing-model', 'empty-model', 'rate-model', 'ok-model'],
  });
  settings.setSetting('max_model_attempts', 2);
  await assert.rejects(router.routeChat({ messages: msgs }), (e) => e.kind === 'all_failed');
  assert.equal(q.get('SELECT COUNT(*) n FROM usage_logs').n, 2);
  settings.setSetting('max_model_attempts', 4);
});

test('no provider configured -> clear error', async () => {
  await assert.rejects(router.routeChat({ messages: msgs }), (e) => e.kind === 'no_provider');
});

test('employees: CRUD and manager protection', async () => {
  const emp = await import('../src/agents/employees.js');
  const ceo = q.get('SELECT * FROM employees WHERE is_manager = 1');
  assert.throws(() => emp.deleteEmployee(ceo.id), /Group CEO/);
  assert.throws(() => emp.updateEmployee(ceo.id, { enabled: false }), /Group CEO/);
  const e = emp.createEmployee({ name: 'Budi Finance', role: 'Finance', avatar: { shirt: '#123456', hair: 'red' } });
  assert.equal(e.slug, 'budi-finance');
  assert.deepEqual(e.avatar, { shirt: '#123456', glasses: false });
  assert.match(e.system_prompt, /PERLU PERSETUJUAN ADMIN/);
  emp.addMemory(e.id, null, 'Menyelesaikan laporan keuangan Q3');
  assert.equal(emp.recentMemories(e.id, 5).length, 1);
  assert.equal(emp.deleteEmployee(e.id), true);
});
