import { q, now } from '../db/index.js';
import { hashPassword, verifyPassword, sha256 } from '../lib/crypto.js';
import { createSession, destroySession, destroyUserSessions, sessionCookie } from '../auth/sessions.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { audit, auditReq } from '../lib/audit.js';

const LOCK_MINUTES = 15;
const MAX_FAILED = 5;
// Dummy hash so unknown usernames take the same time as wrong passwords.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

export default async function authRoutes(app) {
  const loginLimiter = new RateLimiter({ windowMs: LOCK_MINUTES * 60_000, max: MAX_FAILED });
  app.addHook('onClose', async () => loginLimiter.stop());

  app.post(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body;
      const ipKey = `ip:${req.ip}`;
      const blocked = loginLimiter.peek(ipKey);
      if (blocked.blocked) {
        reply.header('Retry-After', Math.ceil(blocked.retryAfterMs / 1000));
        return reply.code(429).send({ error: `Terlalu banyak percobaan login. Coba lagi dalam ${LOCK_MINUTES} menit.` });
      }
      const user = q.get('SELECT * FROM users WHERE username = ?', username);
      const t = now();
      if (user && user.locked_until && user.locked_until > t) {
        await verifyPassword(password, DUMMY_HASH);
        return reply.code(429).send({ error: 'Akun dikunci sementara karena terlalu banyak percobaan gagal.' });
      }
      const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) {
        loginLimiter.hit(ipKey);
        if (user) {
          const failed = user.failed_attempts + 1;
          const lock = failed >= MAX_FAILED ? t + LOCK_MINUTES * 60_000 : null;
          q.run('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?', lock ? 0 : failed, lock, t, user.id);
        }
        audit({ actor: username.slice(0, 64), action: 'login_failed', ip: req.ip });
        return reply.code(401).send({ error: 'Username atau password salah.' });
      }
      q.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', t, t, user.id);
      loginLimiter.reset(ipKey);
      const s = createSession(user.id, req);
      reply.header('Set-Cookie', sessionCookie(req, s.token, s.expiresAt));
      audit({ userId: user.id, actor: user.username, action: 'login', ip: req.ip });
      return { user: { id: user.id, username: user.username, role: user.role }, csrfToken: s.csrf };
    }
  );

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Belum login' });
    return { user: req.user, csrfToken: req.session.csrf_token };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auditReq(req, 'logout');
    destroySession(req.sessionToken);
    reply.header('Set-Cookie', sessionCookie(req, '', null));
    return { ok: true };
  });

  app.post(
    '/api/auth/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['current', 'next'],
          additionalProperties: false,
          properties: {
            current: { type: 'string', minLength: 1, maxLength: 256 },
            next: { type: 'string', minLength: 10, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = q.get('SELECT * FROM users WHERE id = ?', req.user.id);
      if (!(await verifyPassword(req.body.current, user.password_hash))) {
        return reply.code(400).send({ error: 'Password saat ini salah.' });
      }
      q.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(req.body.next), now(), user.id);
      // Log out every other session after a password change.
      destroyUserSessions(user.id, sha256(req.sessionToken));
      auditReq(req, 'password_changed');
      return { ok: true };
    }
  );
}
