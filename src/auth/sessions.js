// Server-side sessions: random token in an HttpOnly cookie, only its SHA-256 hash is stored.
import { q, now } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { getSetting } from '../lib/settings.js';
import { config } from '../config.js';

export const COOKIE_NAME = 'avo_session';

export function createSession(userId, req) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const t = now();
  const ttl = getSetting('session_ttl_hours') * 3600 * 1000;
  q.run(
    `INSERT INTO sessions(id, user_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    sha256(token),
    userId,
    csrf,
    req.ip,
    String(req.headers['user-agent'] || '').slice(0, 200),
    t,
    t,
    t + ttl
  );
  return { token, csrf, expiresAt: t + ttl };
}

export function findSession(token) {
  if (!token) return null;
  const row = q.get(
    `SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.last_seen_at, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sha256(token)
  );
  if (!row) return null;
  const t = now();
  if (row.expires_at <= t) {
    q.run('DELETE FROM sessions WHERE id = ?', row.id);
    return null;
  }
  // Throttle last_seen writes to once a minute.
  if (t - row.last_seen_at > 60000) q.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', t, row.id);
  return row;
}

export function destroySession(token) {
  if (token) q.run('DELETE FROM sessions WHERE id = ?', sha256(token));
}

export function destroyUserSessions(userId, exceptId = null) {
  if (exceptId) q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptId);
  else q.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function purgeExpiredSessions() {
  return q.run('DELETE FROM sessions WHERE expires_at <= ?', now()).changes;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function isSecure(req) {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return req.protocol === 'https';
}

export function sessionCookie(req, token, expiresAt) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (expiresAt) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  else parts.push('Max-Age=0');
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}
