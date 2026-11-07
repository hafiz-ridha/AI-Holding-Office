// Documents & knowledge base, scoped per business. Cross-business visibility only via explicit document_shares.
import { q, now, tx } from '../db/index.js';
import { truncate } from '../lib/text.js';

const MAX_CONTENT = 200 * 1024; // characters
const TEXT_MIME = /^(text\/(plain|markdown|csv)|application\/json)$/;

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

// Visibility rule used everywhere: a document belongs to its business; other businesses see it only if shared.
// businessId === null means holding-level documents (Group CEO context only).
const VISIBLE = `(d.business_id IS ? OR d.id IN (SELECT document_id FROM document_shares WHERE business_id = ?))`;

export function listDocuments(businessId, { kind = null, limit = 100 } = {}) {
  const vals = [businessId, businessId ?? -1];
  let extra = '';
  if (kind) {
    extra = ' AND d.kind = ?';
    vals.push(kind);
  }
  return q.all(
    `SELECT d.id, d.business_id, d.kind, d.title, d.filename, d.mime, d.size, d.created_by, d.created_at, d.updated_at,
       substr(d.content, 1, 240) AS excerpt, (d.business_id IS NOT ?) AS shared_in,
       (SELECT json_group_array(business_id) FROM document_shares s WHERE s.document_id = d.id) AS shared_with
     FROM documents d WHERE ${VISIBLE}${extra} ORDER BY d.updated_at DESC LIMIT ?`,
    businessId, ...vals, limit
  ).map((d) => ({ ...d, shared_in: Boolean(d.shared_in), shared_with: JSON.parse(d.shared_with || '[]') }));
}

export function getDocument(id, businessId) {
  return q.get(`SELECT d.* FROM documents d WHERE d.id = ? AND ${VISIBLE}`, id, businessId, businessId ?? -1);
}

export function createDocument(businessId, { title, content, kind = 'knowledge', filename = null, mime = null }, by = 'owner') {
  if (mime && !TEXT_MIME.test(mime)) throw httpError('Hanya dokumen teks (.txt, .md, .csv, .json) yang didukung');
  const text = String(content || '');
  if (!text.trim()) throw httpError('Isi dokumen kosong');
  if (text.length > MAX_CONTENT) throw httpError('Dokumen terlalu besar (maks 200 KB teks)');
  const t = now();
  const r = q.run(
    `INSERT INTO documents(business_id, kind, title, content, filename, mime, size, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    businessId, kind === 'document' ? 'document' : 'knowledge', truncate(title, 200), text, filename, mime,
    Buffer.byteLength(text), by, t, t
  );
  return q.get('SELECT * FROM documents WHERE id = ?', r.lastInsertRowid);
}

export function updateDocument(id, businessId, data) {
  const d = q.get('SELECT * FROM documents WHERE id = ? AND business_id IS ?', id, businessId);
  if (!d) throw httpError('Dokumen tidak ditemukan di bisnis ini', 404);
  const title = data.title !== undefined ? truncate(data.title, 200) : d.title;
  const content = data.content !== undefined ? String(data.content) : d.content;
  if (content.length > MAX_CONTENT) throw httpError('Dokumen terlalu besar');
  q.run('UPDATE documents SET title = ?, content = ?, size = ?, updated_at = ? WHERE id = ?', title, content, Buffer.byteLength(content), now(), id);
  return q.get('SELECT * FROM documents WHERE id = ?', id);
}

export function deleteDocument(id, businessId) {
  const r = q.run('DELETE FROM documents WHERE id = ? AND business_id IS ?', id, businessId);
  if (!r.changes) throw httpError('Dokumen tidak ditemukan di bisnis ini', 404);
  return true;
}

// Owner-granted sharing: only the owning business's document can be shared.
export function setDocumentShares(id, ownerBusinessId, targetIds) {
  const d = q.get('SELECT id FROM documents WHERE id = ? AND business_id IS ?', id, ownerBusinessId);
  if (!d) throw httpError('Dokumen tidak ditemukan di bisnis ini', 404);
  const clean = [...new Set((targetIds || []).map(Number))].filter(
    (b) => b !== ownerBusinessId && q.get('SELECT id FROM businesses WHERE id = ?', b)
  );
  tx(() => {
    q.run('DELETE FROM document_shares WHERE document_id = ?', id);
    for (const b of clean) q.run('INSERT INTO document_shares(document_id, business_id, created_at) VALUES (?,?,?)', id, b, now());
  });
  return clean;
}

function ftsQuery(text) {
  const words = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 24);
  return [...new Set(words)].map((w) => `"${w}"`).join(' OR ');
}

/**
 * Knowledge base search limited to one business (plus documents explicitly shared to it).
 * Returns [{id, title, snippet}] with at most maxChars total.
 */
export function searchKnowledge(businessId, text, { limit = 3, maxChars = 2400 } = {}) {
  const match = ftsQuery(text);
  let rows = [];
  if (match) {
    rows = q.all(
      `SELECT d.id, d.title, d.content FROM documents_fts f JOIN documents d ON d.id = f.rowid
       WHERE documents_fts MATCH ? AND ${VISIBLE} ORDER BY bm25(documents_fts) LIMIT ?`,
      match, businessId, businessId ?? -1, limit
    );
  }
  if (!rows.length) {
    // No keyword hit: fall back to the most recently updated knowledge documents of this business only.
    rows = q.all(
      `SELECT d.id, d.title, d.content FROM documents d WHERE ${VISIBLE} AND d.kind = 'knowledge' ORDER BY d.updated_at DESC LIMIT ?`,
      businessId, businessId ?? -1, Math.min(limit, 2)
    );
  }
  const per = Math.floor(maxChars / Math.max(1, rows.length));
  return rows.map((r) => ({ id: r.id, title: r.title, snippet: truncate(r.content, per) }));
}
