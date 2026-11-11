// Stage 4 (holding): Group CEO -> Business Manager -> employee subtasks, direct answers, postpone, cancel, recovery.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let mock, q, tasks, worker, svc, settings, router, bus;
const events = [];

export async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for condition');
}

before(async () => {
  await setupEnv();
  mock = await startMockProvider();
  ({ q } = await import('../src/db/index.js'));
  tasks = await import('../src/queue/tasks.js');
  ({ worker } = await import('../src/queue/worker.js'));
  svc = await import('../src/providers/service.js');
  settings = await import('../src/lib/settings.js');
  router = await import('../src/router/modelRouter.js');
  ({ bus } = await import('../src/events.js'));
  for (const ev of ['task:started', 'task:completed', 'task:failed', 'task:postponed', 'system:alert', 'approval:created']) {
    bus.on(ev, (p) => events.push({ ev, id: p.task?.id, key: p.key }));
  }
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 100 });
});
after(async () => {
  await worker.stop(1000);
  await mock?.close();
});
beforeEach(() => {
  router.resetRouterState();
  q.run('DELETE FROM providers');
  events.length = 0;
});

const ceoId = () => q.get('SELECT id FROM employees WHERE is_manager = 1').id;
const done = (id) => waitFor(() => {
  const t = tasks.getTask(id);
  return ['completed', 'failed', 'cancelled'].includes(t.status) && t;
});

test('holding instruction: Group CEO -> business managers -> staff -> business reports -> holding report', async () => {
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  const root = tasks.createTask({ kind: 'instruction', title: 'Evaluasi seluruh bisnis bulan ini', description: 'Identifikasi bisnis yang butuh perhatian', employeeId: ceoId() });
  const r = await done(root.id);
  assert.equal(r.status, 'completed', r.error);
  const biz = q.all(`SELECT t.*, b.slug FROM tasks t JOIN businesses b ON b.id = t.business_id WHERE t.parent_id = ? AND t.kind = 'business' ORDER BY t.id`, root.id);
  assert.deepEqual(biz.map((b) => b.slug), ['wins-court', 'coffee', 'it-technology']);
  for (const bt of biz) {
    assert.equal(bt.status, 'completed');
    assert.equal(bt.level, 'business');
    const mgr = q.get('SELECT manager_employee_id m FROM businesses WHERE id = ?', bt.business_id).m;
    assert.equal(bt.employee_id, mgr, 'business task assigned to that business manager');
    const subs = q.all('SELECT * FROM tasks WHERE parent_id = ?', bt.id);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].business_id, bt.business_id, 'subtask inherits business_id');
    assert.equal(subs[0].level, 'employee');
    assert.ok(q.get('SELECT 1 x FROM business_employees WHERE business_id = ? AND employee_id = ?', bt.business_id, subs[0].employee_id), 'assignee is a member of that business');
  }
  // 1 CEO plan + 3 x (BM plan + 1 subtask + BM synthesis) + 1 CEO synthesis = 11 calls.
  assert.equal(q.get('SELECT COUNT(*) n FROM usage_logs WHERE ok = 1').n, 11);
  assert.equal(q.get("SELECT COUNT(*) n FROM business_reports WHERE scope = 'business'").n, 3);
  assert.equal(q.get("SELECT COUNT(*) n FROM business_reports WHERE scope = 'holding'").n, 1);
  assert.ok(events.some((e) => e.ev === 'task:completed' && e.id === root.id));
});

test('shared services work in the context of the assigned business', async () => {
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  const root = tasks.createTask({ kind: 'instruction', title: 'Review biaya', description: 'WITH_SHARED analisis biaya', employeeId: ceoId() });
  await done(root.id);
  const shared = q.get(`SELECT t.*, e.org_unit FROM tasks t JOIN employees e ON e.id = t.employee_id WHERE t.parent_id = ? AND t.kind = 'subtask'`, root.id);
  assert.equal(shared.org_unit, 'shared');
  assert.equal(shared.status, 'completed');
  assert.equal(shared.business_id, q.get("SELECT id FROM businesses WHERE slug = 'wins-court'").id);
  assert.equal(q.get('SELECT business_id FROM memories WHERE task_id = ?', shared.id).business_id, shared.business_id);
});

test('simple instruction: Group CEO answers directly (1 API call)', async () => {
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  const before = q.get('SELECT COUNT(*) n FROM usage_logs').n;
  const root = tasks.createTask({ kind: 'instruction', title: 'Pertanyaan', description: 'SIMPLE_TASK apa itu KPI?', employeeId: ceoId() });
  const r = await done(root.id);
  assert.equal(r.result, 'Jawaban langsung dari Group CEO.');
  assert.equal(q.get('SELECT COUNT(*) n FROM usage_logs').n - before, 1);
});

test('business task created directly by the owner goes to that Business Manager', async () => {
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  const b = q.get("SELECT * FROM businesses WHERE slug = 'coffee'");
  const t = tasks.createTask({ kind: 'business', title: 'Promo musim hujan', description: 'Rencana promo', businessId: b.id, employeeId: b.manager_employee_id, managerEmployeeId: b.manager_employee_id });
  const r = await done(t.id);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(q.get("SELECT COUNT(*) n FROM business_reports WHERE task_id = ? AND business_id = ?", t.id, b.id).n, 1);
});

test('risky recommendation creates an owner approval request', async () => {
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  const dev = q.get("SELECT id FROM employees WHERE slug = 'developer'").id;
  const t = tasks.createTask({ kind: 'direct', title: 'Saran anggaran', description: 'APPROVAL_TEST', employeeId: dev });
  await done(t.id);
  const a = q.get('SELECT * FROM approvals WHERE task_id = ?', t.id);
  assert.equal(a.status, 'pending');
  assert.match(a.detail, /Transfer dana promosi/);
  assert.ok(events.some((e) => e.ev === 'approval:created'));
});

test('all providers failing -> task postponed (pending) then failed after max attempts', async () => {
  svc.createProvider({ preset: 'custom', name: 'Broken', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'fail-model', max_retries: 0 });
  settings.setSetting('max_task_attempts', 2);
  const dev = q.get("SELECT id FROM employees WHERE slug = 'developer'").id;
  const t = tasks.createTask({ kind: 'direct', title: 'Buat script', employeeId: dev });
  const p = await waitFor(() => {
    const x = tasks.getTask(t.id);
    return x.status === 'pending' && x.attempts === 1 && x;
  });
  assert.ok(p.next_attempt_at > Date.now());
  assert.ok(events.some((e) => e.ev === 'system:alert'));
  router.resetRouterState();
  tasks.retryTask(t.id);
  const f = await waitFor(() => tasks.getTask(t.id).status === 'failed' && tasks.getTask(t.id));
  assert.match(f.error, /Gagal setelah 2 percobaan/);
  settings.setSetting('max_task_attempts', 3);
});

test('cancel a running task aborts the AI call; cancelling a holding task cancels descendants', async () => {
  svc.createProvider({ preset: 'custom', name: 'Slow', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'slow-model' });
  const dev = q.get("SELECT id FROM employees WHERE slug = 'developer'").id;
  const t = tasks.createTask({ kind: 'direct', title: 'Lama', employeeId: dev });
  await waitFor(() => tasks.getTask(t.id).status === 'processing');
  tasks.cancelTask(t.id);
  await waitFor(() => worker.running.size === 0, 4000);
  assert.equal(tasks.getTask(t.id).status, 'cancelled');

  settings.setSetting('queue_paused', true);
  const root = tasks.createTask({ kind: 'instruction', title: 'x', employeeId: ceoId() });
  const b = q.get("SELECT * FROM businesses WHERE slug = 'coffee'");
  const bt = tasks.createTask({ kind: 'business', parentId: root.id, title: 'y', businessId: b.id, employeeId: b.manager_employee_id });
  const st = tasks.createTask({ kind: 'subtask', parentId: bt.id, title: 'z', businessId: b.id, employeeId: b.manager_employee_id });
  const r = tasks.cancelTask(root.id);
  assert.deepEqual(r.cancelled.sort(), [root.id, bt.id, st.id].sort());
  settings.setSetting('queue_paused', false);
});

test('paused queue does not pick up work; resume does', async () => {
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  settings.setSetting('queue_paused', true);
  const sec = q.get("SELECT id FROM employees WHERE slug = 'secretary'").id;
  const t = tasks.createTask({ kind: 'direct', title: 'Ringkas rapat', employeeId: sec });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tasks.getTask(t.id).status, 'assigned');
  settings.setSetting('queue_paused', false);
  bus.emit('queue:wake');
  await waitFor(() => tasks.getTask(t.id).status === 'completed');
});

test('token budget per task is enforced (one plain call, and agent tasks with their own budget)', async () => {
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  const sec = q.get("SELECT id FROM employees WHERE slug = 'secretary'").id;
  settings.setSetting('max_tokens_per_task', 500);
  settings.setSetting('agent_enabled', false);
  try {
    const t = tasks.createTask({ kind: 'direct', title: 'Panjang', description: 'x'.repeat(4000), employeeId: sec });
    const f = await waitFor(() => tasks.getTask(t.id).status === 'failed' && tasks.getTask(t.id));
    assert.match(f.error, /Batas token per pekerjaan \(500\)/);
    // Tasks that may use tools (several AI calls) have their own, larger budget: agent_max_tokens.
    settings.setSetting('agent_enabled', true);
    settings.setSetting('agent_max_tokens', 2000);
    const t2 = tasks.createTask({ kind: 'direct', title: 'Panjang agen', description: 'x'.repeat(9000), employeeId: sec });
    const f2 = await waitFor(() => tasks.getTask(t2.id).status === 'failed' && tasks.getTask(t2.id));
    assert.match(f2.error, /Batas token per pekerjaan \(2000\)/);
  } finally {
    settings.setSetting('max_tokens_per_task', 12000);
    settings.setSetting('agent_enabled', true);
    settings.setSetting('agent_max_tokens', 40000);
  }
});

test('restart recovery re-queues interrupted tasks', () => {
  const sec = q.get("SELECT id FROM employees WHERE slug = 'secretary'").id;
  settings.setSetting('queue_paused', true);
  const r = q.run(`INSERT INTO tasks(kind, title, created_by, employee_id, status, created_at, updated_at) VALUES ('direct','x','owner',?,'processing',0,0)`, sec);
  assert.ok(tasks.recoverInterrupted() >= 1);
  assert.equal(tasks.getTask(r.lastInsertRowid).status, 'assigned');
  tasks.cancelTask(r.lastInsertRowid);
  settings.setSetting('queue_paused', false);
});

test('tier default model is used for business managers', async () => {
  const p = svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  settings.setSetting('tier_models', { business_manager: { provider_id: p.id, model: 'free-model:free' } });
  const bm = q.get("SELECT e.* FROM employees e WHERE role_key = 'business_manager' LIMIT 1");
  const c = router.buildCandidates(bm);
  assert.equal(c[0].model, 'free-model:free');
  assert.equal(c[0].source, 'tier');
  const ceo = q.get('SELECT * FROM employees WHERE is_manager = 1');
  assert.equal(router.buildCandidates(ceo)[0].model, 'ok-model');
  settings.setSetting('tier_models', {});
});
