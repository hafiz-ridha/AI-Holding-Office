// Second Brain: work results become shared knowledge notes; quick chat replies (small talk) never do. Relevant notes
// reach every later AI call of the same scope (any model), with synonyms, pinned facts and a "done before" hint,
// and never cross businesses. Verified on the prompts actually sent to the mock provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';

let app, s, mock, q, worker, chat, kn, search, settings;
let coffee, wins, coffeeStaff, winsStaff;

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}
const task = (id) => q.get('SELECT * FROM tasks WHERE id = ?', id);
const done = (id) => waitFor(() => ['completed', 'failed'].includes(task(id)?.status) && task(id));
// Every prompt sent to the mock that mentions a marker (system + user messages joined).
const promptsWith = (marker) =>
  mock.calls.filter((c) => c.url === '/v1/chat/completions').map((c) => c.body.messages.map((m) => m.content).join('\n')).filter((p) => p.includes(marker));

async function direct(employee, business, title, description = '') {
  const r = await s.post('/api/tasks', { mode: 'direct', title, description, business_id: business?.id ?? null, employee_id: employee.id });
  assert.equal(r.statusCode, 201, r.body);
  return done(r.json().id);
}

before(async () => {
  await setupEnv();
  mock = await startMockProvider();
  ({ q } = await import('../src/db/index.js'));
  ({ worker } = await import('../src/queue/worker.js'));
  chat = await import('../src/holding/chat.js');
  kn = await import('../src/holding/knowledge.js');
  search = await import('../src/lib/search.js');
  settings = await import('../src/lib/settings.js');
  chat.startChatFeed();
  app = await buildTestApp();
  s = await login(app);
  await s.post('/api/providers', { preset: 'custom', name: 'Mock', base_url: mock.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 50 });
  coffee = q.get("SELECT * FROM businesses WHERE slug = 'coffee'");
  wins = q.get("SELECT * FROM businesses WHERE slug != 'coffee' ORDER BY id LIMIT 1");
  const emps = (await s.get('/api/employees')).json();
  coffeeStaff = emps.find((e) => e.org_unit === 'business' && e.business_ids.includes(coffee.id) && e.role_key !== 'business_manager');
  winsStaff = emps.find((e) => e.org_unit === 'business' && e.business_ids.includes(wins.id) && e.role_key !== 'business_manager');
});
after(async () => {
  chat.stopChatFeed();
  await worker.stop(1000);
  await app?.close();
  await mock?.close();
});

test('search widens keywords: stop words dropped, prefix match, business synonyms', () => {
  const m = search.ftsQuery('Tolong buat analisis omzet untuk cabang');
  assert.match(m, /"pendapatan"\*/);
  assert.match(m, /"revenue"\*/);
  assert.match(m, /"outlet"\*/);
  assert.doesNotMatch(m, /"tolong"|"untuk"|"buat"/);
  assert.equal(search.ftsQuery('dan yang untuk'), '');
  assert.ok(search.similarity('Riset kompetitor kopi Bandung', 'Riset kompetitor kopi di Bandung') > 0.8);
  assert.ok(search.similarity('Riset kompetitor kopi', 'Laporan gaji karyawan') < 0.2);
});

test('long results keep their summary and recommendation sections', () => {
  const long = `# Laporan\n${'Isi panjang. '.repeat(300)}\n## Ringkasan\nOmzet naik 12%.\n## Detail\n${'x '.repeat(500)}\n## Rekomendasi\nTambah stok.`;
  const d = kn.distill(long, 600);
  assert.match(d, /Omzet naik 12%/);
  assert.match(d, /Tambah stok/);
  assert.doesNotMatch(d, /Isi panjang/);
});

test('a finished work task becomes a note; a quick chat reply (small talk) does not', async () => {
  const t = await direct(coffeeStaff, coffee, 'Riset kompetitor kopi Bandung', 'Bandingkan harga dan promo pesaing. HASIL_PANJANG');
  assert.equal(t.status, 'completed');
  const note = q.get('SELECT * FROM knowledge_notes WHERE task_id = ?', t.id);
  assert.ok(note, 'work result stored');
  assert.equal(note.business_id, coffee.id);
  assert.equal(note.kind, 'work');
  assert.equal(note.model, 'ok-model');
  assert.equal(note.author, coffeeStaff.name);
  assert.match(note.content, /harga pesaing rata-rata/);

  // Quick chat reply: conversation, even when the answer is long. Not in the Second Brain, not in working memory.
  const r = await s.post('/api/chat', { channel: String(coffee.id), content: 'Halo, apa kabar tim? HASIL_PANJANG', mode: 'reply' });
  const chatTask = await done(r.json().task.id);
  assert.equal(chatTask.status, 'completed');
  assert.equal(q.get('SELECT COUNT(*) n FROM knowledge_notes WHERE task_id = ?', chatTask.id).n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM memories WHERE task_id = ?', chatTask.id).n, 0);

  // Trivial answers are not knowledge either.
  const short = await direct(coffeeStaff, coffee, 'Cek printer', 'cek printer kasir');
  assert.equal(q.get('SELECT COUNT(*) n FROM knowledge_notes WHERE task_id = ?', short.id).n, 0);
});

test('later work in the same business receives the note (synonyms work), other businesses never do', async () => {
  const src = q.get("SELECT * FROM knowledge_notes WHERE title = 'Riset kompetitor kopi Bandung'");
  // "pesaing" is a synonym of "kompetitor".
  const t = await direct(coffeeStaff, coffee, 'Strategi menghadapi pesaing', 'Susun langkah promo. MARK_SAME_BIZ');
  const [prompt] = promptsWith('MARK_SAME_BIZ');
  assert.match(prompt, /Second Brain/);
  assert.match(prompt, /\[K1\].*Riset kompetitor kopi Bandung/);
  assert.match(prompt, /model ok-model/);
  assert.deepEqual(JSON.parse(task(t.id).knowledge_refs).map((r) => r.id), [src.id]);
  assert.ok(q.get('SELECT use_count FROM knowledge_notes WHERE id = ?', src.id).use_count >= 1);

  await direct(winsStaff, wins, 'Strategi menghadapi pesaing kompetitor', 'Susun langkah promo. MARK_OTHER_BIZ');
  const [other] = promptsWith('MARK_OTHER_BIZ');
  assert.doesNotMatch(other, /Riset kompetitor kopi Bandung/);
  assert.doesNotMatch(other, /harga pesaing rata-rata/);
});

test('doing the same task again tells the AI to build on the earlier result', async () => {
  await direct(coffeeStaff, coffee, 'Riset kompetitor kopi Bandung', 'Perbarui riset. MARK_AGAIN');
  const [prompt] = promptsWith('MARK_AGAIN');
  assert.match(prompt, /Tugas serupa pernah dikerjakan \(\[K1\]\)/);
  assert.match(prompt, /jangan mengulang dari nol/);
});

test('pinned owner facts always reach the AI of their scope, also in quick chat replies', async () => {
  const f = await s.post('/api/knowledge', { scope: String(coffee.id), title: 'Target omzet Q4', content: 'Target omzet Coffee Q4 = Rp50 juta per bulan.' });
  assert.equal(f.statusCode, 201, f.body);
  assert.equal(f.json().pinned, true);
  assert.equal((await s.post('/api/knowledge', { scope: 'all', title: 'x', content: 'y' })).statusCode, 400);

  await direct(coffeeStaff, coffee, 'Cek jadwal shift', 'Jadwal minggu depan. MARK_PINNED');
  assert.match(promptsWith('MARK_PINNED')[0], /📌 .*FAKTA dari admin — Target omzet Q4/);
  await direct(winsStaff, wins, 'Cek jadwal shift', 'Jadwal minggu depan. MARK_PINNED_OTHER');
  assert.doesNotMatch(promptsWith('MARK_PINNED_OTHER')[0], /Rp50 juta/);

  // Small talk gets no knowledge at all (not even pinned facts): it would only cost tokens.
  const hi = await s.post('/api/chat', { channel: String(coffee.id), content: 'Halo tim, apa kabar? Terima kasih ya', mode: 'reply' });
  const hiTask = await done(hi.json().task.id);
  assert.equal(hiTask.knowledge_refs, null);

  // Quick replies may READ the knowledge (they just are not stored), and the answer shows what was used.
  const r = await s.post('/api/chat', { channel: String(coffee.id), content: 'Berapa target omzet kita?', mode: 'reply' });
  const id = r.json().task.id;
  const reply = await waitFor(async () => (await s.get(`/api/chat?channel=${coffee.id}&limit=200`)).json().messages.find((m) => m.task_id === id && m.kind === 'message' && m.sender_type === 'employee'));
  assert.ok(reply.model.refs.some((x) => x.title === 'Target omzet Q4'));
  assert.ok((await s.get(`/api/tasks/${id}`)).json().task.knowledge_refs.some((x) => x.title === 'Target omzet Q4'));
});

test('holding reports are only recalled by the Group CEO with cross-business permission', () => {
  const t0 = Date.now();
  const rid = q.run(`INSERT INTO knowledge_notes(business_id, kind, title, content, ceo_only, importance, created_at, updated_at)
    VALUES (NULL, 'work', 'Laporan konsolidasi holding omzet', 'Omzet semua bisnis naik.', 1, 2, ?, ?)`, t0, t0).lastInsertRowid;
  const ceo = q.get('SELECT * FROM employees WHERE is_manager = 1');
  const dev = q.get("SELECT * FROM employees WHERE role_key = 'developer'");
  const holdingTask = { id: -1, title: 'Evaluasi omzet holding', description: '', business_id: null };
  const ids = (emp) => kn.recallKnowledge({ task: holdingTask, employee: emp }).notes.map((n) => n.id);
  assert.ok(ids(ceo).includes(rid));
  assert.ok(!ids(dev).includes(rid));
  settings.setSetting('group_ceo_cross_business', false);
  assert.ok(!ids(ceo).includes(rid));
  settings.setSetting('group_ceo_cross_business', true);
  // A business task never sees holding-level notes.
  assert.ok(!kn.recallKnowledge({ task: { ...holdingTask, business_id: coffee.id }, employee: ceo }).notes.some((n) => n.id === rid));
});

test('API: search with synonyms, pin, correct and delete notes', async () => {
  const list = (await s.get(`/api/knowledge?scope=${coffee.id}&q=pendapatan`)).json(); // matches "omzet" via synonym
  assert.ok(list.items.some((n) => n.title === 'Target omzet Q4'));
  assert.ok(list.stats.total >= 2);
  const work = q.get("SELECT id FROM knowledge_notes WHERE title = 'Riset kompetitor kopi Bandung'");
  const upd = await s.put(`/api/knowledge/${work.id}`, { content: 'Harga pesaing dikoreksi: Rp30.000.', pinned: true });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().pinned, true);
  assert.equal((await s.get(`/api/knowledge?q=dikoreksi`)).json().items[0].id, work.id, 'FTS index follows edits');
  assert.equal((await s.del(`/api/knowledge/${work.id}`)).statusCode, 200);
  assert.equal((await s.get(`/api/knowledge/${work.id}`)).statusCode, 404);
  assert.equal((await s.get('/api/knowledge?q=dikoreksi')).json().total, 0);
});

test('backfill turns earlier work into notes (still skipping chat replies); switching off stops capture and recall', async () => {
  const firstRun = q.get("SELECT id FROM tasks WHERE title = 'Riset kompetitor kopi Bandung' ORDER BY id LIMIT 1").id;
  q.run("DELETE FROM knowledge_notes WHERE kind = 'work'");
  const n = kn.backfillKnowledge();
  assert.ok(n >= 1);
  assert.ok(q.get('SELECT id FROM knowledge_notes WHERE task_id = ?', firstRun), 'earlier work result is back as a note');
  const chatTasks = q.all("SELECT id FROM tasks WHERE description LIKE '%Pesan obrolan dari owner%'").map((r) => r.id);
  assert.ok(chatTasks.length >= 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM knowledge_notes WHERE task_id IN (${chatTasks.join(',')})`).n, 0);

  settings.setSetting('knowledge_enabled', false);
  const t = await direct(coffeeStaff, coffee, 'Riset kompetitor kopi Bandung', 'Lagi. HASIL_PANJANG MARK_OFF');
  assert.doesNotMatch(promptsWith('MARK_OFF')[0], /Second Brain/);
  assert.equal(q.get('SELECT COUNT(*) n FROM knowledge_notes WHERE task_id = ?', t.id).n, 0);
  settings.setSetting('knowledge_enabled', true);
});
