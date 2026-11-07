// Stage 2: DB, migrations, crypto, settings, time helpers, auth endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';

let app;
before(async () => {
  await setupEnv();
  app = await buildTestApp();
});
after(async () => {
  await app?.close();
});

test('migrations create all required tables', async () => {
  const { q } = await import('../src/db/index.js');
  const tables = q.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const t of [
    'users', 'employees', 'providers', 'models', 'tasks', 'task_logs', 'conversations', 'memories',
    'usage_logs', 'telegram_settings', 'telegram_reports', 'system_settings', 'sessions', 'audit_logs',
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const { migrate } = await import('../src/db/migrate.js');
  assert.equal(migrate({ info() {} }), 0, 'migrations are idempotent');
});

test('seed creates holding structure (Group CEO, shared services, 3 businesses) and one admin', async () => {
  const { q } = await import('../src/db/index.js');
  assert.equal(q.get("SELECT COUNT(*) n FROM employees WHERE org_unit = 'holding'").n, 1);
  assert.equal(q.get("SELECT COUNT(*) n FROM employees WHERE org_unit = 'shared'").n, 5);
  assert.equal(q.get("SELECT COUNT(*) n FROM employees WHERE org_unit = 'business'").n, 12);
  assert.equal(q.get('SELECT COUNT(*) n FROM employees WHERE is_manager = 1').n, 1);
  assert.deepEqual(q.all('SELECT slug FROM businesses ORDER BY id').map((b) => b.slug), ['wins-court', 'coffee', 'it-technology']);
  assert.equal(q.get('SELECT COUNT(*) n FROM businesses WHERE manager_employee_id IS NULL').n, 0);
  const u = q.get('SELECT * FROM users');
  assert.equal(u.username, 'admin');
  assert.match(u.password_hash, /^scrypt\$/);
});

test('secret encryption round-trip and masking', async () => {
  const c = await import('../src/lib/crypto.js');
  const enc = c.encryptSecret('sk-or-v1-abcdef1234567890');
  assert.notEqual(enc, 'sk-or-v1-abcdef1234567890');
  assert.equal(c.decryptSecret(enc), 'sk-or-v1-abcdef1234567890');
  assert.equal(c.maskSecret('sk-or-v1-abcdef1234567890'), 'sk-or-…7890');
  const tampered = enc.slice(0, -4) + 'AAAA';
  assert.throws(() => c.decryptSecret(tampered));
});

test('timezone helpers (Asia/Jakarta = UTC+7)', async () => {
  const t = await import('../src/lib/time.js');
  const ms = Date.UTC(2026, 10, 7, 20, 30); // 03:30 next day in Jakarta
  assert.equal(t.localDate(ms, 'Asia/Jakarta'), '2026-11-08');
  assert.equal(t.localTime(ms, 'Asia/Jakarta'), '03:30');
  const [start, end] = t.dayRange('2026-11-08', 'Asia/Jakarta');
  assert.equal(start, Date.UTC(2026, 10, 7, 17, 0));
  assert.equal(end - start, 86400000);
  assert.equal(t.displayDate('2026-11-08'), '08-11-2026');
});

test('settings validation', async () => {
  const s = await import('../src/lib/settings.js');
  assert.equal(s.getSetting('max_concurrency'), 1);
  assert.equal(s.setSetting('max_concurrency', 2), 2);
  assert.throws(() => s.setSetting('max_concurrency', 99));
  assert.throws(() => s.setSetting('timezone', 'Mars/Base'));
  s.setSetting('max_concurrency', 1);
});

test('JSON extraction from messy LLM output', async () => {
  const { extractJsonObject } = await import('../src/lib/text.js');
  assert.deepEqual(extractJsonObject('Berikut rencana:\n```json\n{"a": [1, {"b": "}"}]}\n```'), { a: [1, { b: '}' }] });
  assert.deepEqual(extractJsonObject('pre {bad} then {"ok": true}'), { ok: true });
  assert.equal(extractJsonObject('tidak ada json'), null);
});

test('API requires login; health is public', async () => {
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/api/auth/me')).statusCode, 401);
});

test('login, CSRF enforcement, logout', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.statusCode, 401);
  const s = await login(app);
  const me = await s.get('/api/auth/me');
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, 'admin');
  // Missing CSRF header on a state-changing request is rejected.
  const noCsrf = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: s.headers.cookie } });
  assert.equal(noCsrf.statusCode, 403);
  const out = await s.post('/api/auth/logout', {});
  assert.equal(out.statusCode, 200);
  assert.equal((await s.get('/api/auth/me')).statusCode, 401);
});

test('security headers present', async () => {
  const res = await app.inject('/api/health');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('login brute-force is rate limited', async () => {
  let last;
  for (let i = 0; i < 6; i++) {
    last = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'x' },
      remoteAddress: '10.9.9.9',
    });
  }
  assert.equal(last.statusCode, 429);
});
