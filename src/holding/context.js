// The single gateway that decides which business data an AI call may see.
// Rules:
//  1. Business Manager: only their business (+ businesses the owner granted via extra_access).
//  2. Business staff & shared services: only the business of the task they are working on.
//  3. Group CEO: cross-business summaries only when the owner allows it (setting group_ceo_cross_business).
//  4. Finance data only for finance roles, business managers, and the Group CEO.
//  5. Documents from another business only when explicitly shared (document_shares).
import { q, json } from '../db/index.js';
import { getSetting } from '../lib/settings.js';
import { localDate, todayRange } from '../lib/time.js';
import { truncate } from '../lib/text.js';
import { searchKnowledge } from './documents.js';
import { summary as financeSummary, summaryText, monthRange } from './finance.js';
import { businessIdsOf } from '../agents/employees.js';

const FINANCE_ROLES = new Set(['finance', 'group_finance', 'business_manager', 'ceo']);

export function canSeeFinance(employee) {
  return Boolean(employee && (employee.is_manager || FINANCE_ROLES.has(employee.role_key)));
}

// May `employee` work on / read business `businessId`?
export function canAccessBusiness(employee, businessId) {
  if (!employee) return false;
  if (businessId === null || businessId === undefined) return true; // holding/general context
  if (employee.is_manager) return true;
  if (employee.org_unit === 'shared') return true; // shared services serve every business, one task at a time
  const b = q.get('SELECT manager_employee_id FROM businesses WHERE id = ?', businessId);
  if (!b) return false;
  if (b.manager_employee_id === employee.id) return true;
  return businessIdsOf(employee.id).includes(businessId);
}

// Businesses whose data may appear in this employee's context for this task.
export function readableBusinessIds(employee, task) {
  const ids = new Set();
  if (task.business_id) ids.add(task.business_id);
  if (employee?.role_key === 'business_manager' && task.business_id) {
    const b = q.get('SELECT manager_employee_id, extra_access FROM businesses WHERE id = ?', task.business_id);
    if (b?.manager_employee_id === employee.id) for (const x of json(b.extra_access, [])) ids.add(Number(x));
  }
  return [...ids];
}

export function businessProfile(businessId) {
  const b = q.get('SELECT id, slug, name, industry, description, status FROM businesses WHERE id = ?', businessId);
  if (!b) return null;
  return { ...b, description: truncate(b.description || '', 800) };
}

function taskStats(businessId, from, to) {
  const r = q.get(
    `SELECT COUNT(*) total, SUM(status='completed') completed, SUM(status='failed') failed,
       SUM(status IN ('pending','assigned','processing')) active
     FROM tasks WHERE business_id = ? AND created_at >= ? AND created_at < ?`,
    businessId, from, to
  );
  return { total: r.total || 0, completed: r.completed || 0, failed: r.failed || 0, active: r.active || 0 };
}

function monthBounds(tz) {
  const today = localDate(Date.now(), tz);
  const [from, to] = monthRange(today);
  const [start] = todayRange(tz, Date.parse(`${from}T12:00:00Z`));
  const [, end] = todayRange(tz, Date.parse(`${to}T12:00:00Z`));
  return { from, to, start, end };
}

/** Context block for one business, as seen by `employee` working on `task`. */
export function businessContextText(employee, task, { kbQuery = '', kbLimit = 3 } = {}) {
  const parts = [];
  const tz = getSetting('timezone');
  for (const bid of readableBusinessIds(employee, task)) {
    if (!canAccessBusiness(employee, bid) && bid === task.business_id) continue;
    const p = businessProfile(bid);
    if (!p) continue;
    const own = bid === task.business_id;
    parts.push(`### Bisnis: ${p.name} (slug: ${p.slug})${own ? '' : ' — akses tambahan dari pemilik'}
Industri: ${p.industry || 'belum diisi'}
Status: ${p.status}
Deskripsi: ${p.description || 'belum diisi'}`);
    const kb = searchKnowledge(bid, kbQuery, { limit: own ? kbLimit : 1, maxChars: own ? 2400 : 800 });
    parts.push(
      kb.length
        ? `Knowledge base ${p.name}:\n` + kb.map((d) => `- [${d.title}] ${d.snippet.replace(/\n+/g, ' ')}`).join('\n')
        : `Dokumen internal ${p.name}: belum ada yang diunggah (pakai riset web & pengetahuan umum)`
    );
    if (canSeeFinance(employee)) {
      const m = monthBounds(tz);
      parts.push(`Keuangan ${p.name} bulan ini:\n${summaryText(financeSummary(bid, m.from, m.to))}`);
    }
  }
  return parts.join('\n\n');
}

/** Cross-business overview for the Group CEO (aggregates only; no raw documents). */
export function holdingOverviewText(task) {
  const tz = getSetting('timezone');
  const m = monthBounds(tz);
  const cross = getSetting('group_ceo_cross_business');
  let businesses = q.all("SELECT * FROM businesses WHERE status = 'active' ORDER BY id");
  if (task.business_id) businesses = businesses.filter((b) => b.id === task.business_id);
  else if (!cross) {
    return {
      businesses,
      text: businesses.map((b) => `- slug "${b.slug}": ${b.name} (${b.industry || 'industri belum diisi'})`).join('\n') +
        '\n(Data detail lintas bisnis tidak dibagikan: izin owner untuk laporan lintas bisnis nonaktif.)',
    };
  }
  const blocks = businesses.map((b) => {
    const mgr = b.manager_employee_id ? q.get('SELECT name, enabled FROM employees WHERE id = ?', b.manager_employee_id) : null;
    const s = taskStats(b.id, m.start, m.end);
    const fin = financeSummary(b.id, m.from, m.to);
    const latest = q.get("SELECT title, content, created_at FROM business_reports WHERE business_id = ? ORDER BY id DESC LIMIT 1", b.id);
    const docs = q.get('SELECT COUNT(*) n FROM documents WHERE business_id = ?', b.id).n;
    return `- slug "${b.slug}": ${b.name}
  Industri: ${b.industry || 'belum diisi'} | Manager: ${mgr && mgr.enabled ? mgr.name : 'TIDAK ADA (Group CEO menangani langsung)'}
  Deskripsi: ${truncate(b.description || 'belum diisi', 200)}
  Tugas bulan ini: ${s.total} (selesai ${s.completed}, gagal ${s.failed}, aktif ${s.active}) | Dokumen knowledge base: ${docs}
  Keuangan bulan ini: ${summaryText(fin).replace(/\n/g, ' ')}
  Laporan terakhir: ${latest ? `${latest.title} — ${truncate(latest.content.replace(/\s+/g, ' '), 300)}` : 'belum ada'}`;
  });
  return { businesses, text: blocks.join('\n') || 'Tidak ada bisnis aktif.' };
}
