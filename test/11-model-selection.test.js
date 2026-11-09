// Automatic model selection: need detection, model profiles, ranking inside the router, the explanation stored with
// every answer, and that admin pins (employee / tier models) and manual mode still win.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let mock, svc, router, sel, settings, q, worker, chat, app, s;
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

before(async () => {
  await setupEnv();
  mock = await startMockProvider();
  svc = await import('../src/providers/service.js');
  router = await import('../src/router/modelRouter.js');
  sel = await import('../src/router/modelSelector.js');
  settings = await import('../src/lib/settings.js');
  ({ q } = await import('../src/db/index.js'));
  ({ worker } = await import('../src/queue/worker.js'));
  chat = await import('../src/holding/chat.js');
});
after(async () => {
  chat?.stopChatFeed();
  await worker?.stop(1000);
  await app?.close();
  await mock?.close();
});
beforeEach(() => {
  router.resetRouterState();
  q.run('DELETE FROM providers');
  q.run('DELETE FROM usage_logs');
  settings.setSetting('model_routing', 'auto');
});

const msgs = [{ role: 'user', content: 'halo' }];
const need = (title, description = '', extra = {}) => sel.detectNeed({ task: { title, description }, purpose: 'work', ...extra });
// Three free-tier style models with different strengths (the mock answers any unknown model name with success).
const threeModels = (extra = {}) =>
  svc.createProvider({
    preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', max_retries: 0,
    default_model: 'gemini-2.5-flash-lite', fallback_models: ['qwen3-coder-plus', 'gpt-oss-120b'], ...extra,
  });

test('need detection reads the real task: coding, analysis, writing, quick chat reply, general', () => {
  assert.equal(need('Perbaiki bug login', 'Error 500 di endpoint /api/login (node.js)').key, 'coding');
  assert.equal(need('Evaluasi Q4', 'Analisis laba dan proyeksi anggaran').key, 'reasoning');
  assert.equal(need('Tulis caption Instagram', 'Buat 3 caption promo kopi').key, 'writing');
  const chatReply = need('halo', 'halo, apa kabar?\n\n(Pesan obrolan dari owner. Balas langsung seperti pesan chat: ringkas, jelas, maksimal ±150 kata, kecuali owner meminta dokumen atau laporan lengkap.)');
  assert.equal(chatReply.key, 'quick');
  assert.ok(chatReply.signals.includes('balasan obrolan'));
  assert.equal(need('Cek stok', 'cek stok gudang').key, 'general');
  // Planning is analysis work; the employee's role tips an otherwise neutral task.
  assert.equal(sel.detectNeed({ task: { title: 'Cek stok' }, purpose: 'plan' }).key, 'reasoning');
  assert.equal(sel.detectNeed({ task: { title: 'Cek stok' }, employee: { role_key: 'developer', role: 'Developer' } }).key, 'coding');
  assert.equal(sel.detectNeed({ task: { title: 'x' }, inputTokens: 9000 }).long, true);
});

test('model profiles come from the model id; unknown ids stay neutral', () => {
  const p = (id) => sel.profileModel(id);
  assert.ok(p('qwen3-coder-plus').tags.includes('code'));
  assert.equal(p('gpt-oss-120b').size, 'large');
  assert.ok(p('gpt-oss-120b').tags.includes('reason'));
  assert.equal(p('gemini-2.5-flash-lite').size, 'small');
  assert.ok(!p('gemini-2.5-flash-lite').tags.includes('reason'));
  assert.equal(p('llama-3.1-8b-instant').size, 'small');
  assert.equal(p('meta-llama/llama-3.3-70b-instruct:free').size, 'large');
  assert.ok(p('meta-llama/llama-3.3-70b-instruct:free').free);
  assert.ok(p('deepseek/deepseek-r1:free').tags.includes('slow'));
  assert.deepEqual(p('ok-model').tags, []);
  assert.equal(p('ok-model').size, null);
});

test('auto mode picks the best configured model for each need and explains why', async () => {
  threeModels();
  const code = await router.routeChat({ messages: msgs, need: need('Perbaiki bug', 'query SQL error') });
  assert.equal(code.model, 'qwen3-coder-plus');
  assert.equal(code.choice.mode, 'auto');
  assert.equal(code.choice.need, 'coding');
  assert.match(code.choice.text, /Dipilih otomatis untuk kebutuhan Pemrograman & teknis/);
  assert.match(code.choice.text, /spesialis kode/);
  assert.equal(code.choice.rank, 1);
  assert.equal(code.choice.of, 3);

  assert.equal((await router.routeChat({ messages: msgs, need: need('Strategi', 'analisis risiko investasi') })).model, 'gpt-oss-120b');
  const quick = await router.routeChat({ messages: msgs, need: { key: 'quick', label: 'Balasan cepat', signals: [] } });
  assert.equal(quick.model, 'gemini-2.5-flash-lite');
  assert.match(quick.choice.text, /cepat/);
});

test('when the top model fails the next one answers and the explanation says what was skipped', async () => {
  threeModels({ fallback_models: ['fail-qwen3-coder-plus', 'gpt-oss-120b'] });
  const res = await router.routeChat({ messages: msgs, need: need('Debug', 'stack trace python') });
  assert.notEqual(res.model, 'fail-qwen3-coder-plus');
  assert.equal(res.choice.rank, 2);
  assert.deepEqual(res.choice.skipped.map((x) => x.model), ['fail-qwen3-coder-plus']);
  assert.match(res.choice.text, /Sebelumnya dilewati: fail-qwen3-coder-plus \(server provider error\)/);
});

test('manual mode keeps the configured order; calls without a need are never re-ranked', async () => {
  threeModels();
  settings.setSetting('model_routing', 'manual');
  const res = await router.routeChat({ messages: msgs, need: need('Perbaiki bug', 'query SQL error') });
  assert.equal(res.model, 'gemini-2.5-flash-lite');
  assert.equal(res.choice.mode, 'manual');
  assert.match(res.choice.text, /Mode manual: model default provider utama/);
  settings.setSetting('model_routing', 'auto');
  assert.equal((await router.routeChat({ messages: msgs })).model, 'gemini-2.5-flash-lite');
  assert.throws(() => settings.setSetting('model_routing', 'smart'), /auto, manual/);
});

test('a model pinned on the employee or tier is still tried first in auto mode', async () => {
  const p = threeModels();
  const res = await router.routeChat({ messages: msgs, employee: { id: null, provider_id: p.id, model: 'gemini-2.5-flash-lite' }, need: need('Perbaiki bug', 'query SQL error') });
  assert.equal(res.model, 'gemini-2.5-flash-lite');
  assert.equal(res.choice.source, 'employee');
  assert.match(res.choice.text, /Model khusus karyawan ini/);
  assert.match(res.choice.text, /pilihan admin tetap diutamakan/);

  settings.setSetting('tier_models', { shared_services: { provider_id: p.id, model: 'gpt-oss-120b' } });
  const dev = q.get("SELECT * FROM employees WHERE role_key = 'developer'");
  const tier = await router.routeChat({ messages: msgs, employee: dev, need: need('Perbaiki bug', 'query SQL error') });
  assert.equal(tier.model, 'gpt-oss-120b');
  assert.match(tier.choice.text, /Model default tingkatan Shared Services/);
  settings.setSetting('tier_models', {});
});

test('recent failures push a model down; a model whose context is too small is avoided for long input', async () => {
  const p = threeModels();
  const t = Date.now();
  for (let i = 0; i < 4; i++) {
    q.run(`INSERT INTO usage_logs(provider_id, provider_name, model, purpose, ok, created_at) VALUES (?, 'Mock', 'qwen3-coder-plus', 'work', 0, ?)`, p.id, t);
  }
  const res = await router.routeChat({ messages: msgs, need: need('Perbaiki bug', 'query SQL error') });
  assert.notEqual(res.model, 'qwen3-coder-plus');
  q.run('DELETE FROM usage_logs');

  q.run(`INSERT INTO models(provider_id, model_id, name, is_free, context_length, updated_at) VALUES (?, 'gpt-oss-120b', 'x', 1, 8192, ?)`, p.id, t);
  const long = { ...need('Strategi', 'analisis risiko investasi'), long: true, inputTokens: 20000 };
  assert.notEqual((await router.routeChat({ messages: msgs, need: long })).model, 'gpt-oss-120b');
});

test('routing overview lists the pick per need and each model profile', async () => {
  threeModels();
  const o = router.routingOverview();
  assert.equal(o.mode, 'auto');
  const byNeed = Object.fromEntries(o.needs.map((n) => [n.key, n.model]));
  assert.equal(byNeed.coding, 'qwen3-coder-plus');
  assert.equal(byNeed.reasoning, 'gpt-oss-120b');
  assert.equal(byNeed.quick, 'gemini-2.5-flash-lite');
  assert.equal(o.models.length, 3);
  assert.ok(o.models.find((m) => m.model === 'qwen3-coder-plus').strengths.includes('spesialis kode'));
});

test('every chat answer carries the model that wrote it and why (stored with the task)', async () => {
  chat.startChatFeed();
  app = await buildTestApp();
  s = await login(app);
  threeModels();
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 50 });
  const dev = q.get("SELECT * FROM employees WHERE role_key = 'developer'");
  const r = await s.post('/api/chat', { channel: 'hq', content: 'Tolong perbaiki bug query SQL di endpoint laporan', recipient_employee_id: dev.id, mode: 'reply' });
  assert.equal(r.statusCode, 201, r.body);
  const { task } = r.json();
  const list = async () => (await s.get('/api/chat?channel=all&limit=200')).json().messages;
  const reply = await waitFor(async () => (await list()).find((m) => m.task_id === task.id && m.sender_type === 'employee' && m.kind === 'message'));
  assert.equal(reply.model.model, 'qwen3-coder-plus');
  assert.equal(reply.model.provider, 'Mock');
  assert.equal(reply.model.need, 'Pemrograman & teknis');
  assert.match(reply.model.text, /Dipilih otomatis/);
  // Non-answer messages (owner message, "started") carry no model.
  for (const m of (await list()).filter((x) => x.task_id === task.id && x.id !== reply.id)) assert.equal(m.model, null);

  const detail = (await s.get(`/api/tasks/${task.id}`)).json();
  assert.equal(detail.task.model_choice.need, 'coding');
  assert.equal(detail.task.model_choice.model, 'qwen3-coder-plus');
  assert.ok(detail.logs.some((l) => l.event === 'model_choice'));

  const overview = (await s.get('/api/providers/routing')).json();
  assert.equal(overview.needs.length, 5);
});
