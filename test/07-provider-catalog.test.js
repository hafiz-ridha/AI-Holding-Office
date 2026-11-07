// Free cloud AI provider catalogue: preset sanity, placeholders, keyless providers, providers without /models.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let mock, keyless, svc, registry, app, s;
before(async () => {
  await setupEnv();
  mock = await startMockProvider();
  keyless = await startMockProvider({ key: '' });
  svc = await import('../src/providers/service.js');
  registry = await import('../src/providers/registry.js');
  app = await buildTestApp();
  s = await login(app);
});
after(async () => {
  await app?.close();
  await mock?.close();
  await keyless?.close();
});

test('catalogue: every preset is well-formed and builds an adapter', () => {
  const keys = Object.keys(registry.PRESETS);
  assert.ok(keys.length >= 15, `expected many presets, got ${keys.length}`);
  for (const [key, p] of Object.entries(registry.PRESETS)) {
    assert.ok(registry.PROVIDER_TYPES[p.type], `${key}: type`);
    assert.ok(registry.CATEGORIES[p.category], `${key}: category`);
    assert.ok(p.label && p.free, `${key}: label/free text`);
    if (key !== 'custom') {
      const url = p.base_url.replace('{ACCOUNT_ID}', '0'.repeat(32));
      const u = new URL(url);
      assert.ok(key === 'ninerouter' ? u.protocol === 'http:' : u.protocol === 'https:', `${key}: https base url`);
      assert.ok(!/\/$/.test(p.base_url), `${key}: no trailing slash`);
    }
    const adapter = registry.createAdapter({ ...p, preset: key, base_url: p.base_url || 'http://x', type: p.type });
    assert.equal(typeof adapter.chat, 'function');
  }
  for (const k of ['groq', 'gemini', 'mistral', 'cerebras', 'sambanova', 'cohere', 'cloudflare', 'nvidia', 'huggingface', 'zai']) {
    assert.ok(registry.PRESETS[k], `missing preset ${k}`);
  }
  assert.ok(registry.EXCLUDED.some((x) => /GitHub Models/.test(x.name)), 'retired GitHub Models documented as excluded');
});

test('presets API exposes the catalogue but never secrets', async () => {
  const presets = (await s.get('/api/providers/presets')).json();
  assert.ok(presets.find((p) => p.key === 'groq').key_url.startsWith('https://'));
  const cat = (await s.get('/api/providers/catalog')).json();
  assert.ok(cat.categories.free && cat.excluded.length);
});

test('Cloudflare base URL placeholder must be filled in', async () => {
  const bad = await s.post('/api/providers', { preset: 'cloudflare', api_key: 'x'.repeat(40) });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /ACCOUNT_ID/);
  const ok = await s.post('/api/providers', {
    preset: 'cloudflare', api_key: 'x'.repeat(40),
    base_url: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1`,
  });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().category, 'free');
  assert.equal(ok.json().rpm_limit, 0);
});

test('preset defaults (rate limits) are applied on create', async () => {
  const r = (await s.post('/api/providers', { preset: 'groq', api_key: 'gsk_test_key_123456' })).json();
  assert.equal(r.base_url, 'https://api.groq.com/openai/v1');
  assert.equal(r.rpm_limit, 30);
  assert.equal(r.daily_request_limit, 1000);
  assert.equal(r.typeLabel, 'Groq');
});

test('keyless provider (API key optional) connects without a key', async () => {
  const p = svc.createProvider({ preset: 'llm7', name: 'LLM7 mock', base_url: keyless.baseUrl, default_model: 'ok-model' });
  const r = await svc.testProvider(p.id);
  assert.equal(r.ok, true, r.message);
});

test('provider without /models: test connection pings chat once, model sync uses preset suggestions', async () => {
  const base = mock.baseUrl.replace('/v1', '/nomodels/v1');
  const p = svc.createProvider({ preset: 'zai', name: 'Z mock', base_url: base, api_key: 'test-key', default_model: 'ok-model' });
  const before = mock.calls.filter((c) => c.url.endsWith('/chat/completions')).length;
  const r = await svc.testProvider(p.id);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /1 request chat/);
  assert.equal(mock.calls.filter((c) => c.url.endsWith('/chat/completions')).length - before, 1);
  const sync = await svc.syncModels(p.id);
  assert.equal(sync.source, 'preset');
  assert.deepEqual(svc.listModels(p.id).map((m) => m.id).sort(), ['glm-4.5-flash', 'glm-4.7-flash']);
  // Without a default model the test explains what to do instead of failing silently.
  const p2 = svc.createProvider({ preset: 'custom', name: 'No models', base_url: base, api_key: 'test-key' });
  const r2 = await svc.testProvider(p2.id);
  assert.equal(r2.ok, false);
  assert.match(r2.message, /Isi model default/);
});
