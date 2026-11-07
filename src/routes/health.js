import { q } from '../db/index.js';

const startedAt = Date.now();
const version = process.env.npm_package_version || '1.0.0';

export default async function healthRoutes(app) {
  // Public, minimal: used by the Docker HEALTHCHECK and the aaPanel reverse proxy.
  app.get('/api/health', async (req, reply) => {
    try {
      q.get('SELECT 1 AS ok');
      return { status: 'ok', version, uptimeSec: Math.round((Date.now() - startedAt) / 1000) };
    } catch {
      return reply.code(503).send({ status: 'error' });
    }
  });
}
