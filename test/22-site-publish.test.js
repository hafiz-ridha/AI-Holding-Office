// Publishing websites (Stage 2): the Developer asks, the owner approves, the server publishes the commit the owner
// could preview to Vercel, Netlify, GitHub Pages or Cloudflare Pages; the main service from Settings; services that
// are not linked; publishing by the owner from the Website page; rejected requests never run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';
import { startMockProvider } from './mock-provider.js';
import { startMockHosting, GH_TOKEN, VERCEL_TOKEN, NETLIFY_TOKEN, CF_TOKEN, CF_ACCOUNT } from './mock-hosting.js';

let ai, mh, app, s, q, tasks, worker, svc, settings, chat, site;

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
const developer = () => q.get("SELECT * FROM employees WHERE role_key = 'developer' AND enabled = 1");
const coffee = () => q.get("SELECT * FROM businesses WHERE slug = 'coffee'");
const head = () => mh.repos.get('owner-gh/toko-kopi-web').refs.get('main');
const deployment = (host) => q.get('SELECT * FROM deployments WHERE artifact_id = ? AND provider = ?', site.id, host);

/** The Developer updates the site and asks to publish it; returns the pending approval. */
async function ask(extra) {
  const t = tasks.createTask({ kind: 'direct', title: 'Terbitkan web', description: `AGENT_SITE EXISTING AGENT_PUBLISH repo=toko-kopi-web ${extra}`, businessId: coffee().id, employeeId: developer().id });
  const r = await done(t.id);
  assert.equal(r.status, 'completed', r.error);
  return { task: r, approval: q.get('SELECT * FROM approvals WHERE task_id = ?', t.id) };
}
async function approve(id) {
  assert.equal((await s.post(`/api/approvals/${id}/decide`, { decision: 'approved' })).statusCode, 200);
  return waitFor(() => {
    const a = q.get('SELECT * FROM approvals WHERE id = ?', id);
    return ['done', 'failed'].includes(a.action_status) && a;
  });
}

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
  chat = await import('../src/holding/chat.js');
  app = await buildTestApp();
  s = await login(app);
  svc.createProvider({ preset: 'custom', name: 'Mock', base_url: ai.baseUrl, api_key: 'test-key', default_model: 'ok-model' });
  for (const [p, body] of [['github', { token: GH_TOKEN }], ['vercel', { token: VERCEL_TOKEN }], ['netlify', { token: NETLIFY_TOKEN }], ['cloudflare', { token: CF_TOKEN, account_id: CF_ACCOUNT }]]) {
    const r = await s.put(`/api/connections/token/${p}`, body);
    assert.equal(r.statusCode, 200, r.body);
  }
  chat.startChatFeed();
  worker.start({ log: { warn() {}, error() {} }, intervalMs: 50 });
  // The site exists: built by the Developer.
  const t = tasks.createTask({ kind: 'direct', title: 'Website', description: 'AGENT_SITE repo=toko-kopi-web', businessId: coffee().id, employeeId: developer().id });
  assert.equal((await done(t.id)).status, 'completed');
  site = q.get("SELECT * FROM artifacts WHERE external_id = 'owner-gh/toko-kopi-web'");
});
after(async () => {
  await worker.stop(1000);
  chat.stopChatFeed();
  await app?.close();
  await ai?.close();
  await mh?.close();
});

test('Vercel (main service): approval with the commit locked; publishes that commit after approval only', async () => {
  const { task, approval } = await ask('');
  assert.equal(task.result, 'Website siap; penerbitan menunggu persetujuan owner.');
  assert.deepEqual([approval.status, approval.action_status], ['pending', 'waiting']);
  const act = JSON.parse(approval.action);
  const locked = head();
  assert.deepEqual(act.args, { repo: `#${site.id}`, layanan: 'vercel', commit: locked });
  const token = JSON.parse(site.meta).preview_token;
  assert.equal(approval.detail, `Terbitkan website "toko-kopi-web" (commit ${locked.slice(0, 7)}) ke Vercel. Pratinjau: /preview/${token}/${locked}/`);
  assert.equal(mh.vercelDeploys.size, 0, 'nothing published before approval');

  // A newer commit lands before the owner decides: the approved commit is the one published.
  const gh = await import('../src/connections/github.js');
  await gh.commitFiles('owner-gh/toko-kopi-web', 'main', [{ path: 'baru.html', content: '<p>baru</p>\n' }], 'later');
  const ran = await approve(approval.id);
  assert.equal(ran.action_status, 'done', ran.action_result);
  assert.match(ran.action_result, /^Website "toko-kopi-web" sudah online di Vercel: https:\/\/toko-kopi-web\.vercel\.app \(commit [0-9a-f]{7}\)$/);
  const [dpl] = [...mh.vercelDeploys.values()];
  assert.deepEqual(dpl.body.files.map((f) => f.file).sort(), ['.nojekyll', 'README.md', 'index.html', 'style.css'], 'the locked commit (no baru.html)');
  assert.deepEqual([dpl.body.target, dpl.body.projectSettings.framework, dpl.body.name, dpl.query.skipAutoDetectionConfirmation], ['production', null, 'toko-kopi-web', '1']);
  assert.ok(dpl.body.files.every((f) => mh.vercelFiles.has(f.sha)), 'files uploaded by SHA1');
  const d = deployment('vercel');
  assert.deepEqual([d.status, d.url, d.commit_sha, d.approval_id], ['ready', 'https://toko-kopi-web.vercel.app', locked, approval.id]);
  assert.ok(q.get("SELECT 1 x FROM chat_messages WHERE content LIKE 'Aksi yang Anda setujui sudah saya jalankan%vercel.app%'"), 'reported in the chat');
});

test('Netlify: name taken → suffix; a private site is published with a note on how to make it public', async () => {
  mh.state.netlifyTaken.add('toko-kopi-web');
  mh.state.netlifyPrivate = true;
  const { approval } = await ask('HOST=netlify');
  assert.match(approval.detail, /ke Netlify\./);
  const ran = await approve(approval.id);
  assert.equal(ran.action_status, 'done', ran.action_result);
  const [siteN] = [...mh.netlifySites.values()];
  assert.match(siteN.name, /^toko-kopi-web-[0-9a-f]{4}$/);
  const [dep] = [...mh.netlifyDeploys.values()];
  assert.ok(dep.required.every((sha) => dep.uploaded.has(sha)), 'required files uploaded');
  assert.match(ran.action_result, /sudah online di Netlify/);
  assert.match(ran.action_result, /masih privat di Netlify/);
  assert.equal(deployment('netlify').project, siteN.id);
  mh.state.netlifyPrivate = false;
});

test('GitHub Pages: the repo becomes public (said in the approval), gh-pages points at the commit, Pages enabled', async () => {
  const { approval } = await ask('HOST=github_pages');
  assert.match(approval.detail, /ke GitHub Pages\. .*Repo akan dijadikan publik/);
  assert.equal(mh.repos.get('owner-gh/toko-kopi-web').private, true, 'still private before approval');
  const ran = await approve(approval.id);
  assert.equal(ran.action_status, 'done', ran.action_result);
  const repo = mh.repos.get('owner-gh/toko-kopi-web');
  assert.equal(repo.private, false);
  assert.equal(repo.refs.get('gh-pages'), JSON.parse(approval.action).args.commit);
  assert.deepEqual(repo.pages.source, { branch: 'gh-pages', path: '/' });
  assert.equal(deployment('github_pages').url, 'https://owner-gh.github.io/toko-kopi-web/');
});

test('Cloudflare Pages: a missing GitHub app is explained; after fixing it the owner runs the action again', async () => {
  mh.state.cfNoApp = true;
  const { approval } = await ask('HOST=cloudflare');
  const failed = await approve(approval.id);
  assert.equal(failed.action_status, 'failed');
  assert.match(failed.action_result, /Cloudflare Workers and Pages/);
  assert.equal(deployment('cloudflare').status, 'error');
  mh.state.cfNoApp = false;
  const again = await s.post(`/api/approvals/${approval.id}/run`);
  assert.equal(again.json().action_status, 'done', again.json().action_result);
  const proj = mh.cfProjects.get('toko-kopi-web');
  assert.deepEqual(proj.source, { type: 'github', config: { owner: 'owner-gh', repo_name: 'toko-kopi-web', production_branch: 'cf-pages', production_deployments_enabled: true, preview_deployment_setting: 'none', pr_comments_enabled: false } });
  assert.equal(mh.repos.get('owner-gh/toko-kopi-web').refs.get('cf-pages'), JSON.parse(approval.action).args.commit);
  assert.match(mh.cfDeploys.at(-1).form, /cf-pages/);
  assert.equal(deployment('cloudflare').url, 'https://toko-kopi-web.pages.dev');
});

test('services that are not linked: named to the AI; an unlinked main service falls back to a linked one', async () => {
  assert.equal((await s.del('/api/connections/token/netlify')).statusCode, 200);
  const t = tasks.createTask({ kind: 'direct', title: 'Ke Netlify', description: 'AGENT_SITE EXISTING AGENT_PUBLISH repo=toko-kopi-web HOST=netlify', businessId: coffee().id, employeeId: developer().id });
  const r = await done(t.id);
  assert.match(r.result, /Netlify belum terhubung\. Yang terhubung: vercel \(Vercel\), cloudflare \(Cloudflare Pages\), github_pages \(GitHub Pages\)/);
  assert.equal(q.get('SELECT COUNT(*) n FROM approvals WHERE task_id = ?', t.id).n, 0);
  settings.setSetting('site_default_host', 'netlify');
  try {
    const { approval } = await ask('');
    assert.equal(JSON.parse(approval.action).args.layanan, 'vercel');
    await s.post(`/api/approvals/${approval.id}/decide`, { decision: 'rejected' });
    assert.equal(q.get('SELECT action_status FROM approvals WHERE id = ?', approval.id).action_status, 'cancelled', 'rejected: never runs');
  } finally {
    settings.setSetting('site_default_host', 'vercel');
  }
});

test('Website page: lists sites with their addresses; the owner publishes directly (audited)', async () => {
  const list = (await s.get('/api/sites')).json();
  const item = list.items.find((x) => x.id === site.id);
  assert.equal(item.full_name, 'owner-gh/toko-kopi-web');
  assert.match(item.preview_url, /^\/preview\/[A-Za-z0-9_-]{32}\/main\/$/);
  assert.deepEqual(item.deployments.map((d) => d.provider).sort(), ['cloudflare', 'github_pages', 'netlify', 'vercel']);
  assert.deepEqual(list.hosts.filter((h) => h.connected).map((h) => h.id), ['vercel', 'cloudflare', 'github_pages']);
  assert.equal((await s.post(`/api/sites/${site.id}/publish`, { host: 'netlify' })).statusCode, 400, 'not linked');

  const before = mh.vercelDeploys.size;
  const r = await s.post(`/api/sites/${site.id}/publish`, { host: 'vercel' });
  assert.equal(r.statusCode, 200, r.body);
  await waitFor(() => mh.vercelDeploys.size === before + 1 && deployment('vercel').commit_sha === head() && deployment('vercel').status === 'ready');
  assert.equal(deployment('vercel').approval_id, null, 'published by the owner');
  assert.ok(q.get("SELECT 1 x FROM audit_logs WHERE action = 'site_publish' AND target = 'owner-gh/toko-kopi-web'"));
});
