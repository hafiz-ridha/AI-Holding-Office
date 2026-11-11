// Index of files the AI stored at outside services, and saving documents/reports to Google Drive (by the agent's
// tool, or automatically when a task finishes). Failed uploads stay "pending" with their Markdown and are retried by
// the scheduler; once synced, only the link is kept here (the text of results stays in tasks/business_reports).
import { q, now } from '../db/index.js';
import { truncate } from '../lib/text.js';
import { getSetting } from '../lib/settings.js';
import { localDate } from '../lib/time.js';
import { isChatReply } from '../router/modelSelector.js';
import { isConnected } from './store.js';
import * as google from './google.js';

const MAX_ATTEMPTS = 5;
export const KIND_LABEL = { document: 'Dokumen', report: 'Laporan', code: 'Kode', image: 'Gambar', database: 'Database', site: 'Website', file: 'File' };

export const getArtifact = (id) => q.get('SELECT * FROM artifacts WHERE id = ?', id) || null;

/**
 * A file of one business (HQ = null) at one provider, by index number ("12" / "#12"), link, external id
 * (e.g. "owner/repo"), exact title, or repo name. null when there is none: tools never reach other businesses' files.
 */
export function findBusinessArtifact(businessId, provider, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  const rows = q.all(
    "SELECT * FROM artifacts WHERE provider = ? AND business_id IS ? AND status != 'trashed' ORDER BY id DESC LIMIT 500",
    provider, businessId ?? null
  );
  const id = r.match(/^#?(\d+)$/)?.[1];
  if (id) return rows.find((x) => x.id === Number(id)) || null;
  const low = r.toLowerCase().replace(/\/+$/, '');
  const ext = (x) => String(x.external_id || '').toLowerCase();
  return rows.find((x) => x.url && x.url.toLowerCase().replace(/\/+$/, '') === low)
    || rows.find((x) => ext(x) && (ext(x) === low || low.includes(ext(x))))
    || rows.find((x) => x.title.toLowerCase() === low)
    || rows.find((x) => ext(x).endsWith(`/${low}`))
    || null;
}

function businessFolderName(businessId) {
  if (!businessId) return 'Holding (HQ)';
  return q.get('SELECT name FROM businesses WHERE id = ?', businessId)?.name || `Bisnis ${businessId}`;
}

const subFolder = (kind) => (kind === 'report' ? 'Laporan' : 'Dokumen');

async function upload(a, markdown, signal) {
  if (a.external_id) {
    try {
      return await google.updateDoc({ id: a.external_id, title: a.title, markdown, signal });
    } catch (e) {
      if (e.status !== 404) throw e; // deleted in Drive: make a new one
    }
  }
  const folderId = await google.ensureFolder([businessFolderName(a.business_id), subFolder(a.kind)], signal).catch(async (e) => {
    if (e.status !== 404) throw e;
    google.forgetFolders(); // a cached folder was deleted in Drive
    return google.ensureFolder([businessFolderName(a.business_id), subFolder(a.kind)], signal);
  });
  try {
    return await google.createDoc({ title: a.title, markdown, folderId, signal });
  } catch (e) {
    if (e.status !== 404) throw e;
    google.forgetFolders();
    const again = await google.ensureFolder([businessFolderName(a.business_id), subFolder(a.kind)], signal);
    return google.createDoc({ title: a.title, markdown, folderId: again, signal });
  }
}

function insertArtifact({ kind, title, businessId, taskId, employeeId, source, markdown }) {
  const t = now();
  const r = q.run(
    `INSERT INTO artifacts(provider, kind, title, mime, business_id, task_id, employee_id, status, source, content, created_at, updated_at)
     VALUES ('google_drive', ?, ?, 'application/vnd.google-apps.document', ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    kind, truncate(title, 200), businessId ?? null, taskId ?? null, employeeId ?? null, source, markdown, t, t
  );
  return getArtifact(Number(r.lastInsertRowid));
}

async function sync(a, markdown, signal) {
  try {
    const f = await upload(a, markdown, signal);
    q.run(
      `UPDATE artifacts SET external_id = ?, url = ?, status = 'synced', content = NULL, error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      f.id, f.url, now(), a.id
    );
  } catch (e) {
    const attempts = a.attempts + 1;
    q.run(
      `UPDATE artifacts SET status = ?, content = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ?`,
      attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', markdown, truncate(e.message, 300), attempts, now(), a.id
    );
  }
  return getArtifact(a.id);
}

/**
 * Save Markdown as a Google Doc and index it. The same task saving the same title again updates that document.
 * Returns the artifact row (status synced, or pending/failed with the error).
 */
export async function saveDocument({ title, markdown, businessId = null, taskId = null, employeeId = null, kind = 'document', source = 'agent', signal } = {}) {
  const clean = truncate(String(title || 'Dokumen').replace(/\s+/g, ' ').trim(), 200);
  const existing = taskId
    ? q.get("SELECT * FROM artifacts WHERE provider = 'google_drive' AND task_id = ? AND title = ? AND status != 'trashed' ORDER BY id DESC LIMIT 1", taskId, clean)
    : null;
  const a = existing || insertArtifact({ kind, title: clean, businessId, taskId, employeeId, source, markdown });
  if (existing) q.run('UPDATE artifacts SET attempts = 0, updated_at = ? WHERE id = ?', now(), a.id);
  return sync(getArtifact(a.id), markdown, signal);
}

/** Should this finished task's text become a Drive file automatically? */
function autoSaveWanted(task, content, report) {
  if (!getSetting('drive_auto_save') || !isConnected('google_drive')) return false;
  if (!String(content || '').trim()) return false;
  if (!report && isChatReply(task)) return false;
  if (!report && String(content).length < getSetting('drive_auto_save_min_chars')) return false;
  // The agent already saved a document for this task.
  return !q.get("SELECT 1 x FROM artifacts WHERE task_id = ? AND source = 'agent' AND status != 'trashed'", task.id);
}

/** Automatic save of a finished task's result / report (first attempt right away; retried later on failure). */
export async function autoSaveTask(task, employee, content, { report = null, signal } = {}) {
  if (!autoSaveWanted(task, content, report)) return null;
  const date = localDate(Date.now(), getSetting('timezone'));
  const title = `${date} ${report ? 'Laporan — ' : ''}${task.title}`;
  try {
    return await saveDocument({
      title, markdown: content, businessId: task.business_id ?? null, taskId: task.id, employeeId: employee?.id ?? null,
      kind: report ? 'report' : 'document', source: 'auto', signal,
    });
  } catch {
    return null; // never block finishing the task
  }
}

/** Retry pending uploads (scheduler). At most `limit` per run, with a growing pause between attempts. */
export async function retryPendingArtifacts({ limit = 3, at = Date.now() } = {}) {
  if (!isConnected('google_drive')) return 0;
  const rows = q.all(
    `SELECT * FROM artifacts WHERE provider = 'google_drive' AND status = 'pending' AND content IS NOT NULL
       AND updated_at <= ? - attempts * 120000 ORDER BY updated_at LIMIT ?`,
    at, limit
  );
  for (const a of rows) await sync(a, a.content);
  return rows.length;
}

/** Owner clicked "coba lagi": try a failed/pending upload now. */
export async function retryArtifact(id) {
  const a = getArtifact(id);
  if (!a || !a.content || !['pending', 'failed'].includes(a.status)) return a;
  q.run('UPDATE artifacts SET attempts = 0 WHERE id = ?', a.id);
  return sync(getArtifact(a.id), a.content);
}

export function markTrashed(id) {
  q.run("UPDATE artifacts SET status = 'trashed', updated_at = ? WHERE id = ?", now(), id);
}

const SELECT = `SELECT a.id, a.provider, a.kind, a.title, a.url, a.external_id, a.status, a.source, a.error, a.attempts, a.business_id, a.task_id,
  a.employee_id, a.created_at, a.updated_at, b.name AS business_name, e.name AS employee_name, t.title AS task_title
  FROM artifacts a LEFT JOIN businesses b ON b.id = a.business_id LEFT JOIN employees e ON e.id = a.employee_id
  LEFT JOIN tasks t ON t.id = a.task_id`;

export function listArtifacts({ businessId, kind = null, status = null, limit = 200 } = {}) {
  const where = [];
  const vals = [];
  if (businessId !== undefined) {
    where.push('a.business_id IS ?');
    vals.push(businessId);
  }
  if (kind) {
    where.push('a.kind = ?');
    vals.push(kind);
  }
  if (status) {
    where.push('a.status = ?');
    vals.push(status);
  }
  return q.all(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`, ...vals, limit);
}

export const artifactsForTask = (taskId) => q.all(`${SELECT} WHERE a.task_id = ? AND a.status != 'trashed' ORDER BY a.id`, taskId);

/** Synced files of a task as short "📄 title — url" lines (chat, Telegram). */
export function fileLines(taskId) {
  return artifactsForTask(taskId).filter((a) => a.status === 'synced' && a.url).map((a) => ({ title: a.title, url: a.url, kind: a.kind }));
}
