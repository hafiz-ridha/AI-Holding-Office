// Owner approvals. Extracted from AI results that flag risky actions. Deciding only records the owner's decision:
// the application never executes the action itself.
import { q, now, tx } from '../db/index.js';
import { truncate } from '../lib/text.js';
import { bus } from '../events.js';
import { getSetting } from '../lib/settings.js';
import { logTask } from '../queue/tasks.js';

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
    detail = detail.replace(/["',\]}]+$/, '').trim(); // the line may come from JSON ("...": "PERLU ...",)
    if (detail && detail.length > 3 && !items.includes(detail)) items.push(truncate(detail, 400));
  }
  return items.slice(0, 5);
}

// What really needs the owner: actions that move money, bind the company, affect people, change prices, speak
// publicly for the company, have legal/tax effects, or delete/share sensitive data. Everything else (information,
// analysis, drafts, reminders) does not. Requests for the owner to type data in are never approvals: the AI gets
// data from the system and the web research instead.
const IMPORTANT = [
  ['Keuangan', /\b(rp\.?\s?\d|idr\s?\d|usd\s?\d|\$\s?\d|transfer|bayar|pembayaran|membayar|anggaran|budget|dana\b|pembelian|membeli|beli\b|investasi|invest\b|pinjaman|kredit|cicilan|refund|pengeluaran|deposit|biaya iklan|sewa)/i],
  ['Kontrak & hukum', /\b(kontrak|perjanjian|tanda ?tangan|menandatangani|mou\b|legal|hukum|gugatan|perizinan|izin usaha|lisensi|pajak|regulasi|notaris|somasi)/i],
  ['SDM', /\b(rekrut|merekrut|hire|hiring|pecat|phk|memberhentikan|pemutusan|gaji|upah|bonus|karyawan baru|pegawai baru|lowongan)/i],
  ['Harga', /\b(ubah harga|perubahan harga|kenaikan harga|menaikkan harga|menurunkan harga|harga baru|harga jual|diskon|potongan harga|promo besar)/i],
  ['Publikasi', /\b(publikasi|mempublikasikan|publish|siaran pers|press release|posting|unggah ke|kirim email|email blast|broadcast|pengumuman|iklan berbayar|kampanye berbayar|pernyataan resmi)/i],
  ['Data & akses', /\b(hapus data|menghapus data|bagikan data|membagikan data|data pelanggan|data rahasia|akses akun|kata sandi|password|api key|hak akses)/i],
  ['Operasional besar', /\b(tutup cabang|menutup cabang|buka cabang|membuka cabang|ekspansi|akuisisi|merger|jual aset|menjual aset|ganti vendor|ganti supplier|pemasok baru|supplier baru)/i],
];
const DATA_REQUEST = /\b(tambah(kan)? data|menambah(kan)? data|isi data|mengisi data|isikan|input data|menginput|lengkapi data|melengkapi data|unggah data|upload data|sediakan data|menyediakan data|berikan data|memberikan data|kirimkan data|data .{0,40}(belum|tidak) (tersedia|ada)|data not available|perlu data)/i;

/** { important, category } for one flagged item. */
export function classifyApproval(detail) {
  const text = String(detail || '');
  if (DATA_REQUEST.test(text)) return { important: false, category: 'Permintaan data' };
  for (const [category, re] of IMPORTANT) if (re.test(text)) return { important: true, category };
  return { important: false, category: 'Informasi' };
}

export function createApprovalsFromResult(task, text) {
  const onlyImportant = getSetting('approval_important_only');
  const items = [];
  for (const detail of extractApprovalItems(text)) {
    const c = classifyApproval(detail);
    if (onlyImportant && !c.important) {
      // Not an approval: kept on the task as a note so nothing is lost.
      logTask(task.id, 'approval_skipped', `${c.category} (tidak perlu persetujuan owner): ${detail}`);
      continue;
    }
    items.push(detail);
  }
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
  ).map((a) => ({ ...a, ...classifyApproval(a.detail) }));
}

function checkDecision(decision) {
  if (!['approved', 'rejected'].includes(decision)) {
    const e = new Error('Keputusan harus approved atau rejected');
    e.statusCode = 400;
    throw e;
  }
}

export function decideApproval(id, decision, by, note = '') {
  checkDecision(decision);
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

/**
 * Bulk decision: one decision and note for many approvals, in one transaction. Only items that are still pending
 * are decided; the rest are reported back as skipped (already decided elsewhere, or deleted), so a stale selection
 * never overwrites an earlier decision. Like the single decision, nothing is executed.
 */
export function decideApprovals(ids, decision, by, note = '') {
  checkDecision(decision);
  const unique = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  const decided = [];
  const skipped = [];
  tx(() => {
    const t = now();
    for (const id of unique) {
      const r = q.run(
        "UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
        decision, by, truncate(note || '', 500), t, id
      );
      if (r.changes) {
        decided.push(q.get('SELECT * FROM approvals WHERE id = ?', id));
      } else {
        const row = q.get('SELECT status FROM approvals WHERE id = ?', id);
        skipped.push({ id, reason: row ? `sudah ${row.status === 'approved' ? 'disetujui' : 'ditolak'}` : 'tidak ditemukan' });
      }
    }
  });
  return { decided, skipped };
}

export function pendingApprovalCount() {
  return q.get("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").n;
}
