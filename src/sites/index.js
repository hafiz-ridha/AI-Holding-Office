// Sites and code repositories the AI keeps on GitHub. A repository is an artifact (provider 'github'); its meta holds
// the branch, the last commit and a private preview token. Publishing goes through publishSite(), which records the
// state per hosting service (deployments) and announces the result.
import { q, now, json } from '../db/index.js';
import { config } from '../config.js';
import { bus } from '../events.js';
import { randomToken } from '../lib/crypto.js';
import { truncate } from '../lib/text.js';
import { getArtifact } from '../connections/artifacts.js';
import { isConnected } from '../connections/store.js';
import * as github from '../connections/github.js';
import { HOSTS, HOST_LABEL, hostConnector } from './hosts.js';

export { HOST_LABEL, hostConnector };

export const siteMeta = (a) => json(a?.meta, {}) || {};
export const connectedHosts = () => Object.keys(HOST_LABEL).filter((h) => isConnected(hostConnector(h)));

/** Index a repository the AI just created. */
export function registerRepo({ repo, kind = 'site', businessId = null, taskId = null, employeeId = null }) {
  const t = now();
  const meta = { full_name: repo.full_name, branch: repo.default_branch || 'main', head: null, preview_token: randomToken(24) };
  const r = q.run(
    `INSERT INTO artifacts(provider, kind, external_id, url, title, business_id, task_id, employee_id, status, source, meta, created_at, updated_at)
     VALUES ('github', ?, ?, ?, ?, ?, ?, ?, 'synced', 'agent', ?, ?, ?)`,
    kind, repo.full_name, repo.html_url, repo.name, businessId ?? null, taskId ?? null, employeeId ?? null, JSON.stringify(meta), t, t
  );
  return getArtifact(Number(r.lastInsertRowid));
}

export function setHead(a, sha) {
  const meta = { ...siteMeta(a), head: sha };
  q.run('UPDATE artifacts SET meta = ?, updated_at = ? WHERE id = ?', JSON.stringify(meta), now(), a.id);
  return getArtifact(a.id);
}

/** Address of the private preview (latest commit of the branch, or one commit). Absolute when APP_URL is set. */
export function previewUrl(a, ref = null) {
  const m = siteMeta(a);
  if (!m.preview_token) return null;
  const path = `/preview/${m.preview_token}/${ref || m.branch || 'main'}/`;
  return config.appUrl ? `${config.appUrl.replace(/\/+$/, '')}${path}` : path;
}

export function siteByPreviewToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  return q.get("SELECT * FROM artifacts WHERE provider = 'github' AND status != 'trashed' AND json_extract(meta, '$.preview_token') = ?", token) || null;
}

// ---------------- publication state ----------------
export const deploymentsFor = (artifactId) => q.all('SELECT * FROM deployments WHERE artifact_id = ? ORDER BY provider', artifactId);
const getDeployment = (artifactId, provider) => q.get('SELECT * FROM deployments WHERE artifact_id = ? AND provider = ?', artifactId, provider) || null;

function saveDeployment(artifactId, provider, patch) {
  const t = now();
  const cur = getDeployment(artifactId, provider);
  const next = { project: null, url: null, status: 'queued', commit_sha: null, error: null, approval_id: null, deployed_at: null, ...cur, ...patch };
  q.run(
    `INSERT INTO deployments(artifact_id, provider, project, url, status, commit_sha, error, approval_id, deployed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(artifact_id, provider) DO UPDATE SET project = excluded.project, url = excluded.url, status = excluded.status,
       commit_sha = excluded.commit_sha, error = excluded.error, approval_id = excluded.approval_id, deployed_at = excluded.deployed_at,
       updated_at = excluded.updated_at`,
    artifactId, provider, next.project, next.url, next.status, next.commit_sha, next.error ? truncate(next.error, 500) : null,
    next.approval_id, next.deployed_at, cur?.created_at || t, t
  );
  return getDeployment(artifactId, provider);
}

const running = new Set(); // "artifactId:host" being published right now
export const isPublishing = (artifactId, host) => running.has(`${artifactId}:${host}`);

/**
 * Publish a commit (default: the branch's latest) of a site repo to a hosting service.
 * Returns { url, project, state, warning, commit }; throws with a readable message.
 */
export async function publishSite(a, host, commit = null, { signal, approvalId = null, by = 'agent' } = {}) {
  if (!HOSTS[host]) throw new Error(`Layanan "${host}" tidak dikenal`);
  if (!isConnected(hostConnector(host))) throw new Error(`${HOST_LABEL[host]} belum terhubung (dashboard → Koneksi)`);
  const meta = siteMeta(a);
  if (!meta.full_name) throw new Error('Repo ini tidak punya data GitHub');
  const key = `${a.id}:${host}`;
  if (running.has(key)) throw new Error(`"${a.title}" sedang diterbitkan ke ${HOST_LABEL[host]}; tunggu sampai selesai`);
  running.add(key);
  try {
    const sha = commit || (await github.headSha(meta.full_name, meta.branch || 'main', signal));
    const prev = getDeployment(a.id, host);
    saveDeployment(a.id, host, { status: 'building', commit_sha: sha, error: null, approval_id: approvalId ?? null });
    try {
      const out = await HOSTS[host]({ site: a, meta, commit: sha, project: prev?.project || null, signal });
      // A service still building after our wait is recorded as published with a note: the address is assigned.
      const d = saveDeployment(a.id, host, {
        status: 'ready', url: out.url || prev?.url || null, project: out.project || prev?.project || null,
        error: out.warning || null, deployed_at: now(),
      });
      bus.emit('site:deployed', { artifact: a, host, deployment: d, by });
      return { ...out, commit: sha };
    } catch (e) {
      saveDeployment(a.id, host, { status: 'error', error: e.message });
      throw e;
    }
  } finally {
    running.delete(key);
  }
}

/** Natural-language result of a publication (chat, Telegram, approval result). */
export function publishText(a, host, out) {
  const where = HOST_LABEL[host];
  const head = out.state === 'ready'
    ? `Website "${a.title}" sudah online di ${where}: ${out.url}`
    : `Website "${a.title}" sedang diterbitkan di ${where}${out.url ? `; alamatnya nanti ${out.url}` : ''}.`;
  return `${head} (commit ${String(out.commit || '').slice(0, 7)})${out.warning ? `\nCatatan: ${out.warning}` : ''}`;
}

/** After a restart nothing is publishing anymore. */
export function recoverInterruptedPublishing() {
  return q.run(
    "UPDATE deployments SET status = 'error', error = 'Terhenti karena aplikasi dimulai ulang; terbitkan lagi.', updated_at = ? WHERE status IN ('queued', 'building')",
    now()
  ).changes;
}

/** Repos for the dashboard (Website page), newest first, with their publications. */
export function listSites({ businessId } = {}) {
  const rows = q.all(
    `SELECT a.*, b.name AS business_name, e.name AS employee_name FROM artifacts a
       LEFT JOIN businesses b ON b.id = a.business_id LEFT JOIN employees e ON e.id = a.employee_id
     WHERE a.provider = 'github' AND a.status != 'trashed' ${businessId !== undefined ? 'AND a.business_id IS ?' : ''}
     ORDER BY a.updated_at DESC LIMIT 200`,
    ...(businessId !== undefined ? [businessId] : [])
  );
  return rows.map((a) => {
    const m = siteMeta(a);
    return {
      id: a.id, title: a.title, kind: a.kind, url: a.url, full_name: m.full_name, branch: m.branch, head: m.head,
      business_id: a.business_id, business_name: a.business_name, employee_name: a.employee_name, task_id: a.task_id,
      created_at: a.created_at, updated_at: a.updated_at, preview_url: previewUrl(a),
      deployments: deploymentsFor(a.id).map((d) => ({ provider: d.provider, label: HOST_LABEL[d.provider], url: d.url, status: d.status, commit: d.commit_sha, error: d.error, deployed_at: d.deployed_at, updated_at: d.updated_at })),
    };
  });
}
