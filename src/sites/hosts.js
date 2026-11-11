// Publishing a site (a commit of a GitHub repo) to a hosting service.
//  - Vercel, Netlify: the files of the commit are uploaded directly (no Git integration, so nothing goes live
//    without an approved publish).
//  - GitHub Pages, Cloudflare Pages: the service builds from its own branch (gh-pages / cf-pages), moved to the commit.
// Each adapter returns { url, project, state: 'ready' | 'building', warning? }.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { connectionConfig } from '../connections/store.js';
import { withToken } from '../connections/tokens.js';
import * as github from '../connections/github.js';

const WAIT_MS = 180_000;
const MAX_FILES = 200;
const MAX_BYTES = 8 * 1024 * 1024;
const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');

export const HOST_LABEL = { vercel: 'Vercel', netlify: 'Netlify', cloudflare: 'Cloudflare Pages', github_pages: 'GitHub Pages' };
export const hostConnector = (host) => (host === 'github_pages' ? 'github' : host);

/** Lowercase name for a project at a hosting service. */
export function slug(name, max = 58) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return s || 'situs';
}

const suffix = () => crypto.randomBytes(2).toString('hex');

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Calls check() until it returns a value (or throws); null after WAIT_MS. */
async function waitFor(check, signal) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const r = await check();
    if (r) return r;
    if (Date.now() >= until) return null;
    await sleep(Math.max(config.deployPollMs, 1), signal);
  }
}

/** Files of a commit with their SHA1 (Vercel/Netlify). Needs index.html at the root. */
export async function collectFiles(meta, commit, signal) {
  const tree = (await github.listTree(meta.full_name, commit, signal)).filter((f) => !f.path.startsWith('.github/'));
  if (!tree.some((f) => f.path === 'index.html')) throw new Error('Repo ini belum punya index.html di folder utama, jadi belum bisa diterbitkan sebagai website.');
  if (tree.length > MAX_FILES) throw new Error(`Terlalu banyak file untuk diterbitkan (${tree.length}; maks ${MAX_FILES}).`);
  const total = tree.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BYTES) throw new Error(`Ukuran situs terlalu besar (${Math.ceil(total / 1048576)} MB; maks 8 MB). Gambar besar sebaiknya disimpan di layanan penyimpanan.`);
  const out = [];
  for (const f of tree) {
    const buf = await github.readBlob(meta.full_name, f.sha, signal);
    out.push({ path: f.path, buf, size: buf.length, sha1: crypto.createHash('sha1').update(buf).digest('hex') });
  }
  return out;
}

// ---------------- Vercel ----------------
async function vercel({ meta, commit, project, signal }) {
  const team = connectionConfig('vercel').team_id;
  const v = (method, path, opts = {}) => withToken('vercel', config.vercelApiBase, path, { method, ...opts, query: { ...(opts.query || {}), ...(team ? { teamId: team } : {}) }, signal });
  const files = await collectFiles(meta, commit, signal);
  for (const f of files) {
    await v('POST', '/v2/files', { body: f.buf, headers: { 'content-type': 'application/octet-stream', 'x-vercel-digest': f.sha1 } });
  }
  const name = project || slug(meta.full_name.split('/')[1], 100);
  let d = await v('POST', '/v13/deployments', {
    query: { skipAutoDetectionConfirmation: 1 },
    json: {
      name,
      files: files.map((f) => ({ file: f.path, sha: f.sha1, size: f.size })),
      target: 'production',
      projectSettings: { framework: null, buildCommand: null, installCommand: null, devCommand: null, outputDirectory: null },
      meta: { source: 'ai-office', commit },
    },
  });
  const ready = await waitFor(async () => {
    d = await v('GET', `/v13/deployments/${encodeURIComponent(d.id)}`);
    if (['ERROR', 'CANCELED', 'BLOCKED'].includes(d.readyState)) throw new Error(`Vercel gagal menerbitkan (${d.readyState}${d.errorMessage ? `: ${d.errorMessage}` : ''})`);
    return d.readyState === 'READY' ? d : null;
  }, signal);
  // The production alias (<project>.vercel.app) is public; the deployment's own URL is behind a Vercel login.
  const aliases = (d.alias || []).filter((a) => typeof a === 'string');
  const alias = aliases.find((a) => a === `${name}.vercel.app`) || aliases.filter((a) => a.endsWith('.vercel.app')).sort((a, b) => a.length - b.length)[0] || aliases[0];
  if (!ready) return { url: alias ? `https://${alias}` : null, project: name, state: 'building', warning: 'Vercel masih memproses; alamatnya aktif dalam beberapa menit.' };
  if (!alias) return { url: `https://${d.url}`, project: name, state: 'ready', warning: 'Vercel belum memberi alamat produksi; alamat ini bisa meminta login Vercel. Cek Vercel → proyek → Domains.' };
  return { url: `https://${alias}`, project: name, state: 'ready' };
}

// ---------------- Netlify ----------------
async function netlifyIsPrivate(url) {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) return true;
    const loc = r.headers.get('location') || '';
    return r.status >= 300 && r.status < 400 && /netlify\.com\/(login|authorize)|_netlify|password/i.test(loc);
  } catch {
    return false;
  }
}

async function netlify({ meta, commit, project, signal }) {
  const n = (method, path, opts = {}) => withToken('netlify', config.netlifyApiBase, path, { method, ...opts, signal });
  let site = null;
  if (project) {
    site = await n('GET', `/api/v1/sites/${encodeURIComponent(project)}`).catch((e) => {
      if (e.status === 404) return null; // deleted at Netlify: make a new one
      throw e;
    });
  }
  const files = await collectFiles(meta, commit, signal);
  if (!site) {
    const base = slug(meta.full_name.split('/')[1], 55);
    try {
      site = await n('POST', '/api/v1/sites', { json: { name: base } });
    } catch (e) {
      if (e.status !== 422) throw e; // name taken (Netlify names are global)
      site = await n('POST', '/api/v1/sites', { json: { name: `${base}-${suffix()}` } });
    }
  }
  let d = await n('POST', `/api/v1/sites/${encodeURIComponent(site.id)}/deploys`, {
    json: { files: Object.fromEntries(files.map((f) => [`/${f.path}`, f.sha1])), title: `AI Office · ${commit.slice(0, 7)}` },
  });
  const required = new Set(d.required || []);
  for (const f of files) {
    if (!required.has(f.sha1)) continue;
    await n('PUT', `/api/v1/deploys/${encodeURIComponent(d.id)}/files/${enc(f.path)}`, { body: f.buf, headers: { 'content-type': 'application/octet-stream' } });
    required.delete(f.sha1);
  }
  const ready = await waitFor(async () => {
    d = await n('GET', `/api/v1/deploys/${encodeURIComponent(d.id)}`);
    if (d.state === 'error') throw new Error(`Netlify gagal menerbitkan${d.error_message ? `: ${d.error_message}` : ''}`);
    return d.state === 'ready' ? d : null;
  }, signal);
  const url = site.ssl_url || d.ssl_url || site.url;
  if (!ready) return { url, project: site.id, state: 'building', warning: 'Netlify masih memproses; alamatnya aktif dalam beberapa menit.' };
  const warning = (await netlifyIsPrivate(url))
    ? 'Situs ini masih privat di Netlify (akun baru default privat). Buka Netlify → Project configuration → General → Visibility, lalu pilih Public.'
    : null;
  return { url, project: site.id, state: 'ready', warning };
}

// ---------------- GitHub Pages ----------------
async function githubPages({ meta, commit, signal }) {
  const fn = meta.full_name;
  const tree = await github.listTree(fn, commit, signal);
  if (!tree.some((f) => f.path === 'index.html')) throw new Error('Repo ini belum punya index.html di folder utama, jadi belum bisa diterbitkan sebagai website.');
  const repo = await github.getRepo(fn, signal);
  if (repo.private) await github.setPrivate(fn, false, signal); // GitHub Pages on a free account needs a public repo
  await github.setBranch(fn, 'gh-pages', commit, signal);
  const info = await github.enablePages(fn, 'gh-pages', signal);
  const [owner, name] = fn.split('/');
  const url = info?.html_url || `https://${owner.toLowerCase()}.github.io/${name}/`;
  const built = await waitFor(async () => {
    const b = await github.latestPagesBuild(fn, signal);
    if (!b) return null;
    if (b.commit && b.commit !== commit) return null; // an older build
    if (b.status === 'errored') throw new Error(`GitHub Pages gagal membangun situs${b.error?.message ? `: ${b.error.message}` : ''}`);
    return b.status === 'built' ? b : null;
  }, signal);
  if (!built) return { url, project: 'gh-pages', state: 'building', warning: 'GitHub Pages masih membangun situs (bisa sampai 10 menit).' };
  return { url, project: 'gh-pages', state: 'ready' };
}

// ---------------- Cloudflare Pages ----------------
const CF_APP_HINT = 'Pastikan GitHub App "Cloudflare Workers and Pages" sudah dipasang di akun GitHub ini untuk All repositories (dashboard Cloudflare → Workers & Pages → Create → Pages → Connect to Git).';

async function cloudflare({ meta, commit, project, signal }) {
  const acct = connectionConfig('cloudflare').account_id;
  const cf = async (method, path, opts = {}) => {
    const r = await withToken('cloudflare', config.cloudflareApiBase, `/accounts/${acct}/pages/projects${path}`, { method, ...opts, signal });
    return r?.result ?? r;
  };
  const fn = meta.full_name;
  const [owner, repoName] = fn.split('/');
  const tree = await github.listTree(fn, commit, signal);
  if (!tree.some((f) => f.path === 'index.html')) throw new Error('Repo ini belum punya index.html di folder utama, jadi belum bisa diterbitkan sebagai website.');
  await github.setBranch(fn, 'cf-pages', commit, signal);
  let name = project || slug(repoName, 58);
  let proj = await cf('GET', `/${name}`).catch((e) => {
    if (e.status === 404) return null;
    throw e;
  });
  if (proj && proj.source?.config?.repo_name && proj.source.config.repo_name !== repoName) {
    proj = null; // this name belongs to a project of another repo
    name = `${slug(repoName, 52)}-${suffix()}`;
  }
  if (!proj) {
    try {
      proj = await cf('POST', '', {
        json: {
          name,
          production_branch: 'cf-pages',
          build_config: { build_command: '', destination_dir: '' },
          source: {
            type: 'github',
            config: { owner, repo_name: repoName, production_branch: 'cf-pages', production_deployments_enabled: true, preview_deployment_setting: 'none', pr_comments_enabled: false },
          },
        },
      });
    } catch (e) {
      throw new Error(`${e.message}. ${CF_APP_HINT}`);
    }
  }
  const form = new FormData();
  form.append('branch', 'cf-pages');
  let d = await cf('POST', `/${name}/deployments`, { body: form });
  const url = `https://${proj.subdomain || `${name}.pages.dev`}`;
  const ready = await waitFor(async () => {
    d = await cf('GET', `/${name}/deployments/${encodeURIComponent(d.id)}`);
    const st = d.latest_stage || {};
    if (st.status === 'failure' || st.status === 'canceled') throw new Error(`Cloudflare Pages gagal menerbitkan (tahap ${st.name || '?'}). Lihat log di dashboard Cloudflare.`);
    return st.name === 'deploy' && st.status === 'success' ? d : null;
  }, signal);
  if (!ready) return { url, project: name, state: 'building', warning: 'Cloudflare Pages masih membangun situs; alamatnya aktif dalam beberapa menit.' };
  return { url, project: name, state: 'ready' };
}

export const HOSTS = { vercel, netlify, github_pages: githubPages, cloudflare };
