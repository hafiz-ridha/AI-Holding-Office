// People never get raw JSON: plans that created no tasks, answers cut off by the token limit, models that answer a
// chat in JSON and provider error bodies all become natural text in task results, the dashboard chat and Telegram
// (notifications and team topics), which read like chat messages (who is talking, then the message).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';
import { startMockTelegram } from './mock-telegram.js';

let mock, tg, app, s, q, tasks, worker, svc, notifier, chat, format;
let readable, cleanError, planAnswer, extractApprovalItems;
const OWNER = { id: 5550001, first_name: 'Owner' };

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}
const noJson = (text) => !/[{[]\s*"\w+"\s*:/.test(text) && !/```json/i.test(text);

before(async () => {
  tg = await startMockTelegram();
  const { config } = await import('../src/config.js');
  config.telegramApiBase = tg.base;
  await setupEnv();
  mock = await startMockProvider();
  ({ q } = await import('../src/db/index.js'));
  tasks = await import('../src/queue/tasks.js');
  ({ worker } = await import('../src/queue/worker.js'));
  svc = await import('../src/providers/service.js');
  notifier = await import('../src/telegram/notifier.js');
  chat = await import('../src/holding/chat.js');
  format = await import('../src/telegram/format.js');
  ({ readable, cleanError, planAnswer } = await import('../src/lib/readable.js'));
  ({ extractApprovalItems } = await import('../src/holding/approvals.js'));
  app = await buildTestApp();
  s = await login(app);
  const r = await s.put('/api/telegram', {
    bot_token: tg.token, chat_id: '-100123456', allowed_user_ids: [String(OWNER.id)], polling_enabled: false,
    notify_task_completed: true, notify_task_failed: true,
  });
  assert.equal(r.statusCode, 200, r.body);
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  notifier.startNotifier({ warn() {} });
  chat.startChatFeed();
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 100 });
});
after(async () => {
  await worker.stop(1000);
  chat.stopChatFeed();
  notifier.stopNotifier();
  await app?.close();
  await mock?.close();
  await tg?.close();
});

const ceoId = () => q.get('SELECT id FROM employees WHERE is_manager = 1').id;
const done = (id) => waitFor(() => {
  const t = tasks.getTask(id);
  return ['completed', 'failed', 'cancelled'].includes(t.status) && t;
});
const sentFor = (title) => waitFor(() => tg.sent.find((m) => m.text.includes(title) && /Tugas selesai/.test(m.text)));

test('readable(): JSON becomes natural text, prose and code in prose stay as they are', () => {
  assert.equal(readable('{"analysis": "Owner menanyakan tren.", "direct_answer": null, "business_tasks": []}'), 'Owner menanyakan tren.');
  assert.equal(
    readable('```json\n{"reply": "Halo owner.", "poin_penting": ["Kopi susu", "Cold brew"], "status": "ok"}\n```'),
    'Halo owner.\n\n**Poin penting**\n- Kopi susu\n- Cold brew\n\n**Status:** ok'
  );
  // Cut off by the token limit: the answer that is there, marked as cut.
  assert.equal(readable('{"analysis": "x", "direct_answer": "Tren kopi naik 20% karena'), 'Tren kopi naik 20% karena …');
  assert.equal(
    readable('{"ringkasan":"Penjualan naik","rekomendasi":[{"judul":"Promo bundling","deskripsi":"Uji 2 minggu","prioritas":"high"}],"data":{"pelanggan_baru":34}}'),
    'Penjualan naik\n\n**Rekomendasi**\n- **Promo bundling**: Uji 2 minggu — Prioritas: tinggi\n\n**Data**\n- Pelanggan baru: 34'
  );
  assert.equal(readable('Berikut jawabannya:\n{"jawaban": "Omzet naik 10%"}'), 'Berikut jawabannya:\n\nOmzet naik 10%');
  for (const prose of ['[Laporan](https://contoh.id) siap.', '## Ringkasan\nOK', '{{nama}} adalah variabel template', 'Contoh:\n```json\n{"a":1}\n```\nselesai']) {
    assert.equal(readable(prose), prose);
  }
  // For chat, JSON code blocks inside prose become text too; other code stays.
  assert.equal(readable('Hasil:\n```json\n{"omzet": 1200000}\n```\nselesai', { fences: true }), 'Hasil:\n**Omzet:** 1200000\n\nselesai');
  assert.match(readable('```js\nconst a = 1;\n```', { fences: true }), /const a = 1/);
  assert.equal(planAnswer({ analysis: 'A', direct_answer: { ringkasan: 'Aman', langkah: ['x'] } }, ''), 'Aman\n\n**Langkah**\n- x');
});

test('cleanError(): error bodies are reduced to their message', () => {
  assert.equal(
    cleanError('HTTP 429: Provider returned error — {"error":{"message":"Resource has been exhausted (e.g. check quota).","code":429}}'),
    'HTTP 429: Provider returned error — Resource has been exhausted (e.g. check quota).'
  );
  assert.equal(cleanError('HTTP 400: {"error":{"code":400,"message":"Invalid model","status":"INVALID_ARGUMENT"}}'), 'HTTP 400: Invalid model');
  assert.equal(cleanError('Provider error: x — {"error":{"message":"The model is overloaded. Please try ag'), 'Provider error: x — The model is overloaded. Please try ag');
  assert.equal(cleanError('Timeout setelah 60 detik'), 'Timeout setelah 60 detik');
  assert.deepEqual(extractApprovalItems('{"catatan": "PERLU PERSETUJUAN OWNER: Transfer dana promosi Rp 5.000.000",\n"x": 1}'), ['Transfer dana promosi Rp 5.000.000']);
});

test('Group CEO plan without tasks: the result is its analysis, not the planning JSON; Telegram reads like a chat', async () => {
  const root = tasks.createTask({ kind: 'instruction', title: 'Tren kopi', description: 'PLAN_NO_LIST tren kopi minggu ini?', employeeId: ceoId() });
  const r = await done(root.id);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(r.result, 'Owner menanyakan tren kopi minggu ini; cukup dijawab langsung.');
  assert.ok(noJson(q.get('SELECT content FROM business_reports WHERE task_id = ?', root.id).content));
  const msg = await sentFor('Tren kopi');
  assert.ok(noJson(msg.text), msg.text);
  const ceo = q.get('SELECT * FROM employees WHERE is_manager = 1');
  assert.ok(msg.text.startsWith(`${format.personEmoji(ceo)} <b>${ceo.name}</b>`), msg.text.slice(0, 60));
  assert.match(msg.text, /✅ Tugas selesai: <b>Tren kopi<\/b>\n<i>T-\d{5}<\/i>\n\nOwner menanyakan tren kopi/);
  assert.match(msg.text, /<i>Model: Mock \/ ok-model/);
});

test('answer cut off mid-JSON: the readable part is kept', async () => {
  const root = tasks.createTask({ kind: 'instruction', title: 'Tren terpotong', description: 'PLAN_TRUNCATED tren?', employeeId: ceoId() });
  const r = await done(root.id);
  assert.equal(r.result, 'Tren kopi susu naik 20% dan pelanggan baru banyak datang dari Instagram, sehingga …');
  assert.ok(noJson((await sentFor('Tren terpotong')).text));
});

test('a chat reply in JSON reaches the chat and Telegram as text; JSON stays when the owner asks for JSON', async () => {
  const emp = q.get("SELECT * FROM employees WHERE enabled = 1 AND org_unit = 'shared' ORDER BY id LIMIT 1");
  const { task } = chat.sendOwnerMessage({ content: 'JSON_REPLY apa tren kopi minggu ini?', recipientEmployeeId: emp.id, mode: 'reply', ownerName: 'Owner' });
  const r = await done(task.id);
  assert.equal(r.result, 'Halo owner, tren kopi susu gula aren sedang naik.\n\n**Poin penting**\n- Kopi susu gula aren\n- Cold brew\n\n**Status:** ok');
  const reply = q.get("SELECT content FROM chat_messages WHERE task_id = ? AND sender_type = 'employee' AND kind = 'message'", task.id);
  assert.ok(noJson(reply.content), reply.content);
  // Telegram: Markdown became Telegram formatting.
  const html = format.chatHtml(r.result);
  assert.match(html, /<b>Poin penting<\/b>\n• Kopi susu gula aren\n• Cold brew/);
  // Asked for JSON: the task result keeps it.
  const { task: t2 } = chat.sendOwnerMessage({ content: 'JSON_REPLY tolong kirim dalam format JSON', recipientEmployeeId: emp.id, mode: 'reply', ownerName: 'Owner' });
  assert.match((await done(t2.id)).result, /^```json\n\{"reply"/);
});

test('failed task: the cause in Telegram has no JSON error body', async () => {
  tg.sent.length = 0;
  const emp = q.get("SELECT * FROM employees WHERE enabled = 1 AND org_unit = 'shared' ORDER BY id LIMIT 1");
  const { bus } = await import('../src/events.js');
  bus.emit('task:failed', {
    task: { id: 77, kind: 'direct', title: 'Riset harga', employee_id: emp.id, business_id: null },
    error: 'HTTP 429: Provider returned error — {"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}',
  });
  const msg = await waitFor(() => tg.sent.find((m) => /Tugas gagal/.test(m.text)));
  assert.match(msg.text, /❌ Tugas gagal: <b>Riset harga<\/b>[\s\S]*Penyebab: HTTP 429: Provider returned error — Rate limit exceeded: free-models-per-day$/);
  assert.ok(noJson(msg.text));
});
