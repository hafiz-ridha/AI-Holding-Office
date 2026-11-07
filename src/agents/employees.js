// AI employee profiles (all share one AI execution engine: the Model Router) and their work memory.
import { q, now, json, tx } from '../db/index.js';
import { slugify, truncate } from '../lib/text.js';
import { SAFETY_RULES } from '../db/seed.js';

export const ROLE_KEYS = [
  'ceo', 'business_manager', 'marketing', 'operations', 'finance',
  'group_finance', 'secretary', 'researcher', 'developer', 'hr', 'custom',
];
export const ORG_UNITS = ['holding', 'business', 'shared'];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const HAIR_STYLES = ['short', 'long', 'messy', 'cap', 'bun', 'bald'];

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

export function businessIdsOf(employeeId) {
  return q.all('SELECT business_id FROM business_employees WHERE employee_id = ? ORDER BY business_id', employeeId).map((r) => r.business_id);
}

// Model tier used for tier-level default models.
export function tierOf(e) {
  if (!e) return 'shared_services';
  if (e.is_manager || e.role_key === 'ceo') return 'group_ceo';
  if (e.role_key === 'business_manager') return 'business_manager';
  if (e.org_unit === 'business') return 'business_staff';
  return 'shared_services';
}

export function toPublic(e) {
  if (!e) return null;
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    role: e.role,
    role_key: e.role_key,
    org_unit: e.org_unit,
    tier: tierOf(e),
    is_manager: Boolean(e.is_manager),
    avatar: json(e.avatar, {}),
    personality: e.personality,
    system_prompt: e.system_prompt,
    provider_id: e.provider_id,
    model: e.model,
    temperature: e.temperature,
    max_tokens: e.max_tokens,
    enabled: Boolean(e.enabled),
    desk_index: e.desk_index,
    status: e.status,
    business_ids: businessIdsOf(e.id),
    manages_business_ids: q.all('SELECT id FROM businesses WHERE manager_employee_id = ?', e.id).map((r) => r.id),
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

export function listEmployees({ includeDisabled = true, orgUnit = null, businessId = null } = {}) {
  const where = [];
  const vals = [];
  if (!includeDisabled) where.push('e.enabled = 1');
  if (orgUnit) {
    where.push('e.org_unit = ?');
    vals.push(orgUnit);
  }
  if (businessId) {
    where.push('e.id IN (SELECT employee_id FROM business_employees WHERE business_id = ?)');
    vals.push(businessId);
  }
  const rows = q.all(`SELECT e.* FROM employees e ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.desk_index, e.id`, ...vals);
  return rows.map(toPublic);
}

export function getEmployee(id) {
  return q.get('SELECT * FROM employees WHERE id = ?', id);
}

export function getManager() {
  return q.get('SELECT * FROM employees WHERE is_manager = 1 AND enabled = 1 ORDER BY id LIMIT 1');
}

function cleanAvatar(a) {
  const src = a && typeof a === 'object' ? a : {};
  const out = {};
  for (const k of ['skin', 'hair', 'shirt', 'pants', 'accent']) if (COLOR.test(src[k] || '')) out[k] = src[k];
  if (HAIR_STYLES.includes(src.hairStyle)) out.hairStyle = src.hairStyle;
  out.glasses = Boolean(src.glasses);
  return out;
}

function validateProvider(providerId) {
  if (providerId === null || providerId === undefined || providerId === '') return null;
  const p = q.get('SELECT id FROM providers WHERE id = ?', providerId);
  if (!p) throw httpError('Provider tidak ditemukan');
  return p.id;
}

function validateBusinessIds(ids) {
  if (!Array.isArray(ids)) return null;
  const clean = [...new Set(ids.map(Number).filter(Number.isInteger))];
  for (const id of clean) if (!q.get('SELECT id FROM businesses WHERE id = ?', id)) throw httpError(`Bisnis #${id} tidak ditemukan`);
  return clean;
}

export function setEmployeeBusinesses(employeeId, ids) {
  const clean = validateBusinessIds(ids) || [];
  tx(() => {
    q.run('DELETE FROM business_employees WHERE employee_id = ?', employeeId);
    for (const b of clean) q.run('INSERT INTO business_employees(business_id, employee_id, created_at) VALUES (?,?,?)', b, employeeId, now());
  });
}

function nextDeskIndex() {
  return q.get('SELECT COALESCE(MAX(desk_index), -1) + 1 AS n FROM employees').n;
}

export function createEmployee(data) {
  const t = now();
  let slug = slugify(data.slug || data.name);
  let n = 2;
  const base = slug;
  while (q.get('SELECT id FROM employees WHERE slug = ?', slug)) slug = `${base}-${n++}`;
  const roleKey = ROLE_KEYS.includes(data.role_key) ? data.role_key : 'custom';
  if (roleKey === 'ceo') throw httpError('Group CEO hanya satu; ubah karyawan yang ada bila perlu.');
  const orgUnit = ORG_UNITS.includes(data.org_unit) && data.org_unit !== 'holding' ? data.org_unit : roleKey === 'business_manager' ? 'business' : 'shared';
  const businessIds = validateBusinessIds(data.business_ids) || [];
  const prompt = data.system_prompt?.trim() || `Kamu adalah ${data.name}, ${data.role}.\n${SAFETY_RULES}`;
  const id = tx(() => {
    const r = q.run(
      `INSERT INTO employees(slug, name, role, role_key, is_manager, org_unit, avatar, personality, system_prompt, provider_id, model,
        temperature, max_tokens, enabled, desk_index, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      slug, data.name.trim(), data.role.trim(), roleKey, 0, orgUnit, JSON.stringify(cleanAvatar(data.avatar)),
      data.personality || '', prompt, validateProvider(data.provider_id), data.model?.trim() || null,
      data.temperature ?? 0.7, data.max_tokens ?? 0, data.enabled === false ? 0 : 1, nextDeskIndex(), t, t
    );
    for (const b of businessIds) q.run('INSERT INTO business_employees(business_id, employee_id, created_at) VALUES (?,?,?)', b, r.lastInsertRowid, t);
    return r.lastInsertRowid;
  });
  return toPublic(getEmployee(id));
}

export function updateEmployee(id, data) {
  const e = getEmployee(id);
  if (!e) throw httpError('Karyawan tidak ditemukan', 404);
  const sets = [];
  const vals = [];
  const set = (k, v) => {
    sets.push(`${k} = ?`);
    vals.push(v);
  };
  if ('name' in data) set('name', data.name.trim());
  if ('role' in data) set('role', data.role.trim());
  if ('role_key' in data && !e.is_manager) {
    if (data.role_key === 'ceo') throw httpError('Group CEO hanya satu.');
    set('role_key', ROLE_KEYS.includes(data.role_key) ? data.role_key : 'custom');
  }
  if ('org_unit' in data && !e.is_manager && ORG_UNITS.includes(data.org_unit) && data.org_unit !== 'holding') set('org_unit', data.org_unit);
  if ('personality' in data) set('personality', data.personality);
  if ('system_prompt' in data) set('system_prompt', data.system_prompt);
  if ('avatar' in data) set('avatar', JSON.stringify(cleanAvatar(data.avatar)));
  if ('provider_id' in data) set('provider_id', validateProvider(data.provider_id));
  if ('model' in data) set('model', data.model?.trim() || null);
  if ('temperature' in data) set('temperature', data.temperature);
  if ('max_tokens' in data) set('max_tokens', data.max_tokens);
  if ('enabled' in data) {
    if (!data.enabled && e.is_manager && countOtherManagers(id) === 0) {
      throw httpError('Tidak dapat menonaktifkan Group CEO satu-satunya.');
    }
    set('enabled', data.enabled ? 1 : 0);
  }
  tx(() => {
    if (sets.length) {
      set('updated_at', now());
      q.run(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    }
    if ('business_ids' in data) setEmployeeBusinesses(id, data.business_ids);
  });
  return toPublic(getEmployee(id));
}

function countOtherManagers(id) {
  return q.get('SELECT COUNT(*) n FROM employees WHERE is_manager = 1 AND enabled = 1 AND id != ?', id).n;
}

export function deleteEmployee(id) {
  const e = getEmployee(id);
  if (!e) throw httpError('Karyawan tidak ditemukan', 404);
  if (e.is_manager && countOtherManagers(id) === 0) {
    throw httpError('Tidak dapat menghapus Group CEO satu-satunya.');
  }
  const active = q.get("SELECT COUNT(*) n FROM tasks WHERE employee_id = ? AND status IN ('pending','assigned','processing')", id).n;
  if (active > 0) throw httpError(`Karyawan masih memiliki ${active} tugas aktif. Batalkan atau selesaikan dulu.`);
  q.run('DELETE FROM employees WHERE id = ?', id); // businesses.manager_employee_id -> NULL via FK
  return true;
}

export function setEmployeeStatus(id, status) {
  if (id) q.run('UPDATE employees SET status = ? WHERE id = ?', status, id);
}

// ---- work memory (always scoped to the business of the task) ----
export function addMemory(employeeId, taskId, content, importance = 1, businessId = null) {
  q.run(
    'INSERT INTO memories(employee_id, task_id, business_id, content, importance, created_at) VALUES (?,?,?,?,?,?)',
    employeeId, taskId, businessId, truncate(content, 600), importance, now()
  );
  q.run(
    `DELETE FROM memories WHERE employee_id = ? AND id NOT IN
      (SELECT id FROM memories WHERE employee_id = ? ORDER BY id DESC LIMIT 300)`,
    employeeId, employeeId
  );
}

// Only memories from the same business context (NULL-safe compare): no cross-business recall.
export function recentMemories(employeeId, limit, businessId = null) {
  if (!limit) return [];
  return q
    .all('SELECT content, created_at FROM memories WHERE employee_id = ? AND business_id IS ? ORDER BY id DESC LIMIT ?', employeeId, businessId, limit)
    .reverse();
}

export function listMemories(employeeId, limit = 50) {
  return q.all(
    `SELECT m.id, m.task_id, m.business_id, b.name AS business_name, m.content, m.importance, m.created_at
     FROM memories m LEFT JOIN businesses b ON b.id = m.business_id WHERE m.employee_id = ? ORDER BY m.id DESC LIMIT ?`,
    employeeId, limit
  );
}

export function clearMemories(employeeId) {
  return q.run('DELETE FROM memories WHERE employee_id = ?', employeeId).changes;
}

export function deleteMemory(employeeId, memoryId) {
  return q.run('DELETE FROM memories WHERE employee_id = ? AND id = ?', employeeId, memoryId).changes;
}

export function resetEmployeeStatuses() {
  q.run("UPDATE employees SET status = 'idle'");
}
