// Provider CRUD, masking, connection tests, and model catalogue sync.
import { q, tx, now, json } from '../db/index.js';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto.js';
import { createAdapter, PRESETS, PROVIDER_TYPES } from './registry.js';
import { ProviderError } from './base.js';

const EDITABLE = [
  'name', 'base_url', 'enabled', 'priority', 'default_model', 'fallback_models',
  'timeout_ms', 'max_retries', 'rpm_limit', 'daily_request_limit',
];

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

function validateBaseUrl(url) {
  const ph = String(url || '').match(/\{([A-Z_]+)\}/);
  if (ph) throw httpError(`Ganti {${ph[1]}} pada Base URL dengan nilai Anda (mis. Account ID).`);
  let u;
  try {
    u = new URL(url);
  } catch {
    throw httpError('Base URL tidak valid');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw httpError('Base URL harus http:// atau https://');
  return url.replace(/\/+$/, '');
}

function cleanModelList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    const s = String(m || '').trim();
    if (s && s.length <= 200 && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 10);
}

// Public representation: never includes the key itself.
export function toPublic(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    typeLabel: PRESETS[p.preset]?.label || PROVIDER_TYPES[p.type]?.label || p.type,
    preset: p.preset,
    category: PRESETS[p.preset]?.category || 'custom',
    base_url: p.base_url,
    has_api_key: Boolean(p.api_key_enc),
    api_key_hint: p.api_key_hint || '',
    enabled: Boolean(p.enabled),
    is_default: Boolean(p.is_default),
    priority: p.priority,
    default_model: p.default_model,
    fallback_models: json(p.fallback_models, []),
    timeout_ms: p.timeout_ms,
    max_retries: p.max_retries,
    rpm_limit: p.rpm_limit,
    daily_request_limit: p.daily_request_limit,
    status: p.status,
    status_message: p.status_message,
    last_checked_at: p.last_checked_at,
    cooldown_until: p.cooldown_until && p.cooldown_until > now() ? p.cooldown_until : null,
    model_count: q.get('SELECT COUNT(*) n FROM models WHERE provider_id = ?', p.id).n,
    free_model_count: q.get('SELECT COUNT(*) n FROM models WHERE provider_id = ? AND is_free = 1', p.id).n,
  };
}

export function listProviders() {
  return q.all('SELECT * FROM providers ORDER BY is_default DESC, priority ASC, id ASC').map(toPublic);
}

export function getProviderRow(id) {
  return q.get('SELECT * FROM providers WHERE id = ?', id);
}

export function getDefaultProvider() {
  return q.get('SELECT * FROM providers WHERE is_default = 1 AND enabled = 1 LIMIT 1');
}

// Row with decrypted key, for adapters only (server side).
export function withSecret(row) {
  let apiKey = '';
  if (row.api_key_enc) {
    try {
      apiKey = decryptSecret(row.api_key_enc);
    } catch {
      throw new ProviderError('API key tidak dapat didekripsi (APP_SECRET berubah?). Simpan ulang API key.', { kind: 'auth' });
    }
  }
  return { ...row, apiKey };
}

export function adapterFor(row) {
  return createAdapter(withSecret(row));
}

export function createProvider(data) {
  const preset = PRESETS[data.preset] ? data.preset : 'custom';
  const p = PRESETS[preset];
  const type = data.type && PROVIDER_TYPES[data.type] ? data.type : p.type;
  const baseUrl = validateBaseUrl(data.base_url || p.base_url);
  const t = now();
  const key = data.api_key ? String(data.api_key).trim() : '';
  const hasDefault = q.get('SELECT COUNT(*) n FROM providers WHERE is_default = 1').n > 0;
  const r = q.run(
    `INSERT INTO providers(name, type, preset, base_url, api_key_enc, api_key_hint, enabled, is_default, priority,
      default_model, fallback_models, timeout_ms, max_retries, rpm_limit, daily_request_limit, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    String(data.name || p.label).slice(0, 80),
    type,
    preset,
    baseUrl,
    key ? encryptSecret(key) : null,
    key ? maskSecret(key) : null,
    data.enabled === false ? 0 : 1,
    hasDefault ? 0 : 1,
    Number.isInteger(data.priority) ? data.priority : 100,
    data.default_model ? String(data.default_model).trim() : null,
    JSON.stringify(cleanModelList(data.fallback_models)),
    Number.isInteger(data.timeout_ms) ? data.timeout_ms : 60000,
    Number.isInteger(data.max_retries) ? data.max_retries : 1,
    Number.isInteger(data.rpm_limit) ? data.rpm_limit : p.rpm_limit,
    Number.isInteger(data.daily_request_limit) ? data.daily_request_limit : p.daily_request_limit,
    t,
    t
  );
  return toPublic(getProviderRow(r.lastInsertRowid));
}

export function updateProvider(id, data) {
  const row = getProviderRow(id);
  if (!row) throw httpError('Provider tidak ditemukan', 404);
  const sets = [];
  const vals = [];
  for (const k of EDITABLE) {
    if (!(k in data)) continue;
    let v = data[k];
    if (k === 'base_url') v = validateBaseUrl(v);
    if (k === 'fallback_models') v = JSON.stringify(cleanModelList(v));
    if (k === 'enabled') v = v ? 1 : 0;
    if (k === 'default_model') v = v ? String(v).trim() : null;
    if (k === 'name') v = String(v).slice(0, 80);
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (data.clear_api_key) {
    sets.push('api_key_enc = NULL', 'api_key_hint = NULL');
  } else if (typeof data.api_key === 'string' && data.api_key.trim()) {
    const key = data.api_key.trim();
    sets.push('api_key_enc = ?', 'api_key_hint = ?');
    vals.push(encryptSecret(key), maskSecret(key));
  }
  // Any config change resets the health status so the admin re-tests.
  if (sets.length) {
    sets.push("status = CASE WHEN status IN ('auth_error','unsupported') THEN 'unknown' ELSE status END");
    sets.push('cooldown_until = NULL', 'updated_at = ?');
    vals.push(now(), id);
    q.run(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  }
  const updated = getProviderRow(id);
  if (!updated.enabled && updated.is_default) ensureSomeDefault();
  return toPublic(updated);
}

function ensureSomeDefault() {
  const def = q.get('SELECT id FROM providers WHERE is_default = 1 AND enabled = 1');
  if (def) return;
  const next = q.get('SELECT id FROM providers WHERE enabled = 1 ORDER BY priority, id LIMIT 1');
  tx(() => {
    q.run('UPDATE providers SET is_default = 0');
    if (next) q.run('UPDATE providers SET is_default = 1 WHERE id = ?', next.id);
  });
}

export function setDefaultProvider(id) {
  const row = getProviderRow(id);
  if (!row) throw httpError('Provider tidak ditemukan', 404);
  if (!row.enabled) throw httpError('Aktifkan provider sebelum menjadikannya default');
  tx(() => {
    q.run('UPDATE providers SET is_default = 0');
    q.run('UPDATE providers SET is_default = 1, updated_at = ? WHERE id = ?', now(), id);
  });
  return toPublic(getProviderRow(id));
}

export function deleteProvider(id) {
  const row = getProviderRow(id);
  if (!row) throw httpError('Provider tidak ditemukan', 404);
  q.run('DELETE FROM providers WHERE id = ?', id);
  if (row.is_default) ensureSomeDefault();
  return true;
}

export function setProviderStatus(id, status, message = null, extra = {}) {
  const sets = ['status = ?', 'status_message = ?', 'last_checked_at = ?'];
  const vals = [status, message ? String(message).slice(0, 500) : null, now()];
  if ('cooldown_until' in extra) {
    sets.push('cooldown_until = ?');
    vals.push(extra.cooldown_until);
  }
  q.run(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
}

function statusFromError(e) {
  if (!(e instanceof ProviderError)) return 'error';
  if (e.kind === 'auth') return 'auth_error';
  if (e.kind === 'unsupported') return 'unsupported';
  if (e.kind === 'rate_limit') return 'rate_limited';
  if (e.kind === 'quota') return 'quota';
  return 'error';
}

export async function testProvider(id) {
  const row = getProviderRow(id);
  if (!row) throw httpError('Provider tidak ditemukan', 404);
  try {
    const result = await adapterFor(row).testConnection();
    setProviderStatus(id, 'ok', result.message, { cooldown_until: null });
    return { ...result, provider: toPublic(getProviderRow(id)) };
  } catch (e) {
    const status = statusFromError(e);
    setProviderStatus(id, status, e.message);
    return { ok: false, status, message: e.message, provider: toPublic(getProviderRow(id)) };
  }
}

export async function syncModels(id) {
  const row = getProviderRow(id);
  if (!row) throw httpError('Provider tidak ditemukan', 404);
  let models;
  let source = 'api';
  let warning = null;
  try {
    ({ models, source, warning = null } = await adapterFor(row).listModelsWithSource());
  } catch (e) {
    setProviderStatus(id, statusFromError(e), e.message);
    throw httpError(`Gagal mengambil daftar model: ${e.message}`, 502);
  }
  const t = now();
  tx(() => {
    const ids = new Set();
    for (const m of models.slice(0, 2000)) {
      ids.add(m.id);
      q.run(
        `INSERT INTO models(provider_id, model_id, name, is_free, context_length, pricing_prompt, pricing_completion, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET name=excluded.name, is_free=excluded.is_free,
           context_length=excluded.context_length, pricing_prompt=excluded.pricing_prompt,
           pricing_completion=excluded.pricing_completion, updated_at=excluded.updated_at`,
        id, m.id, String(m.name).slice(0, 200), m.isFree ? 1 : 0, m.contextLength, m.pricingPrompt, m.pricingCompletion, t
      );
    }
    // Drop models the provider no longer lists.
    for (const old of q.all('SELECT model_id FROM models WHERE provider_id = ?', id)) {
      if (!ids.has(old.model_id)) q.run('DELETE FROM models WHERE provider_id = ? AND model_id = ?', id, old.model_id);
    }
  });
  if (row.status !== 'ok' && source === 'api') setProviderStatus(id, 'ok', `Daftar model diperbarui (${models.length}).`);
  return { total: models.length, free: models.filter((m) => m.isFree).length, source, warning };
}

export function listModels(providerId, { free = false, search = '', limit = 300 } = {}) {
  const where = ['provider_id = ?'];
  const vals = [providerId];
  if (free) where.push('is_free = 1');
  if (search) {
    where.push('(model_id LIKE ? OR name LIKE ?)');
    vals.push(`%${search}%`, `%${search}%`);
  }
  return q.all(
    `SELECT model_id AS id, name, is_free, context_length, pricing_prompt, pricing_completion
     FROM models WHERE ${where.join(' AND ')} ORDER BY is_free DESC, model_id LIMIT ?`,
    ...vals,
    limit
  ).map((m) => ({ ...m, is_free: Boolean(m.is_free) }));
}

export function modelPricing(providerId, modelId) {
  return q.get('SELECT pricing_prompt, pricing_completion, is_free FROM models WHERE provider_id = ? AND model_id = ?', providerId, modelId);
}
