// Global preHandler: authentication for /api/*, CSRF check for state-changing methods.
import { COOKIE_NAME, findSession, parseCookies } from './sessions.js';
import { safeEqual } from '../lib/crypto.js';

const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login', '/api/auth/me']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function attachSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  req.sessionToken = token || null;
  const s = findSession(token);
  if (s) {
    req.session = s;
    req.user = { id: s.user_id, username: s.username, role: s.role };
  }
}

export async function guard(req, reply) {
  const url = req.routeOptions?.url || req.url.split('?')[0];
  if (!url.startsWith('/api/')) return;
  attachSession(req);
  if (PUBLIC_ROUTES.has(url)) return;
  if (!req.user) {
    return reply.code(401).send({ error: 'Silakan login terlebih dahulu.' });
  }
  if (!SAFE_METHODS.has(req.method)) {
    const header = req.headers['x-csrf-token'];
    if (!header || !safeEqual(header, req.session.csrf_token)) {
      return reply.code(403).send({ error: 'Token CSRF tidak valid. Muat ulang halaman.' });
    }
  }
}
