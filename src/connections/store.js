// Connections to outside services (Google Drive now; GitHub, Vercel, Netlify, Supabase later): one row per provider.
// Secrets (client secret, refresh token, API tokens) are stored encrypted with APP_SECRET and never leave the server;
// the dashboard only sees status, account and a hint.
import { q, now, json } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { bus } from '../events.js';

export const PROVIDERS = {
  google_drive: 'Google Drive',
  github: 'GitHub',
  vercel: 'Vercel',
  netlify: 'Netlify',
  supabase: 'Supabase',
};

export class ConnectionError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getConnection(provider) {
  return q.get('SELECT * FROM connections WHERE provider = ?', provider) || null;
}

export const connectionConfig = (provider) => json(getConnection(provider)?.config, {}) || {};
export const isConnected = (provider) => getConnection(provider)?.status === 'connected';

/** Decrypted secrets of a connection (server side only). {} when there are none or they cannot be decrypted. */
export function connectionSecret(provider) {
  const row = getConnection(provider);
  if (!row?.secret_enc) return {};
  try {
    return JSON.parse(decryptSecret(row.secret_enc)) || {};
  } catch {
    return {};
  }
}

/**
 * Upsert a connection. Only the given fields change. `secret` replaces all secrets (object, or null to clear);
 * `config` replaces the config object (use patchConfig for one value).
 */
export function saveConnection(provider, { status, account, config, secret, hint, error } = {}) {
  const cur = getConnection(provider);
  const t = now();
  const next = {
    status: status ?? cur?.status ?? 'disconnected',
    account: account !== undefined ? account : cur?.account ?? null,
    config: config !== undefined ? JSON.stringify(config || {}) : cur?.config ?? '{}',
    secret_enc: secret !== undefined ? (secret ? encryptSecret(JSON.stringify(secret)) : null) : cur?.secret_enc ?? null,
    secret_hint: hint !== undefined ? hint : cur?.secret_hint ?? null,
    error: error !== undefined ? (error ? String(error).slice(0, 500) : null) : cur?.error ?? null,
  };
  const connectedAt = next.status === 'connected' ? (cur?.status === 'connected' && cur.connected_at ? cur.connected_at : t) : null;
  q.run(
    `INSERT INTO connections(provider, status, account, config, secret_enc, secret_hint, error, connected_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider) DO UPDATE SET status = excluded.status, account = excluded.account, config = excluded.config,
       secret_enc = excluded.secret_enc, secret_hint = excluded.secret_hint, error = excluded.error,
       connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
    provider, next.status, next.account, next.config, next.secret_enc, next.secret_hint, next.error, connectedAt, t
  );
  if (cur?.status !== next.status) bus.emit('connection:changed', { provider, status: next.status });
  return getConnection(provider);
}

export function patchConfig(provider, patch) {
  return saveConnection(provider, { config: { ...connectionConfig(provider), ...patch } });
}

export function patchSecret(provider, patch) {
  return saveConnection(provider, { secret: { ...connectionSecret(provider), ...patch } });
}
