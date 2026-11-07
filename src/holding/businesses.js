// Business management: CRUD, logo, manager & staff assignment, per-business stats.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, now, tx, json } from '../db/index.js';
import { slugify } from '../lib/text.js';
import { config } from '../config.js';

const COLOR = /^#[0-9a-fA-F]{6}$/;
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_LOGO_BYTES = 300 * 1024;

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

export const logoDir = () => path.join(config.dataDir, 'uploads', 'logos');

export function getBusiness(id) {
  return q.get('SELECT * FROM businesses WHERE id = ?', id);
}

export function findBusiness(ref) {
  const s = String(ref || '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return getBusiness(Number(s));
  return q.get('SELECT * FROM businesses WHERE slug = ?', s) || q.get('SELECT * FROM businesses WHERE slug LIKE ? ORDER BY id LIMIT 1', `${s}%`);
}

export function activeBusinesses() {
  return q.all("SELECT * FROM businesses WHERE status = 'active' ORDER BY id");
}

function stats(id) {
  const r = q.get(
    `SELECT COUNT(*) AS total,
       SUM(status = 'completed') AS completed,
       SUM(status IN ('pending','assigned','processing')) AS active,
       SUM(status = 'failed') AS failed
     FROM tasks WHERE business_id = ?`,
    id
  );
  return { total: r.total || 0, completed: r.completed || 0, active: r.active || 0, failed: r.failed || 0 };
}

export function toPublic(b, { withStats = true } = {}) {
  if (!b) return null;
  const mgr = b.manager_employee_id ? q.get('SELECT id, name, role, enabled FROM employees WHERE id = ?', b.manager_employee_id) : null;
  const latest = q.get('SELECT id, title, content, created_at FROM business_reports WHERE business_id = ? ORDER BY id DESC LIMIT 1', b.id);
  return {
    id: b.id,
    code: `B-${String(b.id).padStart(3, '0')}`,
    slug: b.slug,
    name: b.name,
    industry: b.industry,
    description: b.description,
    color: b.color,
    status: b.status,
    has_logo: Boolean(b.logo_file),
    logo_url: b.logo_file ? `/api/businesses/${b.id}/logo?v=${b.updated_at}` : null,
    manager: mgr ? { id: mgr.id, name: mgr.name, role: mgr.role, enabled: Boolean(mgr.enabled) } : null,
    manager_employee_id: b.manager_employee_id,
    extra_access: json(b.extra_access, []),
    employee_ids: q.all('SELECT employee_id FROM business_employees WHERE business_id = ? ORDER BY employee_id', b.id).map((r) => r.employee_id),
    stats: withStats ? stats(b.id) : undefined,
    latest_report: latest ? { id: latest.id, title: latest.title, excerpt: latest.content.slice(0, 280), created_at: latest.created_at } : null,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

export function listBusinesses({ status = null } = {}) {
  const rows = status ? q.all('SELECT * FROM businesses WHERE status = ? ORDER BY id', status) : q.all('SELECT * FROM businesses ORDER BY id');
  return rows.map((b) => toPublic(b));
}

function validateManager(id, businessId = null) {
  if (id === null || id === undefined || id === '') return null;
  const e = q.get('SELECT id, is_manager FROM employees WHERE id = ?', id);
  if (!e) throw httpError('Business Manager tidak ditemukan');
  if (e.is_manager) throw httpError('Group CEO tidak dapat menjadi Business Manager');
  const other = q.get('SELECT id, name FROM businesses WHERE manager_employee_id = ? AND id IS NOT ?', id, businessId);
  if (other) throw httpError(`Karyawan ini sudah menjadi manager bisnis "${other.name}"`);
  return e.id;
}

function validateAccess(list, selfId) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(Number))].filter((id) => id !== selfId && getBusiness(id));
}

export function createBusiness(data) {
  const t = now();
  let slug = slugify(data.slug || data.name);
  const base = slug;
  let n = 2;
  while (q.get('SELECT id FROM businesses WHERE slug = ?', slug)) slug = `${base}-${n++}`;
  const managerId = validateManager(data.manager_employee_id);
  const id = tx(() => {
    const r = q.run(
      `INSERT INTO businesses(slug, name, industry, description, color, status, manager_employee_id, extra_access, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      slug, data.name.trim(), (data.industry || '').trim(), data.description || '',
      COLOR.test(data.color || '') ? data.color : '#3b82f6', data.status === 'inactive' ? 'inactive' : 'active',
      managerId, '[]', t, t
    );
    const bid = r.lastInsertRowid;
    const staff = new Set((Array.isArray(data.employee_ids) ? data.employee_ids : []).map(Number));
    if (managerId) staff.add(managerId);
    for (const eid of staff) {
      if (q.get('SELECT id FROM employees WHERE id = ? AND is_manager = 0', eid)) {
        q.run('INSERT OR IGNORE INTO business_employees(business_id, employee_id, created_at) VALUES (?,?,?)', bid, eid, t);
      }
    }
    return bid;
  });
  return toPublic(getBusiness(id));
}

export function updateBusiness(id, data) {
  const b = getBusiness(id);
  if (!b) throw httpError('Bisnis tidak ditemukan', 404);
  const sets = [];
  const vals = [];
  const set = (k, v) => {
    sets.push(`${k} = ?`);
    vals.push(v);
  };
  if ('name' in data) set('name', data.name.trim());
  if ('slug' in data && data.slug) {
    const s = slugify(data.slug);
    if (q.get('SELECT id FROM businesses WHERE slug = ? AND id != ?', s, id)) throw httpError('Slug sudah dipakai bisnis lain');
    set('slug', s);
  }
  if ('industry' in data) set('industry', (data.industry || '').trim());
  if ('description' in data) set('description', data.description || '');
  if ('color' in data && COLOR.test(data.color || '')) set('color', data.color);
  if ('status' in data) set('status', data.status === 'inactive' ? 'inactive' : 'active');
  if ('manager_employee_id' in data) set('manager_employee_id', validateManager(data.manager_employee_id, id));
  if ('extra_access' in data) set('extra_access', JSON.stringify(validateAccess(data.extra_access, id)));
  tx(() => {
    if (sets.length) {
      set('updated_at', now());
      q.run(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    }
    if (Array.isArray(data.employee_ids)) {
      const staff = new Set(data.employee_ids.map(Number));
      const mgr = getBusiness(id).manager_employee_id;
      if (mgr) staff.add(mgr);
      q.run('DELETE FROM business_employees WHERE business_id = ?', id);
      for (const eid of staff) {
        if (q.get('SELECT id FROM employees WHERE id = ? AND is_manager = 0', eid)) {
          q.run('INSERT INTO business_employees(business_id, employee_id, created_at) VALUES (?,?,?)', id, eid, now());
        }
      }
    } else if ('manager_employee_id' in data && data.manager_employee_id) {
      q.run('INSERT OR IGNORE INTO business_employees(business_id, employee_id, created_at) VALUES (?,?,?)', id, data.manager_employee_id, now());
    }
  });
  return toPublic(getBusiness(id));
}

// Hard delete only when the business has no history; otherwise deactivate (keeps data, avoids orphaning).
export function deleteBusiness(id) {
  const b = getBusiness(id);
  if (!b) throw httpError('Bisnis tidak ditemukan', 404);
  const used =
    q.get('SELECT COUNT(*) n FROM tasks WHERE business_id = ?', id).n +
    q.get('SELECT COUNT(*) n FROM documents WHERE business_id = ?', id).n +
    q.get('SELECT COUNT(*) n FROM financial_records WHERE business_id = ?', id).n;
  if (used > 0) throw httpError('Bisnis memiliki riwayat tugas/dokumen/keuangan. Nonaktifkan saja agar data tetap tersimpan.');
  if (b.logo_file) fs.rmSync(path.join(logoDir(), b.logo_file), { force: true });
  q.run('DELETE FROM businesses WHERE id = ?', id);
  return true;
}

// Logo upload as a data URL (PNG/JPEG/WebP only; SVG is rejected to avoid script injection).
export function saveLogo(id, dataUrl) {
  const b = getBusiness(id);
  if (!b) throw httpError('Bisnis tidak ditemukan', 404);
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpError('Logo harus PNG, JPEG, atau WebP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_LOGO_BYTES) throw httpError('Ukuran logo maksimal 300 KB');
  const sig = buf.subarray(0, 12).toString('hex');
  const ok =
    (m[1] === 'image/png' && sig.startsWith('89504e47')) ||
    (m[1] === 'image/jpeg' && sig.startsWith('ffd8ff')) ||
    (m[1] === 'image/webp' && sig.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP');
  if (!ok) throw httpError('Isi file tidak sesuai format gambar');
  fs.mkdirSync(logoDir(), { recursive: true });
  const file = `${id}-${crypto.randomBytes(6).toString('hex')}.${LOGO_TYPES[m[1]]}`;
  fs.writeFileSync(path.join(logoDir(), file), buf);
  if (b.logo_file) fs.rmSync(path.join(logoDir(), b.logo_file), { force: true });
  q.run('UPDATE businesses SET logo_file = ?, updated_at = ? WHERE id = ?', file, now(), id);
  return toPublic(getBusiness(id));
}

export function logoFile(id) {
  const b = getBusiness(id);
  if (!b?.logo_file) return null;
  const file = path.join(logoDir(), b.logo_file);
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file).slice(1);
  return { file, type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
}

export function removeLogo(id) {
  const b = getBusiness(id);
  if (!b) throw httpError('Bisnis tidak ditemukan', 404);
  if (b.logo_file) fs.rmSync(path.join(logoDir(), b.logo_file), { force: true });
  q.run('UPDATE businesses SET logo_file = NULL, updated_at = ? WHERE id = ?', now(), id);
  return toPublic(getBusiness(id));
}

export function businessTeam(businessId) {
  return q.all(
    `SELECT e.* FROM employees e JOIN business_employees be ON be.employee_id = e.id
     WHERE be.business_id = ? AND e.enabled = 1 ORDER BY e.desk_index, e.id`,
    businessId
  );
}

export function sharedServices() {
  return q.all("SELECT * FROM employees WHERE org_unit = 'shared' AND enabled = 1 ORDER BY desk_index, id");
}
