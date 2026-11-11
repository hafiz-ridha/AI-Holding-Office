// Google Drive connection (personal Gmail, OAuth device flow): client validation, secrets never returned and stored
// encrypted, linking with a code, token refresh, revoked access -> "reconnect" + alert (and the Drive tools
// disappear), disconnect, and the base rule of employees updated for agents.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockGoogle, CLIENT_ID, CLIENT_SECRET } from './mock-google.js';

let g, app, s, q, google, tools, bus;
const alerts = [];

before(async () => {
  g = await startMockGoogle();
  const { config } = await import('../src/config.js');
  config.googleOAuthBase = g.base;
  config.googleApiBase = g.base;
  await setupEnv();
  ({ q } = await import('../src/db/index.js'));
  google = await import('../src/connections/google.js');
  tools = await import('../src/agents/tools/index.js');
  ({ bus } = await import('../src/events.js'));
  bus.on('system:alert', (a) => alerts.push(a));
  app = await buildTestApp();
  s = await login(app);
});
after(async () => {
  google.resetGoogleState();
  await app?.close();
  await g?.close();
});

const driveTools = () => tools.toolsFor({ id: 1, role_key: 'secretary' }, { id: 1 }).filter((t) => t.connector === 'google_drive').map((t) => t.name);

test('client id/secret: validated, stored encrypted, never returned', async () => {
  assert.equal((await s.put('/api/connections/google_drive', { client_id: 'bukan-client-id', client_secret: 'x' })).statusCode, 400);
  const noSecret = await s.put('/api/connections/google_drive', { client_id: CLIENT_ID });
  assert.equal(noSecret.statusCode, 400);
  assert.match(noSecret.json().error, /Client Secret wajib/);
  const r = await s.put('/api/connections/google_drive', { client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().status, r.json().client_id, r.json().has_client_secret], ['disconnected', CLIENT_ID, true]);
  const all = (await s.get('/api/connections')).body;
  assert.ok(!all.includes(CLIENT_SECRET), 'secret never sent to the browser');
  assert.match(JSON.parse(all).google_drive.client_secret_hint, /…|••••/);
  const row = q.get("SELECT * FROM connections WHERE provider = 'google_drive'");
  assert.ok(row.secret_enc.startsWith('v1:') && !row.secret_enc.includes(CLIENT_SECRET));
  const audit = q.get("SELECT detail FROM audit_logs WHERE action = 'connection_updated' ORDER BY id DESC LIMIT 1").detail;
  assert.ok(!audit.includes(CLIENT_SECRET));
  assert.deepEqual(JSON.parse((await s.get('/api/connections')).body).next.map((n) => n.provider), ['supabase']);
  assert.deepEqual(driveTools(), [], 'no Drive tools before the account is linked');
});

test('device flow: code shown, pending until the owner allows it at Google, then connected', async () => {
  const c = await s.post('/api/connections/google_drive/connect');
  assert.equal(c.statusCode, 200, c.body);
  assert.deepEqual([c.json().status, c.json().pending.user_code, c.json().pending.verification_url], ['pending', 'ABCD-EFGH', 'https://www.google.com/device']);
  assert.equal((await s.post('/api/connections/google_drive/poll')).json().state, 'pending');
  g.state.approved = true;
  const p = (await s.post('/api/connections/google_drive/poll')).json();
  assert.deepEqual([p.state, p.status, p.account, p.pending], ['connected', 'connected', 'owner@gmail.com', null]);
  const row = q.get("SELECT secret_enc FROM connections WHERE provider = 'google_drive'");
  assert.ok(!row.secret_enc.includes('RT-SECRET-1'), 'refresh token stored encrypted');
  assert.ok(!(await s.get('/api/connections')).body.includes('RT-SECRET-1'));
  assert.deepEqual(driveTools(), ['drive_simpan_dokumen', 'drive_daftar', 'drive_baca', 'drive_bagikan', 'drive_hapus']);
  // Test: refreshes the access token with the stored refresh token and creates the root folder.
  google.resetGoogleState();
  const t = await s.post('/api/connections/google_drive/test');
  assert.equal(t.statusCode, 200, t.body);
  assert.equal(t.json().account, 'owner@gmail.com');
  assert.match(t.json().folder_link, /^https:\/\/drive\.google\.com\/drive\/folders\//);
  assert.ok(g.calls.some((x) => x.path === '/token'), 'token refreshed');
  assert.ok(g.calls.filter((x) => x.path.startsWith('/drive/')).every((x) => /^Bearer at-\d+$/.test(x.auth)));
});

test('access revoked at Google: connection asks to be linked again, owner is alerted, Drive tools disappear', async () => {
  google.resetGoogleState();
  g.state.invalidGrant = true;
  const t = await s.post('/api/connections/google_drive/test');
  assert.equal(t.statusCode, 400);
  assert.match(t.json().error, /Token Google gagal diperbarui/);
  const c = (await s.get('/api/connections')).json().google_drive;
  assert.equal(c.status, 'expired');
  assert.match(c.error, /kedaluwarsa atau dicabut/);
  assert.ok(alerts.some((a) => a.key === 'google_drive_expired' && /Hubungkan/.test(a.message)));
  assert.deepEqual(driveTools(), []);
  // Link again.
  g.state.invalidGrant = false;
  await s.post('/api/connections/google_drive/connect');
  assert.equal((await s.post('/api/connections/google_drive/poll')).json().state, 'connected');
});

test('denied at Google: re-linking while connected keeps the current link; a first link goes back to disconnected', async () => {
  await s.post('/api/connections/google_drive/connect');
  const c = (await s.get('/api/connections')).json().google_drive;
  assert.deepEqual([c.status, c.pending.user_code], ['connected', 'ABCD-EFGH'], 'Drive keeps working while the code waits');
  g.state.denied = true;
  let p = (await s.post('/api/connections/google_drive/poll')).json();
  assert.deepEqual([p.state, p.status], ['denied', 'connected']);
  assert.match(p.error, /ditolak/);
  assert.equal((await s.post('/api/connections/google_drive/test')).statusCode, 200, 'the old link still works');
  await s.del('/api/connections/google_drive');
  await s.post('/api/connections/google_drive/connect');
  p = (await s.post('/api/connections/google_drive/poll')).json();
  assert.deepEqual([p.state, p.status], ['denied', 'disconnected']);
  g.state.denied = false;
});

test('disconnect revokes at Google and forgets the account, keeps the client', async () => {
  await s.post('/api/connections/google_drive/connect');
  await s.post('/api/connections/google_drive/poll');
  const r = await s.del('/api/connections/google_drive');
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().status, r.json().account, r.json().client_id], ['disconnected', null, CLIENT_ID]);
  assert.equal(g.revoked.at(-1), 'RT-SECRET-1');
  assert.equal((await s.post('/api/connections/google_drive/test')).statusCode, 400);
});

test('base rule of existing employees: "text only, never acts" becomes "acts only through tools"', async () => {
  const { seed } = await import('../src/db/seed.js');
  const old = 'Kamu hanya menghasilkan teks (analisis, rencana, draf, kode). Kamu TIDAK dapat mengeksekusi tindakan apa pun.';
  const e = q.get('SELECT id FROM employees ORDER BY id LIMIT 1');
  q.run('UPDATE employees SET system_prompt = ? WHERE id = ?', `Kamu adalah X.\n- ${old}`, e.id);
  q.run("DELETE FROM system_settings WHERE key = '_tool_rule_v1'");
  await seed({ info() {}, warn() {} });
  assert.match(q.get('SELECT system_prompt p FROM employees WHERE id = ?', e.id).p, /^Kamu adalah X\.\n- Kamu bertindak hanya lewat alat yang disediakan server[^\n]*persetujuan owner|^Kamu adalah X\.\n- Kamu bertindak hanya lewat alat yang disediakan server[^\n]*menyetujuinya/);
  assert.ok(!q.get("SELECT COUNT(*) n FROM employees WHERE system_prompt LIKE '%TIDAK dapat mengeksekusi%'").n);
});
