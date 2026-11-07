// Fastify application: security headers, rate limiting, auth guard, API routes, static frontend.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { guard } from './auth/guard.js';
import { RateLimiter } from './lib/ratelimit.js';
import { registerRoutes } from './routes/index.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp({ logger } = {}) {
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy === 'true' ? true : config.trustProxy === 'false' ? false : config.trustProxy,
    bodyLimit: 256 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  const apiLimiter = new RateLimiter({ windowMs: 60_000, max: config.apiRateLimitPerMin });
  app.addHook('onClose', async () => apiLimiter.stop());

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (req.url !== '/api/health') {
        const r = apiLimiter.hit(req.ip);
        if (!r.allowed) {
          reply.header('Retry-After', Math.ceil(r.retryAfterMs / 1000));
          return reply.code(429).send({ error: 'Terlalu banyak request. Coba lagi sebentar.' });
        }
      }
    }
  });

  // Auth + CSRF run before body parsing, so anonymous requests never reach validation or handlers.
  app.addHook('onRequest', guard);

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err, url: req.url }, 'request error');
    let message = err.message;
    if (err.validation) message = `Input tidak valid: ${err.message}`;
    if (status >= 500) message = 'Terjadi kesalahan server. Lihat log aplikasi.';
    reply.code(status).send({ error: message });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Endpoint tidak ditemukan' });
    // SPA: unknown non-API paths serve the app shell.
    return reply.type('text/html').sendFile('index.html');
  });

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    index: ['index.html'],
    maxAge: config.env === 'production' ? '1h' : 0,
    // @fastify/static v10 passes the Fastify reply (not the raw response).
    setHeaders(reply, filePath) {
      if (filePath.endsWith('.html')) reply.header('Cache-Control', 'no-cache');
    },
  });

  await registerRoutes(app);
  return app;
}
