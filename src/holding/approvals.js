// Owner approvals. Extracted from AI results that flag risky actions. Deciding only records the owner's decision:
// the application never executes the action itself.
import { q, now } from '../db/index.js';
import { truncate } from '../lib/text.js';
import { bus } from '../events.js';

const MARK = /PERLU PERSETUJUAN (?:ADMIN|OWNER|PEMILIK)\s*[:\-–]?\s*(.*)/i;

export function extractApprovalItems(text) {
  const items = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARK);
    if (!m) continue;
    let detail = m[1].replace(/[*_`]/g, '').trim();
    // Label on its own line: take the next non-empty line as the detail.
    if (!detail && lines[i + 1]) detail = lines[i + 1].replace(/^[\s\-*•\d.]+/, '').replace(/[*_`]/g, '').trim();
    if (detail && detail.length > 3 && !items.includes(detail)) items.push(truncate(detail, 400));
  }
  return items.slice(0, 5);
}

export function createApprovalsFromResult(task, text) {
  const items = extractApprovalItems(text);
  const created = [];
  for (const detail of items) {
    const dup = q.get(
      "SELECT id FROM approvals WHERE status = 'pending' AND detail = ? AND business_id IS ?",
      detail,
      task.business_id ?? null
    );
    if (dup) continue;
    const r = q.run(
      'INSERT INTO approvals(task_id, business_id, title, detail, status, created_at) VALUES (?,?,?,?,?,?)',
      task.id, task.business_id ?? null, truncate(task.title, 200), detail, 'pending', now()
    );
    created.push(r.lastInsertRowid);
  }
  if (created.length) bus.emit('approval:created', { task, ids: created, items });
  return created;
}

export function listApprovals({ status = null, businessId, limit = 100 } = {}) {
  const where = [];
  const vals = [];
  if (status) {
    where.push('a.status = ?');
    vals.push(status);
  }
  if (businessId !== undefined) {
    where.push('a.business_id IS ?');
    vals.push(businessId);
  }
  return q.all(
    `SELECT a.*, b.name AS business_name FROM approvals a LEFT JOIN businesses b ON b.id = a.business_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.status = 'pending' DESC, a.id DESC LIMIT ?`,
    ...vals, limit
  );
}

export function decideApproval(id, decision, by, note = '') {
  if (!['approved', 'rejected'].includes(decision)) {
    const e = new Error('Keputusan harus approved atau rejected');
    e.statusCode = 400;
    throw e;
  }
  const r = q.run(
    "UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    decision, by, truncate(note || '', 500), now(), id
  );
  if (!r.changes) {
    const e = new Error('Persetujuan tidak ditemukan atau sudah diputuskan');
    e.statusCode = 404;
    throw e;
  }
  return q.get('SELECT * FROM approvals WHERE id = ?', id);
}

export function pendingApprovalCount() {
  return q.get("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").n;
}
