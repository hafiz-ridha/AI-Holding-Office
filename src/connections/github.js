// GitHub client (REST, token pasted by the owner). Repositories the AI creates are private; several files are written
// as one commit with the Git Data API (tree with inline contents → commit → move the branch). Publishing branches
// (gh-pages, cf-pages) are moved to a chosen commit. Errors never contain the token.
import { config } from '../config.js';
import { withToken } from './tokens.js';
import { ConnectionError } from './store.js';

const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const repoPath = (fullName) => `/repos/${enc(fullName)}`;

const gh = (method, path, opts = {}) => withToken('github', config.githubApiBase, path, { method, ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });

export const me = (signal) => gh('GET', '/user', { signal });

/** New private repository with a first commit (README), so commits and refs work right away. */
export async function createRepo({ name, description = '', isPrivate = true, signal } = {}) {
  try {
    return await gh('POST', '/user/repos', {
      json: { name, description: description.slice(0, 300), private: isPrivate, auto_init: true, has_wiki: false, has_projects: false },
      signal,
    });
  } catch (e) {
    if (e.status === 422 && /already exists/i.test(e.message)) {
      throw new ConnectionError(`Nama repo "${name}" sudah dipakai di akun GitHub ini. Pilih nama lain.`, { status: 422, code: 'name_taken' });
    }
    if (e.status === 403) {
      throw new ConnectionError(`${e.message}. Token GitHub perlu izin membuat repo (fine-grained: All repositories + Administration read/write; klasik: scope repo).`, { status: 403 });
    }
    throw e;
  }
}

export const getRepo = (fullName, signal) => gh('GET', repoPath(fullName), { signal });

export async function headSha(fullName, branch, signal) {
  const r = await gh('GET', `${repoPath(fullName)}/git/ref/heads/${enc(branch)}`, { signal });
  return r.object.sha;
}

/**
 * Write files [{ path, content }] as one commit on `branch`. Retries once when the branch moved meanwhile.
 * Returns { sha, url }.
 */
export async function commitFiles(fullName, branch, files, message, signal) {
  for (let attempt = 0; ; attempt++) {
    const head = await headSha(fullName, branch, signal);
    const base = await gh('GET', `${repoPath(fullName)}/git/commits/${head}`, { signal });
    const tree = await gh('POST', `${repoPath(fullName)}/git/trees`, {
      json: { base_tree: base.tree.sha, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) },
      signal,
    });
    const commit = await gh('POST', `${repoPath(fullName)}/git/commits`, { json: { message, tree: tree.sha, parents: [head] }, signal });
    try {
      await gh('PATCH', `${repoPath(fullName)}/git/refs/heads/${enc(branch)}`, { json: { sha: commit.sha, force: false }, signal });
    } catch (e) {
      if (e.status === 422 && attempt === 0) continue; // not a fast-forward: someone committed meanwhile
      throw e;
    }
    return { sha: commit.sha, url: commit.html_url || `https://github.com/${fullName}/commit/${commit.sha}` };
  }
}

/** All files (blobs) at a branch or commit: [{ path, size, sha }]. */
export async function listTree(fullName, ref, signal) {
  const r = await gh('GET', `${repoPath(fullName)}/git/trees/${enc(ref)}`, { query: { recursive: 1 }, signal });
  if (r.truncated) throw new ConnectionError('Repo terlalu besar untuk dibaca sekaligus');
  return (r.tree || []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size || 0, sha: e.sha }));
}

/** One file at a ref: { path, sha, size, buf } (≤ 1 MB, contents API). null when it does not exist. */
export async function readFile(fullName, path, ref, signal) {
  let r;
  try {
    r = await gh('GET', `${repoPath(fullName)}/contents/${enc(path)}`, { query: { ref }, signal });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  if (Array.isArray(r) || r?.type !== 'file') return null;
  if (r.encoding !== 'base64' || typeof r.content !== 'string') throw new ConnectionError(`File ${path} terlalu besar (maks 1 MB)`, { status: 413 });
  return { path: r.path, sha: r.sha, size: r.size, buf: Buffer.from(r.content, 'base64') };
}

export async function readBlob(fullName, sha, signal) {
  const r = await gh('GET', `${repoPath(fullName)}/git/blobs/${sha}`, { signal });
  return Buffer.from(r.content || '', r.encoding === 'base64' ? 'base64' : 'utf8');
}

/** Point `branch` at `sha` (created when missing, moved otherwise). */
export async function setBranch(fullName, branch, sha, signal) {
  try {
    await gh('PATCH', `${repoPath(fullName)}/git/refs/heads/${enc(branch)}`, { json: { sha, force: true }, signal });
  } catch (e) {
    if (e.status !== 422 && e.status !== 404) throw e;
    await gh('POST', `${repoPath(fullName)}/git/refs`, { json: { ref: `refs/heads/${branch}`, sha }, signal });
  }
}

export const setPrivate = (fullName, isPrivate, signal) => gh('PATCH', repoPath(fullName), { json: { private: isPrivate }, signal });

export async function pagesInfo(fullName, signal) {
  try {
    return await gh('GET', `${repoPath(fullName)}/pages`, { signal });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Serve `branch` (root folder) with GitHub Pages: enable, or switch the source branch. */
export async function enablePages(fullName, branch, signal) {
  const cur = await pagesInfo(fullName, signal);
  if (!cur) {
    return gh('POST', `${repoPath(fullName)}/pages`, { json: { build_type: 'legacy', source: { branch, path: '/' } }, signal });
  }
  if (cur.source?.branch !== branch || (cur.source?.path && cur.source.path !== '/')) {
    await gh('PUT', `${repoPath(fullName)}/pages`, { json: { build_type: 'legacy', source: { branch, path: '/' } }, signal });
    return (await pagesInfo(fullName, signal)) || cur;
  }
  await gh('POST', `${repoPath(fullName)}/pages/builds`, { signal }).catch(() => null); // rebuild now (the branch moved)
  return cur;
}

export async function latestPagesBuild(fullName, signal) {
  try {
    return await gh('GET', `${repoPath(fullName)}/pages/builds/latest`, { signal });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
