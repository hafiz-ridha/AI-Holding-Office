// Agent chat: feed derived from real task events, owner notes / AI replies / full tasks, per-business isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let app, s, q, worker, chat, mock;
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
  ({ q } = await import('../src/db/index.js'));
  ({ worker } = await import('../src/queue/worker.js'));
  chat = await import('../src/holding/chat.js');
  chat.startChatFeed();
  app = await buildTestApp();
  s = await login(app);
  await s.post('/api/providers', { preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 50 });
});
after(async () => {
  chat.stopChatFeed();
  await worker.stop(1000);
  await app?.close();
  await mock?.close();
});

const coffee = () => q.get("SELECT * FROM businesses WHERE slug = 'coffee'");
const msgs = async (channel = 'all') => (await s.get(`/api/chat?channel=${channel}&limit=200`)).json().messages;

test('note mode stores the message without creating a task or calling AI', async () => {
  const calls = q.get('SELECT COUNT(*) n FROM usage_logs').n;
  const r = await s.post('/api/chat', { channel: 'hq', content: 'Catatan: rapat jam 9', mode: 'note' });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().task, null);
  const m = (await msgs('hq')).at(-1);
  assert.equal(m.sender_type, 'owner');
  assert.equal(m.kind, 'note');
  assert.equal(m.recipient_name, 'Arya', 'default recipient in HQ is the Group CEO');
  assert.equal(q.get('SELECT COUNT(*) n FROM usage_logs').n, calls);
});

test('slash commands answer from system data without AI', async () => {
  const calls = q.get('SELECT COUNT(*) n FROM usage_logs').n;
  await s.post('/api/chat', { channel: 'hq', content: '/status' });
  const last = (await msgs('hq')).slice(-2);
  assert.deepEqual(last.map((m) => m.kind), ['command', 'system']);
  assert.match(last[1].content, /Antrean berjalan/);
  assert.equal(q.get('SELECT COUNT(*) n FROM usage_logs').n, calls);
});

test('quick reply: owner message -> one AI call -> real reply from the agent, in order', async () => {
  const b = coffee();
  const r = await s.post('/api/chat', { channel: String(b.id), content: 'Berapa target promo minggu ini?', mode: 'reply' });
  assert.equal(r.statusCode, 201, r.body);
  const { task } = r.json();
  assert.equal(task.kind, 'direct');
  const t = q.get('SELECT * FROM tasks WHERE id = ?', task.id);
  assert.equal(t.employee_id, b.manager_employee_id, 'default recipient in a business channel is its manager');
  assert.equal(t.business_id, b.id);
  assert.match(t.created_by, /^chat:admin$/);
  const reply = await waitFor(async () => (await msgs(String(b.id))).find((m) => m.task_id === task.id && m.sender_type === 'employee' && m.kind === 'message'));
  assert.match(reply.content, /Hasil kerja untuk/);
  assert.equal(reply.recipient_name, 'admin');
  const thread = (await msgs(String(b.id))).filter((m) => m.task_id === task.id).map((m) => `${m.sender_type}:${m.kind}`);
  assert.deepEqual(thread, ['owner:message', 'employee:start', 'employee:message'], 'owner first, then start, then reply');
});

test('full task: holding orchestration produces assignment / done / report messages from real events', async () => {
  const r = await s.post('/api/chat', { channel: 'hq', content: 'Evaluasi semua bisnis minggu ini', mode: 'task' });
  const { task } = r.json();
  assert.equal(task.kind, 'instruction');
  await waitFor(() => q.get('SELECT status FROM tasks WHERE id = ?', task.id).status === 'completed', 20000);
  await waitFor(async () => (await msgs()).some((m) => m.task_id === task.id && m.kind === 'report'));
  const all = await msgs();
  const assigns = all.filter((m) => m.kind === 'assign' && q.get('SELECT parent_id FROM tasks WHERE id = ?', m.task_id)?.parent_id === task.id);
  assert.equal(assigns.length, 3, 'CEO assigned one business task per business');
  assert.ok(assigns.every((m) => m.sender_name === 'Arya' && /tolong kerjakan/.test(m.content)));
  assert.ok(all.some((m) => m.kind === 'meeting' && m.task_id === task.id), 'synthesis meeting announced');
  assert.ok(all.some((m) => m.kind === 'done' && m.business_id), 'staff reported done to their manager');
  assert.ok(all.some((m) => m.kind === 'report' && /Laporan bisnis siap/.test(m.content) && m.recipient_name === 'Arya'));
  const final = all.find((m) => m.kind === 'report' && m.task_id === task.id);
  assert.equal(final.recipient_name, 'admin');
});

test('business channels are isolated; "all" shows every channel', async () => {
  const b = coffee();
  const wins = q.get("SELECT id FROM businesses WHERE slug = 'wins-court'").id;
  const own = await msgs(String(b.id));
  assert.ok(own.length > 0 && own.every((m) => m.business_id === b.id));
  assert.ok((await msgs(String(wins))).every((m) => m.business_id === wins));
  assert.ok((await msgs('hq')).every((m) => m.business_id === null));
  assert.ok((await msgs()).some((m) => m.business_id === b.id) && (await msgs()).some((m) => m.business_id === null));
  // incremental polling
  const last = own.at(-1).id;
  await s.post('/api/chat', { channel: String(b.id), content: 'catatan baru', mode: 'note' });
  const delta = (await s.get(`/api/chat?channel=${b.id}&after=${last}`)).json().messages;
  assert.deepEqual(delta.map((m) => m.content), ['catatan baru']);
});

test('staff of another business cannot be addressed in a business channel', async () => {
  const b = coffee();
  const winsStaff = q.get("SELECT e.id FROM employees e JOIN business_employees be ON be.employee_id = e.id JOIN businesses b ON b.id = be.business_id WHERE b.slug = 'wins-court' AND e.role_key = 'marketing'").id;
  const before = (await msgs(String(b.id))).length;
  const r = await s.post('/api/chat', { channel: String(b.id), content: 'halo', recipient_employee_id: winsStaff, mode: 'reply' });
  assert.equal(r.statusCode, 400);
  assert.equal((await msgs(String(b.id))).length, before, 'rejected message is not kept');
});

test('clearing a channel deletes only that channel', async () => {
  const b = coffee();
  const hqBefore = (await msgs('hq')).length;
  const r = await s.del(`/api/chat?channel=${b.id}`);
  assert.ok(r.json().deleted > 0);
  assert.equal((await msgs(String(b.id))).length, 0);
  assert.equal((await msgs('hq')).length, hqBefore);
  assert.equal((await s.get('/api/chat?channel=99999')).statusCode, 404);
});
