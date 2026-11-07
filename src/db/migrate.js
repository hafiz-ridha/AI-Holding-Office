// Forward-only migration runner. Each file in migrations/ runs once inside a transaction.
// If the database already contains data and there are pending migrations, a backup is taken first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, openDb, closeDb, tx } from './index.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function pendingMigrations() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number(r.version)));
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .filter((f) => !applied.has(Number.parseInt(f, 10)));
}

/**
 * @param {object} log
 * @param {object} [opts]
 * @param {number} [opts.upTo]   apply only migrations with version <= upTo (used by upgrade tests)
 * @param {Function} [opts.backup] called before applying migrations to a non-empty DB
 */
export function migrate(log = console, { upTo = Infinity, backup = null } = {}) {
  const db = getDb();
  const pending = pendingMigrations().filter((f) => Number.parseInt(f, 10) <= upTo);
  if (!pending.length) return 0;
  const hasData = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n > 0;
  if (hasData && backup) {
    const b = backup();
    log.info?.(`backup sebelum migrasi: ${b.name}`);
  }
  for (const file of pending) {
    const version = Number.parseInt(file, 10);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    tx(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(version, file, Date.now());
    });
    log.info?.(`migration applied: ${file}`);
  }
  return pending.length;
}

// Allow `npm run migrate` as a standalone command.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { config, loadAppSecret } = await import('../config.js');
  loadAppSecret();
  openDb(config.dbPath);
  const { createBackup } = await import('../services/backup.js');
  const n = migrate(console, { backup: () => createBackup('pre-migrate') });
  console.log(`${n} migration(s) applied to ${config.dbPath}`);
  closeDb();
}
