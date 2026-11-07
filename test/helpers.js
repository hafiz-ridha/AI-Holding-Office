// Shared test bootstrap: isolated temp data dir, fresh DB, app without background jobs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function setupEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-test-'));
  process.env.DATA_DIR = dir;
  process.env.APP_SECRET = 'test-secret-test-secret-test-secret-1234';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-password-123';
  process.env.DISABLE_BACKGROUND_JOBS = 'true';
  process.env.COOKIE_SECURE = 'false';
  const { config, loadAppSecret } = await import('../src/config.js');
  config.dataDir = dir;
  config.dbPath = path.join(dir, 'office.db');
  config.backupDir = path.join(dir, 'backups');
  config.adminPassword = process.env.ADMIN_PASSWORD;
  loadAppSecret({ warn() {} });
  const db = await import('../src/db/index.js');
  db.openDb(config.dbPath);
  const { migrate } = await import('../src/db/migrate.js');
  migrate({ info() {} });
  const { seed } = await import('../src/db/seed.js');
  await seed({ info() {}, warn() {} });
  return { dir, config };
}

export async function buildTestApp() {
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

export async function login(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'admin-password-123' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const cookie = res.headers['set-cookie'].split(';')[0];
  const { csrfToken } = res.json();
  const headers = { cookie, 'x-csrf-token': csrfToken };
  return {
    headers,
    get: (url) => app.inject({ method: 'GET', url, headers }),
    post: (url, payload) => app.inject({ method: 'POST', url, headers, payload }),
    put: (url, payload) => app.inject({ method: 'PUT', url, headers, payload }),
    del: (url) => app.inject({ method: 'DELETE', url, headers }),
  };
}
