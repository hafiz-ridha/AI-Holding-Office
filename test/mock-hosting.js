// Local stand-in for GitHub (repos, Git Data API, contents, Pages), Vercel (files, deployments), Netlify (sites,
// file-digest deploys) and Cloudflare Pages (Git-connected projects, deployments). Tests point config.githubApiBase /
// vercelApiBase / netlifyApiBase / cloudflareApiBase at `${base}/gh`, `/vercel`, `/netlify`, `/cf`.
import http from 'node:http';
import crypto from 'node:crypto';

export const GH_TOKEN = 'ghp_testtoken0000000000000000000001';
export const VERCEL_TOKEN = 'vercel_test_token_0001';
export const NETLIFY_TOKEN = 'nfp_test_token_0001';
export const CF_TOKEN = 'cf_test_token_0001';
export const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export async function startMockHosting() {
  const state = {
    classicScopes: null, // e.g. 'repo, workflow' to act as a classic token; null = fine-grained
    netlifyPrivate: false,
    netlifyTaken: new Set(), // site names used by someone else
    cfNoApp: false, // the Cloudflare GitHub app is not installed
    vercelBuildPolls: 1, // GETs before a Vercel deployment is READY
  };
  const calls = [];
  let seq = 0;
  const id = () => sha1(String(++seq));

  // ---------------- GitHub data ----------------
  const blobs = new Map(); // sha -> Buffer
  const trees = new Map(); // sha -> Map(path -> blobSha)
  const commits = new Map(); // sha -> { tree, parents, message }
  const repos = new Map(); // full_name -> { name, full_name, private, refs: Map, pages, build }
  const putBlob = (buf) => {
    const s = sha1(buf);
    blobs.set(s, buf);
    return s;
  };
  const commitOf = (repo, ref) => (commits.has(ref) ? ref : repo.refs.get(ref));
  const isAncestor = (anc, sha) => {
    for (let c = sha; c; c = commits.get(c)?.parents?.[0]) if (c === anc) return true;
    return false;
  };
  const repoJson = (r) => ({ name: r.name, full_name: r.full_name, html_url: `https://github.com/${r.full_name}`, default_branch: 'main', private: r.private, owner: { login: 'owner-gh' } });
  const filesAt = (r, ref) => {
    const c = commitOf(r, ref);
    return c ? trees.get(commits.get(c).tree) : null;
  };

  // ---------------- Vercel / Netlify / Cloudflare data ----------------
  const vercelFiles = new Map();
  const vercelDeploys = new Map();
  const netlifySites = new Map();
  const netlifyDeploys = new Map();
  const cfProjects = new Map();
  const cfDeploys = [];

  const send = (res, code, obj, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const auth = req.headers.authorization || '';
    const json = () => (raw.length ? JSON.parse(raw.toString('utf8')) : {});
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth, headers: req.headers, size: raw.length });
    const bearer = (tok) => auth === `Bearer ${tok}`;

    // ================= GitHub =================
    if (path.startsWith('/gh/')) {
      if (!bearer(GH_TOKEN)) return send(res, 401, { message: 'Bad credentials' });
      const p = path.slice(3);
      if (p === '/user' && req.method === 'GET') return send(res, 200, { login: 'owner-gh' }, state.classicScopes !== null ? { 'x-oauth-scopes': state.classicScopes } : {});
      if (p === '/user/repos' && req.method === 'POST') {
        const b = json();
        const full = `owner-gh/${b.name}`;
        if (repos.has(full)) {
          return send(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        }
        const r = { name: b.name, full_name: full, private: b.private !== false, refs: new Map(), pages: null, build: null, auto_init: b.auto_init };
        const tree = new Map([['README.md', putBlob(Buffer.from(`# ${b.name}\n`))]]);
        const t = id();
        trees.set(t, tree);
        const c = id();
        commits.set(c, { tree: t, parents: [], message: 'Initial commit' });
        r.refs.set('main', c);
        repos.set(full, r);
        return send(res, 201, repoJson(r));
      }
      const m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
      const r = m && repos.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
      if (!r) return send(res, 404, { message: 'Not Found' });
      const sub = m[3] || '';
      if (!sub && req.method === 'GET') return send(res, 200, repoJson(r));
      if (!sub && req.method === 'PATCH') {
        const b = json();
        if (typeof b.private === 'boolean') r.private = b.private;
        return send(res, 200, repoJson(r));
      }
      let mm;
      if ((mm = sub.match(/^\/git\/ref\/heads\/(.+)$/)) && req.method === 'GET') {
        const s = r.refs.get(decodeURIComponent(mm[1]));
        return s ? send(res, 200, { ref: `refs/heads/${mm[1]}`, object: { sha: s, type: 'commit' } }) : send(res, 404, { message: 'Not Found' });
      }
      if ((mm = sub.match(/^\/git\/commits\/([0-9a-f]{40})$/)) && req.method === 'GET') {
        const c = commits.get(mm[1]);
        return c ? send(res, 200, { sha: mm[1], tree: { sha: c.tree } }) : send(res, 404, { message: 'Not Found' });
      }
      if (sub === '/git/trees' && req.method === 'POST') {
        const b = json();
        const base = trees.get(b.base_tree);
        if (!base) return send(res, 422, { message: 'Invalid tree' });
        const next = new Map(base);
        for (const e of b.tree) next.set(e.path, putBlob(Buffer.from(e.content, 'utf8')));
        const t = id();
        trees.set(t, next);
        return send(res, 201, { sha: t });
      }
      if (sub === '/git/commits' && req.method === 'POST') {
        const b = json();
        const c = id();
        commits.set(c, { tree: b.tree, parents: b.parents, message: b.message });
        return send(res, 201, { sha: c, html_url: `https://github.com/${r.full_name}/commit/${c}` });
      }
      if ((mm = sub.match(/^\/git\/refs\/heads\/(.+)$/)) && req.method === 'PATCH') {
        const branch = decodeURIComponent(mm[1]);
        const b = json();
        if (!r.refs.has(branch)) return send(res, 422, { message: 'Reference does not exist' });
        if (!b.force && !isAncestor(r.refs.get(branch), b.sha)) return send(res, 422, { message: 'Update is not a fast forward' });
        r.refs.set(branch, b.sha);
        if (r.pages && r.pages.source.branch === branch) r.build = { status: 'built', commit: b.sha };
        return send(res, 200, { ref: `refs/heads/${branch}`, object: { sha: b.sha } });
      }
      if (sub === '/git/refs' && req.method === 'POST') {
        const b = json();
        const branch = b.ref.replace(/^refs\/heads\//, '');
        if (r.refs.has(branch)) return send(res, 422, { message: 'Reference already exists' });
        r.refs.set(branch, b.sha);
        return send(res, 201, { ref: b.ref, object: { sha: b.sha } });
      }
      if ((mm = sub.match(/^\/git\/trees\/(.+)$/)) && req.method === 'GET') {
        const files = filesAt(r, decodeURIComponent(mm[1]));
        if (!files) return send(res, 404, { message: 'Not Found' });
        return send(res, 200, { truncated: false, tree: [...files].map(([fp, s]) => ({ path: fp, type: 'blob', sha: s, size: blobs.get(s).length })) });
      }
      if ((mm = sub.match(/^\/git\/blobs\/([0-9a-f]{40})$/)) && req.method === 'GET') {
        const b = blobs.get(mm[1]);
        return b ? send(res, 200, { sha: mm[1], encoding: 'base64', content: b.toString('base64') }) : send(res, 404, { message: 'Not Found' });
      }
      if ((mm = sub.match(/^\/contents\/(.+)$/)) && req.method === 'GET') {
        const files = filesAt(r, url.searchParams.get('ref') || 'main');
        const fp = mm[1].split('/').map(decodeURIComponent).join('/');
        const s = files?.get(fp);
        if (!s) return send(res, 404, { message: 'Not Found' });
        const b = blobs.get(s);
        return send(res, 200, { type: 'file', path: fp, sha: s, size: b.length, encoding: 'base64', content: b.toString('base64') });
      }
      if (sub === '/pages' && req.method === 'GET') return r.pages ? send(res, 200, r.pages) : send(res, 404, { message: 'Not Found' });
      if (sub === '/pages' && (req.method === 'POST' || req.method === 'PUT')) {
        if (r.private) return send(res, 422, { message: 'Your current plan does not support GitHub Pages for this repository.' });
        const b = json();
        r.pages = { html_url: `https://owner-gh.github.io/${r.name}/`, source: b.source, build_type: b.build_type, status: 'built' };
        r.build = { status: 'built', commit: r.refs.get(b.source.branch) };
        return send(res, req.method === 'POST' ? 201 : 204, req.method === 'POST' ? r.pages : undefined);
      }
      if (sub === '/pages/builds' && req.method === 'POST') {
        r.build = { status: 'built', commit: r.refs.get(r.pages?.source?.branch) };
        return send(res, 201, { status: 'queued' });
      }
      if (sub === '/pages/builds/latest' && req.method === 'GET') return r.build ? send(res, 200, r.build) : send(res, 404, { message: 'Not Found' });
      return send(res, 404, { message: 'Not Found' });
    }

    // ================= Vercel =================
    if (path.startsWith('/vercel/')) {
      if (!bearer(VERCEL_TOKEN)) return send(res, 403, { error: { code: 'forbidden', message: 'Not authorized' } });
      const p = path.slice(7);
      if (p === '/v2/user') return send(res, 200, { user: { username: 'owner-vc', email: 'owner@vercel.test' } });
      if (p.startsWith('/v2/teams/')) return send(res, 200, { id: p.split('/').pop(), name: 'Tim Kopi' });
      if (p === '/v2/files' && req.method === 'POST') {
        if (sha1(raw) !== req.headers['x-vercel-digest']) return send(res, 400, { error: { code: 'invalid_digest', message: 'Digest mismatch' } });
        vercelFiles.set(sha1(raw), raw);
        return send(res, 200, { urls: [] });
      }
      if (p === '/v13/deployments' && req.method === 'POST') {
        const b = json();
        const missing = b.files.filter((f) => !vercelFiles.has(f.sha)).map((f) => f.sha);
        if (missing.length) return send(res, 400, { error: { code: 'missing_files', message: 'Missing files', missing } });
        const d = { id: `dpl_${++seq}`, name: b.name, url: `${b.name}-abc123-owner.vercel.app`, readyState: 'BUILDING', alias: [], polls: 0, body: b, query: Object.fromEntries(url.searchParams) };
        vercelDeploys.set(d.id, d);
        return send(res, 200, { id: d.id, url: d.url, readyState: d.readyState });
      }
      const dm = p.match(/^\/v13\/deployments\/(.+)$/);
      if (dm && req.method === 'GET') {
        const d = vercelDeploys.get(decodeURIComponent(dm[1]));
        if (!d) return send(res, 404, { error: { code: 'not_found', message: 'Deployment not found' } });
        if (++d.polls >= state.vercelBuildPolls) {
          d.readyState = 'READY';
          d.alias = [`${d.name}-owner.vercel.app`, `${d.name}.vercel.app`];
        }
        return send(res, 200, { id: d.id, url: d.url, readyState: d.readyState, alias: d.alias });
      }
      return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    }

    // ================= Netlify =================
    if (path.startsWith('/netlify-site/')) {
      return state.netlifyPrivate ? send(res, 401, { message: 'Unauthorized' }) : (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<h1>ok</h1>'));
    }
    if (path.startsWith('/netlify/')) {
      if (!bearer(NETLIFY_TOKEN)) return send(res, 401, { code: 401, message: 'Access Denied: Invalid token' });
      const p = path.slice(8);
      if (p === '/api/v1/user') return send(res, 200, { email: 'owner@netlify.test', full_name: 'Owner' });
      if (p === '/api/v1/sites' && req.method === 'POST') {
        const b = json();
        if (state.netlifyTaken.has(b.name) || [...netlifySites.values()].some((x) => x.name === b.name)) return send(res, 422, { code: 422, message: 'Validation failed: subdomain must be unique' });
        const site = { id: `site-${++seq}`, name: b.name, ssl_url: `${server.base}/netlify-site/${b.name}`, url: `http://${b.name}.netlify.app` };
        netlifySites.set(site.id, site);
        return send(res, 201, site);
      }
      let mm;
      if ((mm = p.match(/^\/api\/v1\/sites\/([^/]+)$/)) && req.method === 'GET') {
        const site = netlifySites.get(decodeURIComponent(mm[1]));
        return site ? send(res, 200, site) : send(res, 404, { code: 404, message: 'Not Found' });
      }
      if ((mm = p.match(/^\/api\/v1\/sites\/([^/]+)\/deploys$/)) && req.method === 'POST') {
        const site = netlifySites.get(decodeURIComponent(mm[1]));
        if (!site) return send(res, 404, { code: 404, message: 'Not Found' });
        const b = json();
        const d = { id: `nd-${++seq}`, site_id: site.id, files: b.files, required: [...new Set(Object.values(b.files))], uploaded: new Set(), state: 'uploading', ssl_url: site.ssl_url };
        netlifyDeploys.set(d.id, d);
        return send(res, 200, { id: d.id, required: d.required, state: d.state });
      }
      if ((mm = p.match(/^\/api\/v1\/deploys\/([^/]+)\/files\/(.+)$/)) && req.method === 'PUT') {
        const d = netlifyDeploys.get(decodeURIComponent(mm[1]));
        const fp = `/${mm[2].split('/').map(decodeURIComponent).join('/')}`;
        if (!d || d.files[fp] !== sha1(raw)) return send(res, 422, { code: 422, message: 'File does not match' });
        d.uploaded.add(sha1(raw));
        return send(res, 200, { id: fp });
      }
      if ((mm = p.match(/^\/api\/v1\/deploys\/([^/]+)$/)) && req.method === 'GET') {
        const d = netlifyDeploys.get(decodeURIComponent(mm[1]));
        if (!d) return send(res, 404, { code: 404, message: 'Not Found' });
        d.state = d.required.every((s) => d.uploaded.has(s)) ? 'ready' : 'uploading';
        return send(res, 200, { id: d.id, state: d.state, ssl_url: d.ssl_url });
      }
      return send(res, 404, { code: 404, message: 'Not Found' });
    }

    // ================= Cloudflare =================
    if (path.startsWith('/cf/')) {
      const fail = (code, message, status = 400) => send(res, status, { success: false, errors: [{ code, message }], result: null });
      if (!bearer(CF_TOKEN)) return fail(10000, 'Authentication error', 403);
      const m = path.slice(3).match(/^\/accounts\/([^/]+)\/pages\/projects(\/[^/]+)?(\/deployments)?(\/[^/]+)?$/);
      if (!m) return fail(7003, 'No route for that URI', 404);
      if (m[1] !== CF_ACCOUNT) return fail(7003, 'Could not route to /accounts, perhaps your object identifier is invalid?', 404);
      const name = m[2]?.slice(1);
      if (!name && req.method === 'GET') return send(res, 200, { success: true, result: [...cfProjects.values()] });
      if (!name && req.method === 'POST') {
        const b = json();
        if (state.cfNoApp) return fail(8000011, 'There is an internal issue with your Cloudflare Pages Git installation.');
        const proj = { name: b.name, subdomain: `${b.name}.pages.dev`, production_branch: b.production_branch, source: b.source, build_config: b.build_config };
        cfProjects.set(b.name, proj);
        return send(res, 200, { success: true, result: proj });
      }
      const proj = cfProjects.get(name);
      if (!proj) return fail(8000007, 'Project not found. The specified project name does not match any of your existing projects.', 404);
      if (!m[3] && req.method === 'GET') return send(res, 200, { success: true, result: proj });
      if (m[3] && !m[4] && req.method === 'POST') {
        const d = { id: `cfd-${++seq}`, project: name, form: raw.toString('utf8'), latest_stage: { name: 'queued', status: 'active' } };
        cfDeploys.push(d);
        return send(res, 200, { success: true, result: { id: d.id, latest_stage: d.latest_stage } });
      }
      if (m[3] && m[4] && req.method === 'GET') {
        const d = cfDeploys.find((x) => x.id === m[4].slice(1));
        if (!d) return fail(8000009, 'Deployment not found', 404);
        d.latest_stage = { name: 'deploy', status: 'success' };
        return send(res, 200, { success: true, result: { id: d.id, latest_stage: d.latest_stage } });
      }
      return fail(7003, 'No route', 404);
    }
    send(res, 404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  server.base = base;
  return {
    base, state, calls, repos, blobs, trees, commits, vercelDeploys, vercelFiles, netlifySites, netlifyDeploys, cfProjects, cfDeploys,
    /** Files of a repo at a branch/commit: { path: text }. */
    files(fullName, ref = 'main') {
      const r = repos.get(fullName);
      const f = r && filesAt(r, ref);
      return f ? Object.fromEntries([...f].map(([fp, s]) => [fp, blobs.get(s).toString('utf8')])) : null;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
