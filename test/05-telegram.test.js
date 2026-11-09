// Telegram: settings validation, whitelist, commands (incl. dynamic /business <slug>), holding daily report
// sent exactly once per day, retry after failure, notifications, bot long polling end-to-end, and the report
// destination: Chat ID checked on save, /setchat, explained "chat not found", supergroup migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockTelegram } from './mock-telegram.js';

let tg, app, s, q, sched, bot, handleCommand, notifier, bus;
const OWNER = { id: 5550001, first_name: 'Owner' };
const STRANGER = { id: 999, first_name: 'X' };

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

before(async () => {
  tg = await startMockTelegram();
  process.env.TELEGRAM_API_BASE = tg.base;
  const { config } = await import('../src/config.js');
  config.telegramApiBase = tg.base;
  await setupEnv();
  ({ q } = await import('../src/db/index.js'));
  sched = await import('../src/scheduler/index.js');
  ({ bot, handleCommand } = await import('../src/telegram/bot.js'));
  notifier = await import('../src/telegram/notifier.js');
  ({ bus } = await import('../src/events.js'));
  app = await buildTestApp();
  s = await login(app);
});
after(async () => {
  await bot.stop();
  notifier.stopNotifier();
  await app?.close();
  await tg?.close();
});

test('bot token is validated with getMe, stored encrypted, and never returned', async () => {
  const bad = await s.put('/api/telegram', { bot_token: 'not-a-token' });
  assert.equal(bad.statusCode, 400);
  const r = await s.put('/api/telegram', {
    bot_token: tg.token, chat_id: '-100123456', allowed_user_ids: [String(OWNER.id)],
    report_enabled: true, report_time: '18:00', timezone: 'Asia/Jakarta', polling_enabled: false,
  });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.settings.bot_username, 'holding_test_bot');
  assert.ok(!JSON.stringify(body).includes(tg.token));
  assert.ok(q.get('SELECT bot_token_enc FROM telegram_settings').bot_token_enc.startsWith('v1:'));
});

test('unauthorised users are ignored; /start tells them their ID only', async () => {
  assert.equal(await handleCommand('/overview', STRANGER, 1, 'Asia/Jakarta'), undefined);
  assert.equal(await handleCommand('/pause', STRANGER, 1, 'Asia/Jakarta'), undefined);
  const start = await handleCommand('/start', STRANGER, 1, 'Asia/Jakarta');
  assert.match(start, /Akses ditolak/);
  assert.match(start, /999/);
});

test('holding commands: /overview /companies /business <slug> /finance /tasks /report', async () => {
  const tz = 'Asia/Jakarta';
  const coffee = q.get("SELECT id FROM businesses WHERE slug = 'coffee'").id;
  q.run(`INSERT INTO financial_records(business_id, record_date, type, category, amount, currency, created_at, updated_at)
         VALUES (?, strftime('%Y-%m-%d','now','+7 hours'), 'income', 'penjualan', 2500000, 'IDR', 0, 0)`, coffee);
  assert.match(await handleCommand('/overview', OWNER, 1, tz), /HOLDING OVERVIEW[\s\S]*Wins Court[\s\S]*Coffee Business/);
  const companies = await handleCommand('/companies', OWNER, 1, tz);
  assert.match(companies, /\/business wins-court/);
  assert.match(companies, /\/business it-technology/);
  const biz = await handleCommand('/business coffee', OWNER, 1, tz);
  assert.match(biz, /LAPORAN BISNIS: Coffee Business/);
  assert.match(biz, /2\.500\.000/);
  assert.ok(!/Wins Court/.test(biz), 'single-business report contains only that business');
  assert.match(await handleCommand('/business nope', OWNER, 1, tz), /tidak ditemukan/);
  const fin = await handleCommand('/finance', OWNER, 1, tz);
  assert.match(fin, /Coffee Business[\s\S]*2\.500\.000/);
  assert.match(fin, /Wins Court[\s\S]*DATA NOT AVAILABLE/);
  assert.match(await handleCommand('/tasks coffee', OWNER, 1, tz), /Tugas aktif — Coffee Business/);
  const report = await handleCommand('/report', OWNER, 1, tz);
  for (const h of ['AI VIRTUAL HOLDING', 'DAILY REPORT', 'GROUP OVERVIEW:', 'BUSINESS REPORTS:', 'SHARED SERVICES:', 'CEO RECOMMENDATIONS:']) {
    assert.ok(report.includes(h), `missing ${h}`);
  }
});

test('/pause and /resume control the queue; /task creates holding and business tasks', async () => {
  const settings = await import('../src/lib/settings.js');
  await handleCommand('/pause', OWNER, 1, 'Asia/Jakarta');
  assert.equal(settings.getSetting('queue_paused'), true);
  const r1 = await handleCommand('/task Evaluasi semua bisnis minggu ini', OWNER, 1, 'Asia/Jakarta');
  assert.match(r1, /Group CEO/);
  const r2 = await handleCommand('/task @coffee Buat promo akhir pekan', OWNER, 1, 'Asia/Jakarta');
  assert.match(r2, /Business Manager/);
  const t = q.get("SELECT * FROM tasks WHERE title = 'Buat promo akhir pekan'");
  assert.equal(t.kind, 'business');
  assert.equal(t.business_id, q.get("SELECT id FROM businesses WHERE slug = 'coffee'").id);
  await handleCommand('/resume', OWNER, 1, 'Asia/Jakarta');
  assert.equal(settings.getSetting('queue_paused'), false);
  settings.setSetting('queue_paused', true); // keep the (unstarted) worker idle for the rest of the file
});

test('daily report is sent once per day even if triggered repeatedly / after restart', async () => {
  const before = tg.sent.length;
  const at = Date.UTC(2026, 10, 7, 12, 0); // 19:00 WIB, after 18:00
  const early = await sched.runDailyReport({ at: Date.UTC(2026, 10, 7, 9, 0) }); // 16:00 WIB
  assert.equal(early.skipped, 'not time yet');
  const r1 = await sched.runDailyReport({ at });
  assert.equal(r1.sent, true);
  const r2 = await sched.runDailyReport({ at: at + 60_000 });
  assert.equal(r2.skipped, 'already sent');
  // Simulated restart: module state is irrelevant, the DB row decides.
  const r3 = await sched.runDailyReport({ at: at + 3600_000, force: true });
  assert.equal(r3.skipped, 'already sent');
  // One report, delivered as several natural messages (greeting first), all of them right after the first run.
  const msgs = tg.sent.slice(before);
  assert.ok(msgs.length >= 3, `split into ${msgs.length} messages`);
  assert.ok(msgs.every((m) => m.chat_id === '-100123456'));
  assert.match(msgs[0].text, /^Selamat malam! 👋 Ini laporan harian AI Virtual Holding\.$/);
  assert.match(msgs.map((m) => m.text).join('\n'), /Tanggal: 07-11-2026[\s\S]*CEO RECOMMENDATIONS:/);
  assert.equal(q.get("SELECT COUNT(*) n FROM telegram_reports WHERE type = 'daily_report' AND report_date = '2026-11-07'").n, 1);
});

test('failed daily report is retried later, at most 3 attempts', async () => {
  tg.state.failSend = true;
  const at = Date.UTC(2026, 10, 8, 12, 0);
  const r1 = await sched.runDailyReport({ at });
  assert.equal(r1.sent, false);
  assert.equal((await sched.runDailyReport({ at: at + 1000 })).skipped, 'already sent', 'no immediate retry');
  tg.state.failSend = false;
  // Make the failed row old enough for a retry.
  q.run("UPDATE telegram_reports SET updated_at = updated_at - 600000 WHERE report_date = '2026-11-08'");
  const r2 = await sched.runDailyReport({ at: at + 2000 });
  assert.equal(r2.sent, true);
  const row = q.get("SELECT status, attempts FROM telegram_reports WHERE report_date = '2026-11-08'");
  assert.deepEqual([row.status, row.attempts], ['sent', 2]);
});

test('notifications: completed holding task and owner approval are pushed to Telegram', async () => {
  notifier.startNotifier({ warn() {} });
  const before = tg.sent.length;
  bus.emit('task:completed', { task: { id: 42, kind: 'instruction', title: 'Evaluasi', result: '## Ringkasan\nOK', provider_name: 'Mock', model_used: 'm', business_id: null } });
  bus.emit('approval:created', { task: { id: 43, title: 'Promo', business_id: q.get("SELECT id FROM businesses WHERE slug='coffee'").id }, ids: [1], items: ['Transfer dana promosi'] });
  bus.emit('task:completed', { task: { id: 44, kind: 'subtask', title: 'sub', result: 'x' } }); // subtasks muted by default
  await waitFor(() => notifier.notifierIdle() && tg.sent.length - before === 2);
  assert.match(tg.sent.at(-2).text, /Tugas selesai/);
  assert.match(tg.sent.at(-1).text, /Persetujuan owner dibutuhkan[\s\S]*Coffee Business/);
  notifier.stopNotifier();
});

test('long polling end-to-end: authorised command gets a reply, stranger is ignored', async () => {
  const on = await s.put('/api/telegram', { polling_enabled: true });
  // The save response already reports the live status (no stale "stopped" until the first poll returns).
  assert.equal(on.json().bot.status, 'running');
  tg.updates.push(
    { update_id: 10, message: { message_id: 1, text: '/companies', from: OWNER, chat: { id: 777 } } },
    { update_id: 11, message: { message_id: 2, text: '/overview', from: STRANGER, chat: { id: 888 } } }
  );
  await waitFor(() => tg.sent.some((m) => m.chat_id === 777));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!tg.sent.some((m) => m.chat_id === 888), 'stranger got no reply');
  assert.equal(q.get('SELECT last_update_id FROM telegram_settings').last_update_id, 11);
  await bot.stop();
});

const DEST = '-100123456';
const restore = () => {
  q.run('UPDATE telegram_settings SET chat_id = ? WHERE id = 1', DEST);
  tg.state.unknownChats.clear();
  tg.state.migrate = null;
};

test('a wrong Chat ID is caught on save: the bot\'s own id and a chat the bot cannot reach', async () => {
  try {
    const own = await s.put('/api/telegram', { chat_id: tg.token.split(':')[0] });
    assert.equal(own.statusCode, 400);
    assert.match(own.json().error, /ID bot Anda sendiri/);
    tg.state.unknownChats.add('5550009');
    const unknown = await s.put('/api/telegram', { chat_id: '5550009' });
    assert.equal(unknown.statusCode, 400);
    assert.match(unknown.json().error, /tidak bisa mengirim ke Chat ID 5550009[\s\S]*\/setchat/);
    assert.equal(q.get('SELECT chat_id FROM telegram_settings').chat_id, DEST, 'nothing saved');
    const ok = await s.put('/api/telegram', { chat_id: String(OWNER.id) });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().chat.label, 'Owner (@owner_holding)');
    // Saving other fields does not re-check an unchanged chat.
    tg.state.unknownChats.add(String(OWNER.id));
    assert.equal((await s.put('/api/telegram', { report_time: '18:30' })).statusCode, 200);
  } finally {
    restore();
  }
});

test('/setchat makes the current chat the report destination; /start says where reports go', async () => {
  try {
    const chat = { id: 777, type: 'private', first_name: 'Owner' };
    const start = await handleCommand('/start', OWNER, 777, 'Asia/Jakarta', chat);
    assert.match(start, new RegExp(`dikirim ke Chat ID <code>${DEST}</code>[\\s\\S]*/setchat`));
    assert.equal(await handleCommand('/setchat', STRANGER, 888, 'Asia/Jakarta', { id: 888, type: 'private' }), undefined, 'strangers cannot');
    assert.equal(q.get('SELECT chat_id FROM telegram_settings').chat_id, DEST);
    const set = await handleCommand('/setchat', OWNER, 777, 'Asia/Jakarta', chat);
    assert.match(set, /sekarang dikirim ke chat ini \(Owner\)/);
    assert.equal(q.get('SELECT chat_id FROM telegram_settings').chat_id, '777');
    assert.ok(q.get("SELECT COUNT(*) n FROM audit_logs WHERE action = 'telegram_chat_set'").n >= 1);
    assert.match(await handleCommand('/start', OWNER, 777, 'Asia/Jakarta', chat), /dikirim ke chat ini/);
    // The dashboard knows the chat the owner last wrote from (offered as a one-click fix).
    const d = (await s.get('/api/telegram')).json();
    assert.equal(d.last_command_chat.chat_id, '777');
    assert.equal(d.last_command_chat.label, 'Owner');
    assert.ok(d.commands.some((c) => c.command === '/setchat'));
  } finally {
    restore();
  }
});

test('automatic sends: "chat not found" is explained; a group upgraded to a supergroup is followed', async () => {
  try {
    tg.state.unknownChats.add('424242');
    q.run('UPDATE telegram_settings SET chat_id = ? WHERE id = 1', '424242');
    await assert.rejects(notifier.sendText('424242', 'halo'), /chat not found[\s\S]*\/setchat/);
    const test = (await s.post('/api/telegram/test')).json();
    assert.equal(test.ok, false);
    assert.match(test.error, /\/setchat/);
    const d = (await s.get('/api/telegram')).json();
    assert.equal(d.last_auto.status, 'failed');
    assert.equal(d.last_auto.chat_id, '424242');
    // Supergroup migration: the new id is used and saved as the destination.
    q.run('UPDATE telegram_settings SET chat_id = ? WHERE id = 1', '-200');
    tg.state.migrate = { from: '-200', to: -1009999 };
    await notifier.sendText('-200', 'halo grup');
    assert.equal(tg.sent.at(-1).chat_id, -1009999);
    assert.equal(q.get('SELECT chat_id FROM telegram_settings').chat_id, '-1009999');
  } finally {
    restore();
  }
});

test('long reports are sent as several natural messages with "typing…"; short ones stay one message; can be switched off', async () => {
  const { naturalParts } = await import('../src/lib/text.js');
  const { buildHoldingReport } = await import('../src/telegram/report.js');
  const report = buildHoldingReport('Asia/Jakarta').text;
  const parts = naturalParts(report);
  assert.ok(parts.length >= 4, `${parts.length} parts`);
  assert.equal(parts.join('\n\n').replace(/\s+/g, ' '), report.trim().replace(/\s+/g, ' '), 'nothing lost or reordered');
  assert.match(parts[0], /DAILY REPORT[\s\S]*GROUP OVERVIEW:/, 'header stays with the overview');
  // One message per business; the section heading stays with the first business.
  const biz = parts.filter((p) => /^(<b>BUSINESS REPORTS:<\/b>\n)?▸ /.test(p));
  assert.ok(biz.length >= 2 && /^<b>BUSINESS REPORTS:<\/b>\n▸ /.test(biz[0]));
  assert.ok(parts.every((p) => p.length <= 3900));
  assert.deepEqual(naturalParts('Pesan pendek.\n\nBaris kedua.'), ['Pesan pendek.\n\nBaris kedua.']);
  // Sending: typing indicator before each part, then each part as its own message.
  const sentBefore = tg.sent.length;
  const typingBefore = tg.actions.length;
  await notifier.sendText(DEST, report, undefined, { intro: 'Halo!' });
  const sent = tg.sent.slice(sentBefore);
  assert.equal(sent.length, parts.length + 1);
  assert.equal(sent[0].text, 'Halo!');
  assert.equal(tg.actions.length - typingBefore, sent.length);
  assert.ok(tg.actions.slice(typingBefore).every((a) => a.action === 'typing'));
  // Switched off on the Telegram page: one message (only split at Telegram's 4096-character limit).
  try {
    assert.equal((await s.put('/api/telegram', { split_messages: false })).json().settings.split_messages, false);
    const n = tg.sent.length;
    await notifier.sendText(DEST, report);
    assert.equal(tg.sent.length - n, 1);
  } finally {
    await s.put('/api/telegram', { split_messages: true });
  }
});
