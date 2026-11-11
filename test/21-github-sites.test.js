// Code & websites (Stage 2): token connections (tested before they are stored, never returned), the Developer's GitHub
// tools (private repo, several files in one commit from the code blocks of the reply, history compaction, code-mode
// limits), refused paths and cut-off replies, the private sandboxed preview, and business isolation of repos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';
import { startMockHosting, GH_TOKEN, VERCEL_TOKEN, CF_TOKEN, CF_ACCOUNT } from './mock-hosting.js';

let ai, mh, app, s, q, tasks, worker, svc, settings, tools, files, sites, actions;

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
const developer = () => q.get("SELECT * FROM employees WHERE role_key = 'developer' AND enabled = 1");
const coffee = () => q.get("SELECT * FROM businesses WHERE slug = 'coffee'");

before(async () => {
  mh = await startMockHosting();
  const { config } = await import('../src/config.js');
  config.githubApiBase = `${mh.base}/gh`;
  config.vercelApiBase = `${mh.base}/vercel`;
  config.netlifyApiBase = `${mh.base}/netlify`;
  config.cloudflareApiBase = `${mh.base}/cf`;
  config.deployPollMs = 0;
  await setupEnv();
  ai = await startMockProvider();
  ({ q } = await import('../src/db/index.js'));
  tasks = await import('../src/queue/tasks.js');
  ({ worker } = await import('../src/queue/worker.js'));
  svc = await import('../src/providers/service.js');
  settings = await import('../src/lib/settings.js');
  tools = await import('../src/agents/tools/index.js');
  files = await import('../src/sites/files.js');
  sites = await import('../src/sites/index.js');
  actions = await import('../src/agents/actions.js');
  app = await buildTestApp();
  s = await login(app);
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: ai.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 50 });
});
after(async () => {
  await worker.stop(1000);
  await app?.close();
  await ai?.close();
  await mh?.close();
});

test('token connections: tested before saving, stored encrypted, never returned; bad tokens are refused', async () => {
  const bad = await s.put('/api/connections/token/github', { token: 'ghp_wrong' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /GitHub: Bad credentials/);
  assert.equal(q.get("SELECT COUNT(*) n FROM connections WHERE provider = 'github' AND status = 'connected'").n, 0, 'nothing stored');
  // A classic token without the "repo" scope is refused with advice.
  mh.state.classicScopes = 'gist, read:user';
  assert.match((await s.put('/api/connections/token/github', { token: GH_TOKEN })).json().error, /scope "repo"/);
  mh.state.classicScopes = null;

  const r = await s.put('/api/connections/token/github', { token: GH_TOKEN });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().status, r.json().account, r.json().token_type, r.json().has_token], ['connected', 'owner-gh', 'fine-grained', true]);
  const all = (await s.get('/api/connections')).body;
  assert.ok(!all.includes(GH_TOKEN), 'token never sent to the browser');
  const row = q.get("SELECT * FROM connections WHERE provider = 'github'");
  assert.ok(row.secret_enc.startsWith('v1:') && !row.secret_enc.includes(GH_TOKEN));
  const audit = q.all("SELECT detail FROM audit_logs WHERE target = 'github'").map((a) => a.detail || '').join(' ');
  assert.ok(!audit.includes(GH_TOKEN));
  assert.deepEqual(JSON.parse(all).next.map((n) => n.provider), ['supabase']);

  // Fields: Vercel team id is checked; Cloudflare needs the account id. Empty token = keep the stored one.
  assert.match((await s.put('/api/connections/token/vercel', { token: VERCEL_TOKEN, team_id: 'bukan-team' })).json().error, /Team ID tidak valid/);
  const v = await s.put('/api/connections/token/vercel', { token: VERCEL_TOKEN, team_id: 'team_abc123' });
  assert.equal(v.json().account, 'owner-vc · tim Tim Kopi');
  assert.equal((await s.put('/api/connections/token/vercel', { team_id: '' })).json().team_id, null, 'token kept, team removed');
  assert.match((await s.put('/api/connections/token/cloudflare', { token: CF_TOKEN })).json().error, /Account ID wajib/);
  const cf = await s.put('/api/connections/token/cloudflare', { token: CF_TOKEN, account_id: CF_ACCOUNT });
  assert.equal(cf.statusCode, 200, cf.body);
  assert.equal((await s.post('/api/connections/token/cloudflare/test')).json().status, 'connected');
  assert.equal((await s.del('/api/connections/token/cloudflare')).json().status, 'disconnected');
  assert.equal(q.get("SELECT secret_enc FROM connections WHERE provider = 'cloudflare'").secret_enc, null, 'token removed');
});

test('only the Developer gets the GitHub tools; the manual explains how to write files', () => {
  const dev = developer();
  const names = tools.toolsFor(dev, { id: 1 }).map((t) => t.name);
  for (const n of ['github_buat_repo', 'github_simpan_file', 'github_baca', 'github_daftar', 'situs_terbitkan']) assert.ok(names.includes(n), n);
  const sec = q.get("SELECT * FROM employees WHERE role_key = 'secretary'");
  assert.ok(!tools.toolsFor(sec, { id: 1 }).some((t) => t.name.startsWith('github_')), 'not for other employees');
  const manual = tools.toolManual(tools.toolsFor(dev, { id: 1 }));
  assert.match(manual, /## Membuat website & kode/);
  assert.match(manual, /File: index\.html/);
  assert.match(manual, /situs_terbitkan \[perlu izin owner\]/);
  assert.ok(!/commit\?/.test(manual), 'hidden argument not shown');
});

test('file blocks: names from the line above or the info string; unsafe paths and oversized files are refused', () => {
  const ex = files.extractFiles('File: index.html\n```html\n<p>a</p>\n```\n### css/style.css\n```css\nb{}\n```\n```js app.js\nx()\n```\n```\nanon\n```\n**about.html**\n```html\n<p>cut');
  assert.deepEqual(ex.files.map((f) => f.path), ['index.html', 'css/style.css', 'app.js']);
  assert.equal(ex.files[0].content, '<p>a</p>\n');
  assert.deepEqual([ex.unnamed.length, ex.unclosed], [1, ['about.html']]);
  for (const bad of ['../x.html', '.github/workflows/a.yml', '.git/config', 'a b.html', 'x/../y']) assert.throws(() => files.cleanPath(bad), bad);
  assert.equal(files.cleanPath('/index.html'), 'index.html');
  assert.throws(() => files.cleanFiles([{ path: 'big.html', content: 'x'.repeat(301 * 1024) }]), /terlalu besar/);
});

test('the Developer builds a website: private repo, files in one commit, compact history, code-mode limits, preview link', async () => {
  const dev = developer();
  const b = coffee();
  ai.calls.length = 0;
  const t = tasks.createTask({ kind: 'direct', title: 'Website toko kopi', description: 'AGENT_SITE repo=toko-kopi-web buat website profil', businessId: b.id, employeeId: dev.id });
  const r = await done(t.id);
  assert.equal(r.status, 'completed', r.error);
  const repo = mh.repos.get('owner-gh/toko-kopi-web');
  assert.ok(repo, 'repo created');
  assert.equal(repo.private, true, 'private repo');
  const f = mh.files('owner-gh/toko-kopi-web');
  assert.deepEqual(Object.keys(f).sort(), ['.nojekyll', 'README.md', 'index.html', 'style.css']);
  assert.match(f['index.html'], /SITE_MARKER_HTML Toko Kopi/);
  assert.match(f['style.css'], /font-family: sans-serif/);
  const head = repo.refs.get('main');
  assert.match(mh.commits.get(head).message, /^Halaman utama \(AI Office\)$/);
  assert.equal(mh.trees.get(mh.commits.get(head).tree).size, 4, 'both files in one commit');

  const a = q.get("SELECT * FROM artifacts WHERE provider = 'github' AND external_id = 'owner-gh/toko-kopi-web'");
  assert.deepEqual([a.kind, a.business_id, a.task_id, a.employee_id, a.url], ['site', b.id, t.id, dev.id, 'https://github.com/owner-gh/toko-kopi-web']);
  const meta = JSON.parse(a.meta);
  assert.equal(meta.head, head);
  assert.match(meta.preview_token, /^[A-Za-z0-9_-]{32}$/);
  assert.match(r.result, new RegExp(`Website selesai\\. Pratinjau: /preview/${meta.preview_token}/main/`));
  assert.match(logs(t.id, 'tool_result').join('\n'), /2 file → toko-kopi-web/);

  // The code went to GitHub: the next step does not send it to the AI again.
  const work = ai.calls.filter((c) => c.url === '/v1/chat/completions');
  const after = work.filter((c) => c.body.messages.some((m) => /Hasil alat github_simpan_file/.test(m.content)));
  assert.ok(after.length >= 1);
  for (const c of after) assert.ok(!c.body.messages.some((m) => /SITE_MARKER_HTML/.test(m.content)), 'file contents compacted');
  assert.ok(after[0].body.messages.some((m) => /\[isi 2 file disimpan ke GitHub: index\.html/.test(m.content)));
  // Code mode: more output per reply for the Developer.
  assert.ok(work.every((c) => c.body.max_tokens === settings.getSetting('agent_code_max_output_tokens')), 'code-mode output cap');

  // Task detail and File page list the repo.
  const d = (await s.get(`/api/tasks/${t.id}`)).json();
  assert.equal(d.files[0].url, 'https://github.com/owner-gh/toko-kopi-web');
  const fl = (await s.get('/api/artifacts?kind=site')).json().items;
  assert.ok(fl.some((x) => x.provider === 'github' && x.title === 'toko-kopi-web'));
});

test('private preview: sandboxed, no login needed, branch or commit, clean URLs; wrong token is 404', async () => {
  const a = q.get("SELECT * FROM artifacts WHERE external_id = 'owner-gh/toko-kopi-web'");
  const meta = JSON.parse(a.meta);
  const base = `/preview/${meta.preview_token}`;
  const redirect = await app.inject({ method: 'GET', url: `${base}/main` });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, `${base}/main/`);
  const page = await app.inject({ method: 'GET', url: `${base}/main/` }); // no session cookie
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.headers['content-security-policy'], /^sandbox allow-scripts/);
  assert.ok(!/allow-same-origin/.test(page.headers['content-security-policy']), 'unique origin: no access to the dashboard session');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.body, /SITE_MARKER_HTML/);
  const css = await app.inject({ method: 'GET', url: `${base}/${meta.head}/style.css` });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.equal((await app.inject({ method: 'GET', url: `${base}/main/index` })).statusCode, 200, 'clean URL → index.html');
  assert.equal((await app.inject({ method: 'GET', url: `${base}/main/tidak-ada.html` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/preview/${'x'.repeat(32)}/main/` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `${base}/main/..%2F..%2Fetc` })).statusCode, 404);
});

test('unsafe paths are refused to the AI; a cut-off reply is not used and the AI is asked for a shorter one', async () => {
  const dev = developer();
  const b = coffee();
  const t1 = tasks.createTask({ kind: 'direct', title: 'Workflow', description: 'AGENT_BADPATH', businessId: b.id, employeeId: dev.id });
  const r1 = await done(t1.id);
  assert.match(r1.result, /tidak diizinkan/);
  assert.ok(!('.github/workflows/deploy.yml' in mh.files('owner-gh/toko-kopi-web')));
  const t2 = tasks.createTask({ kind: 'direct', title: 'Panjang', description: 'AGENT_TRUNC', businessId: b.id, employeeId: dev.id });
  const r2 = await done(t2.id);
  assert.equal(r2.result, 'Saya tulis lebih pendek nanti.');
  assert.match(logs(t2.id, 'tool_error')[0], /terpotong/);
});

test('repos are isolated per business; the same name cannot be created twice', async () => {
  const dev = developer();
  const wins = q.get("SELECT * FROM businesses WHERE slug = 'wins-court'");
  // Another business asks to write into the coffee repo: not found for it.
  const t = tasks.createTask({ kind: 'direct', title: 'Ubah web', description: 'AGENT_SITE EXISTING repo=toko-kopi-web', businessId: wins.id, employeeId: dev.id });
  const r = await done(t.id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(logs(t.id, 'tool_error').join('\n'), /tidak ditemukan di repo bisnis ini/);
  // A taken name: the error goes back to the AI.
  const t2 = tasks.createTask({ kind: 'direct', title: 'Web lagi', description: 'AGENT_SITE repo=toko-kopi-web', businessId: wins.id, employeeId: dev.id });
  const r2 = await done(t2.id);
  assert.match(r2.result, /sudah dipakai di akun GitHub ini/);
});

test('restart: actions and publications that were running become failed, so they can be run again', () => {
  const ap = q.run("INSERT INTO approvals(title, detail, status, action, action_status, created_at) VALUES ('x', 'y', 'approved', '{}', 'running', 1)");
  const a = q.get("SELECT id FROM artifacts WHERE external_id = 'owner-gh/toko-kopi-web'");
  q.run("INSERT INTO deployments(artifact_id, provider, status, created_at, updated_at) VALUES (?, 'vercel', 'building', 1, 1)", a.id);
  assert.equal(actions.recoverInterruptedActions(), 1);
  assert.equal(sites.recoverInterruptedPublishing(), 1);
  assert.equal(q.get('SELECT action_status FROM approvals WHERE id = ?', Number(ap.lastInsertRowid)).action_status, 'failed');
  assert.equal(q.get("SELECT status FROM deployments WHERE artifact_id = ? AND provider = 'vercel'", a.id).status, 'error');
  q.run('DELETE FROM deployments WHERE artifact_id = ?', a.id);
});
