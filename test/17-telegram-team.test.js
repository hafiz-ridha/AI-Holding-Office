// Telegram team group: one forum topic per AI employee (+ a reports topic). /team links the group (Topics on, bot
// admin with "manage topics"), topics follow the roster, a message in an employee's topic goes to that employee via
// the dashboard chat and the answer comes back into the topic (person emoji in the character's skin tone + name +
// role), dashboard messages are mirrored, deleted topics are recreated, and reports can go to the reports topic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockTelegram } from './mock-telegram.js';

let tg, app, s, q, bot, team, chat, tasks, sched, settings;
const OWNER = { id: 5550001, first_name: 'Hafiz' };
const STRANGER = { id: 999, first_name: 'X' };
const GROUP = -1001234567890;
const FORUM = { id: GROUP, type: 'supergroup', is_forum: true, title: 'AI Holding Team' };
const TZ = 'Asia/Jakarta';
const ALLOWED_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}
const topicMsg = (thread, text, from = OWNER) => ({ message_id: 1, text, from, chat: FORUM, message_thread_id: thread, is_topic_message: true });

before(async () => {
  tg = await startMockTelegram();
  const { config } = await import('../src/config.js');
  config.telegramApiBase = tg.base;
  await setupEnv();
  ({ q } = await import('../src/db/index.js'));
  ({ bot } = await import('../src/telegram/bot.js'));
  team = await import('../src/telegram/team.js');
  chat = await import('../src/holding/chat.js');
  tasks = await import('../src/queue/tasks.js');
  sched = await import('../src/scheduler/index.js');
  settings = await import('../src/lib/settings.js');
  settings.setSetting('queue_paused', true); // tasks stay put; the test completes them itself
  app = await buildTestApp();
  s = await login(app);
  const r = await s.put('/api/telegram', { bot_token: tg.token, allowed_user_ids: [String(OWNER.id)], polling_enabled: false });
  assert.equal(r.statusCode, 200, r.body);
  chat.startChatFeed();
  team.startTeamBridge();
});
after(async () => {
  team.stopTeamBridge();
  chat.stopChatFeed();
  await bot.stop();
  await app?.close();
  await tg?.close();
});

const { handleCommand } = await import('../src/telegram/bot.js');

test('/team needs a group with Topics and the bot as admin that may manage topics', async () => {
  assert.match(await handleCommand('/team', OWNER, 777, TZ, { id: 777, type: 'private' }), /Topics/);
  assert.match(await handleCommand('/team', OWNER, GROUP, TZ, { ...FORUM, is_forum: false }), /Topics/);
  tg.state.memberStatus = 'member';
  assert.match(await handleCommand('/team', OWNER, GROUP, TZ, FORUM), /admin[\s\S]*Kelola topik/);
  tg.state.memberStatus = 'administrator';
  assert.equal(await handleCommand('/team', STRANGER, GROUP, TZ, FORUM), undefined, 'strangers cannot link a group');
  assert.equal(q.get('SELECT team_chat_id FROM telegram_settings').team_chat_id, null);
});

test('/team creates one topic per employee + a reports topic, moves reports there and reports back in General', async () => {
  const reply = await handleCommand('/team', OWNER, GROUP, TZ, FORUM);
  assert.match(reply, /Menyiapkan grup tim/);
  const employees = q.all('SELECT * FROM employees WHERE enabled = 1');
  await waitFor(() => tg.sent.some((m) => m.chat_id === GROUP && /Grup tim siap/.test(m.text)));
  assert.equal(tg.topics.length, employees.length + 1);
  assert.equal(tg.topics[0].name, team.REPORTS_TOPIC);
  for (const t of tg.topics) assert.ok(ALLOWED_COLORS.includes(t.icon_color), `topic colour ${t.icon_color}`);
  for (const e of employees) {
    const row = team.topicOf(GROUP, e.id);
    assert.ok(row, `topic for ${e.name}`);
    assert.ok(row.name.startsWith(`${e.name} · `), row.name);
  }
  const summary = tg.sent.find((m) => /Grup tim siap/.test(m.text));
  assert.equal(summary.message_thread_id, undefined, 'summary goes to the General topic');
  assert.match(summary.text, /\/tugas[\s\S]*\/catat[\s\S]*Laporan & notifikasi otomatis sekarang masuk/);
  const row = q.get('SELECT chat_id, report_thread_id, team_title FROM telegram_settings');
  assert.equal(row.chat_id, String(GROUP));
  assert.equal(row.report_thread_id, team.reportsTopic(GROUP).thread_id);
  assert.equal(row.team_title, 'AI Holding Team');
  // Reports now go to the reports topic.
  const before = tg.sent.length;
  await s.post('/api/telegram/test');
  assert.equal(tg.sent.at(-1).message_thread_id, row.report_thread_id);
  assert.ok(tg.sent.length > before);
  // Dashboard view of the team.
  const d = (await s.get('/api/telegram')).json();
  assert.equal(d.team.topics.length, employees.length + 1);
  assert.equal(d.team.pending, 0);
  assert.ok(d.team.reports_here);
  assert.match(d.team.topics[1].link, /^https:\/\/t\.me\/c\/1234567890\/\d+$/);
});

test('person emoji: job + the character\'s skin tone', () => {
  assert.equal(team.personEmoji({ is_manager: 1, avatar: '{"skin":"#f1c27d"}' }), '🤵🏼');
  assert.equal(team.personEmoji({ role_key: 'developer', role: 'Developer', avatar: '{"skin":"#8d5524"}' }), '🧑🏿‍💻');
  assert.equal(team.personEmoji({ role_key: 'researcher', role: 'Researcher', avatar: '{"skin":"#c68642"}' }), '🧑🏽‍🔬');
  assert.equal(team.personEmoji({ role_key: 'secretary', role: 'Secretary', avatar: '{"skin":"#ffdbac"}' }), '💁🏻');
  assert.equal(team.personEmoji({ role_key: 'barista', role: 'Barista', avatar: '{}' }), '🧑🏼‍🍳');
  assert.equal(team.personEmoji({ role_key: 'group_finance', role: 'Group Finance', avatar: null }), '🧑🏼‍💼');
});

test('writing in an employee topic talks to that employee; the answer comes back into the topic', async () => {
  const emp = q.get("SELECT * FROM employees WHERE enabled = 1 AND org_unit = 'shared' ORDER BY id LIMIT 1");
  const thread = team.topicOf(GROUP, emp.id).thread_id;
  // Strangers are ignored; General-topic chatter is not for an employee.
  assert.equal(team.handleTopicMessage(topicMsg(thread, 'halo', STRANGER)), undefined);
  assert.equal(team.handleTopicMessage({ ...topicMsg(thread, 'halo'), is_topic_message: false, message_thread_id: undefined }), null);
  assert.equal(team.handleTopicMessage(topicMsg(thread, '/report')), null, 'other commands are answered normally in the topic');
  const before = q.get('SELECT MAX(id) m FROM chat_messages').m || 0;
  assert.equal(team.handleTopicMessage(topicMsg(thread, 'Tolong ringkas tren kopi minggu ini')), '');
  const own = q.get('SELECT * FROM chat_messages WHERE id > ? AND sender_type = ?', before, 'owner');
  assert.equal(own.recipient_employee_id, emp.id);
  assert.equal(own.sender_name, 'Hafiz');
  const task = tasks.getTask(own.task_id);
  assert.match(task.created_by, /^chat:/);
  assert.equal(task.employee_id, emp.id);
  assert.ok(!tg.sent.some((m) => m.message_thread_id === thread && /Tolong ringkas/.test(m.text)), 'own Telegram message is not echoed back');
  // The employee answers (task completes): the reply appears in the topic with emoji, name, role, formatting.
  q.run("UPDATE tasks SET status = 'processing' WHERE id = ?", task.id);
  tasks.completeTask(task, '**Tren minggu ini**: kopi susu gula aren.\n- naik 35%\n- promo bundling');
  const msg = await waitFor(() => tg.sent.find((m) => m.message_thread_id === thread && /Tren minggu ini/.test(m.text)));
  assert.ok(msg.text.startsWith(`${team.personEmoji(emp)} <b>${emp.name}</b> · <i>`), msg.text.slice(0, 80));
  assert.match(msg.text, /<b>Tren minggu ini<\/b>[\s\S]*• naik 35%/);
  // /tugas and /catat in the CEO topic.
  const ceo = q.get('SELECT * FROM employees WHERE is_manager = 1');
  const ceoThread = team.topicOf(GROUP, ceo.id).thread_id;
  assert.match(team.handleTopicMessage(topicMsg(ceoThread, '/tugas Evaluasi semua bisnis bulan ini')), /Tugas dibuat: <b>T-\d{5}<\/b>/);
  assert.equal(q.get("SELECT kind FROM tasks WHERE title = 'Evaluasi semua bisnis bulan ini'").kind, 'instruction');
  assert.equal(team.handleTopicMessage(topicMsg(ceoThread, '/catat Rapat owner Jumat')), '📝 Dicatat (tanpa AI).');
  assert.equal(q.get("SELECT kind FROM chat_messages WHERE content = 'Rapat owner Jumat'").kind, 'note');
});

test('dashboard messages are mirrored into the topic; deleted topics are recreated; roster changes follow', async () => {
  const emp = q.get("SELECT * FROM employees WHERE enabled = 1 AND org_unit = 'shared' ORDER BY id DESC LIMIT 1");
  const thread = team.topicOf(GROUP, emp.id).thread_id;
  chat.sendOwnerMessage({ content: 'Catatan dari dashboard', recipientEmployeeId: emp.id, mode: 'note', ownerName: 'admin' });
  const mirrored = await waitFor(() => tg.sent.find((m) => m.message_thread_id === thread && /Catatan dari dashboard/.test(m.text)));
  assert.match(mirrored.text, /dashboard, catatan/);
  // Topic deleted in Telegram: the send fails, the mapping is dropped and the next sync creates a new topic.
  tg.state.deletedThreads.add(thread);
  chat.sendOwnerMessage({ content: 'Pesan kedua', recipientEmployeeId: emp.id, mode: 'note', ownerName: 'admin' });
  await waitFor(() => !team.topicOf(GROUP, emp.id));
  assert.ok(team.pendingTopicChanges().some((p) => p.employee_id === emp.id));
  await team.syncTeamTopics();
  assert.notEqual(team.topicOf(GROUP, emp.id).thread_id, thread);
  // Renamed employee -> topic renamed; new employee -> new topic (the scheduler runs maybeSyncTeam).
  q.run("UPDATE employees SET name = 'Rina Baru' WHERE id = ?", emp.id);
  const r = await team.syncTeamTopics();
  assert.equal(r.renamed, 1);
  assert.ok(tg.topics.some((t) => t.name.startsWith('Rina Baru · ')));
  const sync = (await s.post('/api/telegram/team/sync')).json();
  assert.equal(sync.created + sync.renamed, 0, 'nothing left to do');
});

test('/setchat in an employee topic is refused; in a topic it stores the topic; unlinking stops forwarding', async () => {
  const emp = q.get('SELECT * FROM employees WHERE enabled = 1 ORDER BY id LIMIT 1');
  const thread = team.topicOf(GROUP, emp.id).thread_id;
  assert.match(await handleCommand('/setchat', OWNER, GROUP, TZ, FORUM, thread), /Topik ini untuk berbicara dengan/);
  const rt = team.reportsTopic(GROUP).thread_id;
  assert.match(await handleCommand('/setchat', OWNER, GROUP, TZ, FORUM, rt), /dikirim ke topik ini/);
  assert.equal(q.get('SELECT report_thread_id FROM telegram_settings').report_thread_id, rt);
  // Daily report goes into the reports topic.
  assert.equal((await s.put('/api/telegram', { report_enabled: true })).statusCode, 200);
  const before = tg.sent.length;
  await sched.runDailyReport({ at: Date.UTC(2026, 10, 9, 12, 0), force: true });
  const sentNow = tg.sent.slice(before);
  assert.ok(sentNow.length >= 1 && sentNow.every((m) => m.message_thread_id === rt));
  // Unlink: topic messages are no longer routed.
  assert.equal((await s.del('/api/telegram/team')).statusCode, 200);
  assert.equal(team.handleTopicMessage(topicMsg(thread, 'halo')), null);
  assert.equal((await s.get('/api/telegram')).json().team, null);
});
