// AI employees as agents: the <tool_call> protocol, tools (Google Drive, Second Brain), errors and the step limit,
// important tools that become owner approvals and run only after approval, automatic saving of results/reports to
// Google Drive with retries, and business isolation of Drive files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';
import { startMockGoogle, CLIENT_ID, CLIENT_SECRET } from './mock-google.js';

let ai, g, app, s, q, tasks, worker, svc, settings, agent, tools, artifacts, chat;

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}
const done = (id) => waitFor(() => {
  const t = tasks.getTask(id);
  return ['completed', 'failed', 'cancelled'].includes(t.status) && t;
});
const logs = (id, event) => q.all('SELECT message FROM task_logs WHERE task_id = ? AND event = ? ORDER BY id', id, event).map((r) => r.message);
const shared = () => q.get("SELECT * FROM employees WHERE enabled = 1 AND org_unit = 'shared' AND role_key = 'secretary'");

before(async () => {
  g = await startMockGoogle();
  const { config } = await import('../src/config.js');
  config.googleOAuthBase = g.base;
  config.googleApiBase = g.base;
  await setupEnv();
  ai = await startMockProvider();
  ({ q } = await import('../src/db/index.js'));
  tasks = await import('../src/queue/tasks.js');
  ({ worker } = await import('../src/queue/worker.js'));
  svc = await import('../src/providers/service.js');
  settings = await import('../src/lib/settings.js');
  agent = await import('../src/agents/agent.js');
  tools = await import('../src/agents/tools/index.js');
  artifacts = await import('../src/connections/artifacts.js');
  chat = await import('../src/holding/chat.js');
  app = await buildTestApp();
  s = await login(app);
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: ai.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  // Link Google Drive the way the owner does: client, code, approve at Google, check.
  assert.equal((await s.put('/api/connections/google_drive', { client_id: CLIENT_ID, client_secret: CLIENT_SECRET })).statusCode, 200);
  assert.equal((await s.post('/api/connections/google_drive/connect')).statusCode, 200);
  g.state.approved = true;
  assert.equal((await s.post('/api/connections/google_drive/poll')).json().state, 'connected');
  chat.startChatFeed();
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 50 });
});
after(async () => {
  await worker.stop(1000);
  chat.stopChatFeed();
  (await import('../src/connections/google.js')).resetGoogleState();
  await app?.close();
  await ai?.close();
  await g?.close();
});

test('protocol: tool calls are parsed from model replies; arguments are validated', () => {
  const { parseToolCall, stripToolCalls } = agent;
  assert.deepEqual(parseToolCall('Saya cari dulu.\n<tool_call>{"name": "web_cari", "args": {"query": "kopi"}}</tool_call>'), { name: 'web_cari', args: { query: 'kopi' }, before: 'Saya cari dulu.' });
  assert.equal(parseToolCall('<tool_call>{"name":"web_cari","args":{"query":"x"}}').name, 'web_cari', 'unclosed tag');
  assert.equal(parseToolCall('```tool_call\n{"tool": "catatan_cari", "arguments": {"query": "y"}}\n```').name, 'catatan_cari', 'fenced variant, other key names');
  assert.equal(parseToolCall('<tool_call>{"name": "a", "args": {"isi": "baris 1\nbaris 2"}}</tool_call>').args.isi, 'baris 1\nbaris 2', 'raw line break in a string');
  assert.match(parseToolCall('<tool_call>{name: a}</tool_call>').error, /bukan JSON/);
  assert.equal(parseToolCall('## Ringkasan\nJawaban akhir biasa.'), null);
  assert.equal(stripToolCalls('Halo <tool_call>{"name":"x"}</tool_call> dunia'), 'Halo  dunia');

  const save = tools.getTool('drive_simpan_dokumen');
  assert.deepEqual(tools.validateArgs(save, { judul: 'A' }), { ok: true, args: { judul: 'A', jenis: 'dokumen' } });
  assert.match(tools.validateArgs(save, {}).error, /judul.*wajib/);
  assert.match(tools.validateArgs(save, { judul: 'A', jenis: 'video' }).error, /dokumen, laporan/);
  assert.match(tools.validateArgs(tools.getTool('drive_bagikan'), { file: '#1', email: 'bukan-email' }).error, /email/);
  const manual = tools.toolManual(tools.toolsFor(shared(), { id: 1 }));
  assert.match(manual, /<tool_call>/);
  assert.match(manual, /drive_bagikan \[perlu izin owner\]/);
  assert.match(manual, /drive_simpan_dokumen: /);
});

test('the agent saves a document to Google Drive and answers with its link', async () => {
  const emp = shared();
  const t = tasks.createTask({ kind: 'direct', title: 'Buat SOP barista', description: 'AGENT_DOC buat SOP barista', employeeId: emp.id });
  const r = await done(t.id);
  assert.equal(r.status, 'completed', r.error);
  const doc = g.docs().find((d) => d.name === 'SOP Barista');
  assert.ok(doc, 'Google Doc created');
  assert.equal(g.pathOf(doc), 'AI Office/Holding (HQ)/Dokumen');
  assert.match(doc.html, /<h1>SOP Barista<\/h1>[\s\S]*<ol>\s*<li>Cuci tangan<\/li>[\s\S]*<b>Wajib<\/b>/);
  assert.match(r.result, new RegExp(`SOP sudah saya simpan di Google Drive: https://docs.google.com/document/d/${doc.id}/edit`));
  const a = q.get('SELECT * FROM artifacts WHERE task_id = ?', t.id);
  assert.deepEqual([a.status, a.source, a.kind, a.employee_id, a.content], ['synced', 'agent', 'document', emp.id, null]);
  assert.equal(q.get('SELECT COUNT(*) n FROM artifacts WHERE task_id = ?', t.id).n, 1, 'no second (automatic) copy');
  assert.match(logs(t.id, 'tool_call')[0], /^drive_simpan_dokumen judul=SOP Barista/);
  assert.match(logs(t.id, 'tool_result')[0], /tersimpan · https:\/\/docs\.google\.com/);
  // Task detail shows the file and the steps; the chat reply carries the link.
  const d = (await s.get(`/api/tasks/${t.id}`)).json();
  assert.equal(d.files[0].url, a.url);
  assert.ok(d.agent_steps.some((x) => x.event === 'tool_call'));
});

test('document text written before the call is used when "isi" is left out; raw line breaks in JSON are accepted', async () => {
  const emp = shared();
  const t1 = tasks.createTask({ kind: 'direct', title: 'Promo', description: 'AGENT_DOC DRAFT_BEFORE rencana promo', employeeId: emp.id });
  assert.equal((await done(t1.id)).status, 'completed');
  assert.match(g.docs().find((d) => d.name === 'Rencana Promo').html, /Promo bundling kopi \+ roti/);
  const t2 = tasks.createTask({ kind: 'direct', title: 'Notulen', description: 'AGENT_DOC RAWNL notulen', employeeId: emp.id });
  assert.equal((await done(t2.id)).status, 'completed');
  assert.match(g.docs().find((d) => d.name === 'Catatan Rapat').html, /<li>Harga naik<\/li>/);
});

test('unknown tool: the error goes back to the model, which then answers', async () => {
  const t = tasks.createTask({ kind: 'direct', title: 'Uji alat', description: 'AGENT_BADTOOL', employeeId: shared().id });
  const r = await done(t.id);
  assert.equal(r.result, 'Jawaban akhir tanpa alat.');
  assert.match(logs(t.id, 'tool_error')[0], /hapus_semua_data: alat "hapus_semua_data" tidak tersedia/);
});

test('step limit: after agent_max_steps tool calls the model must write its final answer', async () => {
  settings.setSetting('agent_max_steps', 2);
  try {
    const t = tasks.createTask({ kind: 'direct', title: 'Uji batas', description: 'AGENT_LOOP', employeeId: shared().id });
    const r = await done(t.id);
    assert.equal(r.result, 'Selesai setelah batas langkah.');
    assert.equal(logs(t.id, 'tool_call').length, 2);
    assert.match(logs(t.id, 'tool_limit')[0], /Batas 2 langkah/);
  } finally {
    settings.setSetting('agent_max_steps', 6);
  }
});

test('important tool: an approval with the action; it runs only after the owner approves it', async () => {
  const emp = shared();
  const fileId = q.get("SELECT id FROM artifacts WHERE title = 'SOP Barista'").id;
  const t = tasks.createTask({ kind: 'direct', title: 'Bagikan SOP', description: `AGENT_SHARE file=#${fileId}`, employeeId: emp.id });
  const r = await done(t.id);
  assert.equal(r.result, 'Permintaan berbagi menunggu persetujuan owner.');
  const ap = q.get('SELECT * FROM approvals WHERE task_id = ?', t.id);
  assert.deepEqual([ap.status, ap.action_status], ['pending', 'waiting']);
  assert.equal(ap.detail, 'Bagikan "SOP Barista" (Google Drive) ke budi@example.com sebagai pembaca');
  assert.equal(g.permissions.length, 0, 'nothing shared before approval');
  const listed = (await s.get('/api/approvals?status=pending')).json().find((a) => a.id === ap.id);
  assert.deepEqual([listed.category, listed.important, listed.action.tool], ['Aksi', true, 'drive_bagikan']);
  // Approve -> the server runs it.
  assert.equal((await s.post(`/api/approvals/${ap.id}/decide`, { decision: 'approved' })).statusCode, 200);
  const ran = await waitFor(() => {
    const a = q.get('SELECT * FROM approvals WHERE id = ?', ap.id);
    return ['done', 'failed'].includes(a.action_status) && a;
  });
  assert.equal(ran.action_status, 'done', ran.action_result);
  assert.deepEqual(g.permissions.map((p) => [p.type, p.emailAddress, p.role]), [['user', 'budi@example.com', 'reader']]);
  assert.match(logs(t.id, 'action_done')[0], /dibagikan ke budi@example\.com/);
  assert.ok(q.get("SELECT 1 x FROM chat_messages WHERE content LIKE 'Aksi yang Anda setujui sudah saya jalankan%'"), 'the employee reports back in the chat');
  // Rejected -> cancelled, nothing runs. Bulk approve runs the action too.
  const t2 = tasks.createTask({ kind: 'direct', title: 'Bagikan lagi', description: `AGENT_SHARE file=#${fileId} x`, employeeId: emp.id });
  await done(t2.id);
  const ap2 = q.get('SELECT id FROM approvals WHERE task_id = ?', t2.id);
  await s.post(`/api/approvals/${ap2.id}/decide`, { decision: 'rejected' });
  assert.equal(q.get('SELECT action_status FROM approvals WHERE id = ?', ap2.id).action_status, 'cancelled');
  const t3 = tasks.createTask({ kind: 'direct', title: 'Bagikan bulk', description: `AGENT_SHARE file=#${fileId} y`, employeeId: emp.id });
  await done(t3.id);
  const ap3 = q.get('SELECT id FROM approvals WHERE task_id = ?', t3.id);
  await s.post('/api/approvals/decide', { ids: [ap3.id], decision: 'approved' });
  await waitFor(() => q.get('SELECT action_status FROM approvals WHERE id = ?', ap3.id).action_status === 'done');
  assert.equal(g.permissions.length, 2);
});

test('Drive files are isolated per business: a task of one business cannot read another business\'s file', async () => {
  const coffee = q.get("SELECT * FROM businesses WHERE slug = 'coffee'");
  const wins = q.get("SELECT * FROM businesses WHERE slug = 'wins-court'");
  const doc = await artifacts.saveDocument({ title: 'Resep rahasia', markdown: '# Resep\nGula aren 20 ml', businessId: coffee.id });
  assert.equal(doc.status, 'synced');
  assert.equal(g.pathOf(g.files.get(doc.external_id)), 'AI Office/Coffee Business/Dokumen');
  const staff = q.get('SELECT e.* FROM employees e JOIN business_employees be ON be.employee_id = e.id WHERE be.business_id = ? AND e.enabled = 1 LIMIT 1', wins.id);
  const t = tasks.createTask({ kind: 'direct', title: 'Baca resep', description: `AGENT_READ file=#${doc.id}`, businessId: wins.id, employeeId: staff.id });
  const r = await done(t.id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(r.result, /tidak ditemukan di file bisnis ini/);
  assert.ok(!/Gula aren/.test(r.result));
});

test('automatic save: reports always, long work results, never quick chat replies; failed uploads are retried', async () => {
  const ceo = q.get('SELECT id FROM employees WHERE is_manager = 1').id;
  const root = tasks.createTask({ kind: 'instruction', title: 'Pertanyaan KPI', description: 'SIMPLE_TASK apa itu KPI?', employeeId: ceo });
  await done(root.id);
  const rep = q.get('SELECT * FROM artifacts WHERE task_id = ?', root.id);
  assert.deepEqual([rep.kind, rep.source, rep.status], ['report', 'auto', 'synced']);
  assert.match(rep.title, /^\d{4}-\d{2}-\d{2} Laporan — Pertanyaan KPI$/);
  assert.equal(g.pathOf(g.files.get(rep.external_id)), 'AI Office/Holding (HQ)/Laporan');

  settings.setSetting('drive_auto_save_min_chars', 50);
  const emp = shared();
  const work = tasks.createTask({ kind: 'direct', title: 'Analisis harga', description: 'HASIL_PANJANG analisis harga pesaing', employeeId: emp.id });
  await done(work.id);
  assert.equal(q.get('SELECT kind FROM artifacts WHERE task_id = ?', work.id).kind, 'document');
  const { task: reply } = chat.sendOwnerMessage({ content: 'HASIL_PANJANG halo, apa kabar hari ini?', recipientEmployeeId: emp.id, mode: 'reply', ownerName: 'Owner' });
  await done(reply.id);
  assert.equal(q.get('SELECT COUNT(*) n FROM artifacts WHERE task_id = ?', reply.id).n, 0, 'chat replies are not saved');

  // Drive fails: the result is kept as pending and uploaded later by the scheduler.
  g.state.failUpload = 1;
  const t2 = tasks.createTask({ kind: 'direct', title: 'Analisis biaya', description: 'HASIL_PANJANG analisis biaya', employeeId: emp.id });
  assert.equal((await done(t2.id)).status, 'completed', 'the task finishes anyway');
  const pend = q.get('SELECT * FROM artifacts WHERE task_id = ?', t2.id);
  assert.deepEqual([pend.status, pend.attempts], ['pending', 1]);
  assert.match(pend.error, /Backend Error/);
  assert.ok(pend.content.length > 50, 'the text waits for the upload');
  assert.equal(await artifacts.retryPendingArtifacts({ at: Date.now() }), 0, 'not before the pause');
  assert.equal(await artifacts.retryPendingArtifacts({ at: Date.now() + 10 * 60_000 }), 1);
  const synced = q.get('SELECT * FROM artifacts WHERE id = ?', pend.id);
  assert.deepEqual([synced.status, synced.content], ['synced', null]);
  // Five failures -> failed; "coba lagi" from the dashboard works afterwards.
  g.state.failUpload = 5;
  const bad = await artifacts.saveDocument({ title: 'Gagal terus', markdown: 'isi', businessId: null });
  for (let i = 0; i < 4; i++) await artifacts.retryPendingArtifacts({ at: Date.now() + 60 * 60_000 });
  assert.equal(q.get('SELECT status FROM artifacts WHERE id = ?', bad.id).status, 'failed');
  const again = (await s.post(`/api/artifacts/${bad.id}/retry`)).json();
  assert.equal(again.status, 'synced');
  const list = (await s.get('/api/artifacts?business=hq')).json();
  assert.ok(list.items.some((a) => a.id === bad.id && a.status === 'synced'));
  settings.setSetting('drive_auto_save_min_chars', 400);
});

test('agent mode off, or no tools: one plain AI call as before', async () => {
  settings.setSetting('agent_enabled', false);
  try {
    const t = tasks.createTask({ kind: 'direct', title: 'Tanpa agen', description: 'AGENT_DOC tapi agen mati', employeeId: shared().id });
    const r = await done(t.id);
    assert.equal(logs(t.id, 'tool_call').length, 0);
    assert.match(r.result, /<tool_call>|Berikut SOP-nya/, 'the model reply is used as is');
  } finally {
    settings.setSetting('agent_enabled', true);
  }
});
