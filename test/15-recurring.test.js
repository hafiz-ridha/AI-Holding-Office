// Recurring tasks: schedule maths (daily, weekdays, weekly, monthly, every N hours) in the holding timezone,
// API validation, each due run creates exactly one task (also when the scheduler ticks twice or after downtime),
// skip while the previous run is still active, run now, enable/disable, delete keeps created tasks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';

let app, s, q, rec, bizId;
const TZ = 'Asia/Jakarta'; // UTC+7, no DST
const wib = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh - 7, mm); // local WIB time -> UTC ms

before(async () => {
  await setupEnv();
  ({ q } = await import('../src/db/index.js'));
  rec = await import('../src/holding/recurring.js');
  app = await buildTestApp();
  s = await login(app);
  bizId = q.get("SELECT id FROM businesses WHERE status = 'active' ORDER BY id LIMIT 1").id;
});
after(async () => {
  await app?.close();
});

test('next run: daily, weekdays, weekly, monthly and every N hours in the holding timezone', () => {
  const mon7 = wib(2026, 11, 9, 7); // Monday 9 Nov 2026, 07:00 WIB
  const next = (r, from = mon7) => rec.nextRunAt(r, from, TZ);
  assert.equal(next({ frequency: 'daily', time_of_day: '08:00' }), wib(2026, 11, 9, 8));
  assert.equal(next({ frequency: 'daily', time_of_day: '06:00' }), wib(2026, 11, 10, 6), 'already passed today -> tomorrow');
  assert.equal(next({ frequency: 'weekdays', time_of_day: '08:00' }, wib(2026, 11, 13, 9)), wib(2026, 11, 16, 8), 'Friday after 08:00 -> Monday');
  assert.equal(next({ frequency: 'weekly', weekdays: [2, 4], time_of_day: '09:00' }), wib(2026, 11, 10, 9), 'next Tuesday');
  assert.equal(next({ frequency: 'weekly', weekdays: '[7]', time_of_day: '09:00' }), wib(2026, 11, 15, 9), 'Sunday (stored as JSON)');
  assert.equal(next({ frequency: 'monthly', day_of_month: 1, time_of_day: '09:00' }), wib(2026, 12, 1, 9));
  assert.equal(next({ frequency: 'hours', every_hours: 6, time_of_day: '08:00' }), wib(2026, 11, 9, 8));
  assert.equal(next({ frequency: 'hours', every_hours: 6, time_of_day: '08:00' }, wib(2026, 11, 9, 15)), wib(2026, 11, 9, 20));
  assert.equal(rec.describeSchedule({ frequency: 'weekly', weekdays: [1, 4], time_of_day: '09:00' }), 'Setiap Senin & Kamis pukul 09:00');
  assert.equal(rec.describeSchedule({ frequency: 'hours', every_hours: 6, time_of_day: '08:00' }), 'Setiap 6 jam mulai pukul 08:00');
});

test('API: templates, validation, create with a computed next run', async () => {
  const tpl = (await s.get('/api/recurring/templates')).json();
  for (const k of ['news', 'trend', 'social', 'competitor', 'report']) assert.ok(tpl.some((t) => t.key === k), `template ${k}`);
  assert.ok(tpl.find((t) => t.key === 'trend').description.includes('internet'), 'templates ask for fresh web data');
  const base = { title: 'Riset tren pasar', mode: 'business', business_id: bizId, frequency: 'weekly', weekdays: [1], time_of_day: '08:00' };
  assert.equal((await s.post('/api/recurring', { ...base, weekdays: [] })).statusCode, 400, 'weekly needs a day');
  assert.equal((await s.post('/api/recurring', { ...base, business_id: null })).statusCode, 400, 'business task needs a business');
  assert.equal((await s.post('/api/recurring', { ...base, frequency: 'hours', every_hours: 0 })).statusCode, 400);
  assert.equal((await s.post('/api/recurring', { ...base, time_of_day: '25:00' })).statusCode, 400);
  const r = await s.post('/api/recurring', { ...base, template: 'trend' });
  assert.equal(r.statusCode, 201, r.body);
  const body = r.json();
  assert.equal(body.schedule, 'Setiap Senin pukul 08:00');
  assert.ok(body.next_run_at > Date.now());
  assert.ok(q.get("SELECT COUNT(*) n FROM audit_logs WHERE action = 'recurring_created'").n >= 1);
  const list = (await s.get('/api/recurring')).json();
  assert.ok(list.some((x) => x.id === body.id && x.business_name));
});

test('a due run creates exactly one task (twice-ticking scheduler, downtime catch-up once)', async () => {
  const r = rec.createRecurring({ title: 'Ringkasan berita industri', mode: 'holding', frequency: 'daily', time_of_day: '07:30', description: 'Berita hari ini' });
  // Due three days ago (server was down): caught up once, then scheduled in the future.
  q.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ?', Date.now() - 3 * 86400_000, r.id);
  const first = rec.runDueRecurring();
  const again = rec.runDueRecurring();
  assert.equal(first.filter((x) => x.id === r.id).length, 1);
  assert.equal(again.filter((x) => x.id === r.id).length, 0, 'second tick creates nothing');
  const tasks = q.all('SELECT * FROM tasks WHERE recurring_id = ?', r.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /^Ringkasan berita industri · \d{2}-\d{2}-\d{4}$/);
  assert.equal(tasks[0].created_by, `recurring:${r.id}`);
  assert.equal(tasks[0].kind, 'instruction');
  assert.match(tasks[0].description, /Tugas berulang \(Setiap hari pukul 07:30\)/);
  const after = rec.getRecurring(r.id);
  assert.ok(after.next_run_at > Date.now());
  assert.equal(after.run_count, 1);
  assert.equal(after.last_task_id, tasks[0].id);
  // Task list can be filtered by the rule and shows where a task came from.
  const listed = (await s.get(`/api/tasks?recurring_id=${r.id}`)).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].recurring_id, r.id);
});

test('skips a run while the previous task is still active; run now always creates one', async () => {
  const r = rec.createRecurring({ title: 'Ide konten media sosial', mode: 'business', business_id: bizId, frequency: 'daily', time_of_day: '09:00' });
  q.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ?', Date.now() - 1000, r.id);
  rec.runDueRecurring();
  const firstTask = rec.getRecurring(r.id).last_task_id;
  assert.ok(firstTask);
  // Previous task still pending -> next due run is skipped.
  q.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ?', Date.now() - 1000, r.id);
  const res = rec.runDueRecurring().find((x) => x.id === r.id);
  assert.equal(res.skipped, true);
  assert.equal(rec.getRecurring(r.id).last_status, 'skipped');
  assert.equal(q.get('SELECT COUNT(*) n FROM tasks WHERE recurring_id = ?', r.id).n, 1);
  // "Jalankan sekarang" ignores the skip rule and keeps the schedule.
  const before = rec.getRecurring(r.id).next_run_at;
  const now = await s.post(`/api/recurring/${r.id}/run`);
  assert.equal(now.statusCode, 200, now.body);
  assert.ok(now.json().task_id);
  assert.equal(q.get('SELECT COUNT(*) n FROM tasks WHERE recurring_id = ?', r.id).n, 2);
  assert.equal(rec.getRecurring(r.id).next_run_at, before);
});

test('disable / edit schedule / errors are recorded / delete keeps the created tasks', async () => {
  const r = rec.createRecurring({ title: 'Pantauan kompetitor', mode: 'business', business_id: bizId, frequency: 'weekly', weekdays: [3], time_of_day: '10:00' });
  const off = await s.put(`/api/recurring/${r.id}`, { enabled: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().next_run_at, null);
  q.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ?', Date.now() - 1000, r.id); // even if a stale time remains
  assert.equal(rec.runDueRecurring().filter((x) => x.id === r.id).length, 0, 'disabled rules never run');
  const on = (await s.put(`/api/recurring/${r.id}`, { enabled: true, frequency: 'hours', every_hours: 4, time_of_day: '06:00' })).json();
  assert.equal(on.schedule, 'Setiap 4 jam mulai pukul 06:00');
  assert.ok(on.next_run_at > Date.now() && on.next_run_at - Date.now() <= 4 * 3600_000 + 60_000);
  // Business switched off: the run is recorded as an error (and alerts), the scheduler keeps going.
  q.run("UPDATE businesses SET status = 'inactive' WHERE id = ?", bizId);
  q.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ?', Date.now() - 1000, r.id);
  const res = rec.runDueRecurring().find((x) => x.id === r.id);
  assert.match(res.error, /nonaktif/);
  assert.equal(rec.getRecurring(r.id).last_status, 'error');
  q.run("UPDATE businesses SET status = 'active' WHERE id = ?", bizId);
  // Delete: the rule is gone, tasks it created stay.
  await s.post(`/api/recurring/${r.id}/run`);
  const made = q.get('SELECT id FROM tasks WHERE recurring_id = ?', r.id).id;
  assert.equal((await s.del(`/api/recurring/${r.id}`)).statusCode, 200);
  assert.equal(rec.getRecurring(r.id), null);
  assert.ok(q.get('SELECT id, recurring_id FROM tasks WHERE id = ?', made));
  assert.equal(q.get('SELECT recurring_id FROM tasks WHERE id = ?', made).recurring_id, null);
});
