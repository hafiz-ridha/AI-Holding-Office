// Upgrade path: a v1 database (single company, migration 001 only, with data) is migrated to the holding schema.
// Verifies the automatic pre-migration backup, that no v1 data is lost, and backup/restore integrity.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dir, db, q, config, migrate, seed, backup;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-upgrade-'));
  process.env.DATA_DIR = dir;
  process.env.APP_SECRET = 'test-secret-test-secret-test-secret-1234';
  process.env.ADMIN_PASSWORD = 'admin-password-123';
  ({ config } = await import('../src/config.js'));
  config.dataDir = dir;
  config.dbPath = path.join(dir, 'office.db');
  config.backupDir = path.join(dir, 'backups');
  (await import('../src/config.js')).loadAppSecret({ warn() {} });
  db = await import('../src/db/index.js');
  ({ q } = db);
  ({ migrate } = await import('../src/db/migrate.js'));
  ({ seed } = await import('../src/db/seed.js'));
  backup = await import('../src/services/backup.js');
  db.openDb(config.dbPath);
});

test('v1 database with data upgrades to holding without data loss', async () => {
  // ---- build a v1 database (schema 001 + v1-style rows) ----
  assert.equal(migrate({ info() {} }, { upTo: 1 }), 1);
  const t = Date.now();
  const emp = (slug, name, role, roleKey, mgr = 0) =>
    q.run(`INSERT INTO employees(slug, name, role, role_key, is_manager, avatar, personality, system_prompt, desk_index, created_at, updated_at)
           VALUES (?,?,?,?,?,'{}','', 'prompt v1 kustom', 0, ?, ?)`, slug, name, role, roleKey, mgr, t, t).lastInsertRowid;
  const ceo = emp('ceo', 'Arya', 'CEO / AI Manager', 'ceo', 1);
  emp('secretary', 'Sari', 'Secretary / Admin', 'secretary');
  emp('researcher', 'Rendra', 'Researcher', 'researcher');
  emp('developer', 'Dimas', 'Developer', 'developer');
  const maya = emp('marketing', 'Maya', 'Marketing', 'marketing');
  q.run(`INSERT INTO system_settings(key, value, updated_at) VALUES ('_employees_seeded','true',?), ('max_concurrency','2',?)`, t, t);
  q.run(`INSERT INTO users(username, password_hash, role, created_at, updated_at) VALUES ('owner','scrypt$x','admin',?,?)`, t, t);
  q.run(`INSERT INTO providers(name, type, preset, base_url, enabled, is_default, default_model, created_at, updated_at)
         VALUES ('OpenRouter','openrouter','openrouter','https://openrouter.ai/api/v1',1,1,'meta-llama/llama-3.3-70b-instruct:free',?,?)`, t, t);
  const root = q.run(`INSERT INTO tasks(kind, phase, title, created_by, employee_id, status, result, created_at, updated_at)
                      VALUES ('instruction','done','Rencana Q4','owner',?,'completed','hasil v1',?,?)`, ceo, t, t).lastInsertRowid;
  q.run(`INSERT INTO tasks(parent_id, kind, title, created_by, employee_id, status, result, created_at, updated_at)
         VALUES (?, 'subtask','Caption','employee:ceo',?,'completed','caption v1',?,?)`, root, maya, t, t);
  q.run(`INSERT INTO memories(employee_id, task_id, content, created_at) VALUES (?,?,?,?)`, maya, root, 'memori v1 Maya', t);
  q.run(`INSERT INTO telegram_settings(id, chat_id, report_enabled, updated_at) VALUES (1, '12345', 1, ?)`, t);
  const v1Counts = {
    employees: q.get('SELECT COUNT(*) n FROM employees').n,
    tasks: q.get('SELECT COUNT(*) n FROM tasks').n,
    memories: q.get('SELECT COUNT(*) n FROM memories').n,
  };

  // ---- upgrade exactly as the server does on boot ----
  const applied = migrate({ info() {} }, { backup: () => backup.createBackup('pre-migrate') });
  assert.equal(applied, 4, 'migrations 002 to 005 are pending');
  await seed({ info() {}, warn() {} });

  // Pre-migration backup exists and still has the v1 schema.
  const pre = backup.listBackups().find((b) => b.name.startsWith('pre-migrate-'));
  assert.ok(pre, 'pre-migrate backup created');
  const old = new DatabaseSync(path.join(config.backupDir, pre.name), { readOnly: true });
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'businesses'").get().n, 0);
  assert.equal(old.prepare('SELECT COUNT(*) n FROM tasks').get().n, v1Counts.tasks);
  old.close();

  // v1 data intact.
  assert.equal(q.get('SELECT COUNT(*) n FROM tasks').n, v1Counts.tasks);
  assert.equal(q.get('SELECT COUNT(*) n FROM memories').n, v1Counts.memories);
  assert.equal(q.get("SELECT result FROM tasks WHERE title = 'Rencana Q4'").result, 'hasil v1');
  assert.equal(q.get("SELECT level FROM tasks WHERE title = 'Rencana Q4'").level, 'holding');
  assert.equal(q.get("SELECT level, business_id FROM tasks WHERE title = 'Caption'").level, 'employee');
  assert.equal(q.get("SELECT business_id FROM tasks WHERE title = 'Caption'").business_id, null);
  assert.equal(q.get("SELECT value FROM system_settings WHERE key = 'max_concurrency'").value, '2');
  assert.equal(q.get('SELECT COUNT(*) n FROM users').n, 1, 'no extra admin created');
  assert.equal(q.get("SELECT chat_id FROM telegram_settings").chat_id, '12345');
  assert.equal(q.get('SELECT default_model FROM providers').default_model, 'meta-llama/llama-3.3-70b-instruct:free');

  // v1 employees kept (custom prompts untouched); CEO becomes Group CEO.
  const ceoRow = q.get('SELECT * FROM employees WHERE id = ?', ceo);
  assert.equal(ceoRow.role, 'Group CEO');
  assert.equal(ceoRow.org_unit, 'holding');
  assert.equal(ceoRow.system_prompt, 'prompt v1 kustom');
  const mayaRow = q.get('SELECT * FROM employees WHERE id = ?', maya);
  assert.equal(mayaRow.org_unit, 'shared');
  assert.ok(q.get("SELECT id FROM employees WHERE role_key = 'group_finance'"), 'Group Finance added');
  assert.ok(q.get("SELECT id FROM employees WHERE role_key = 'hr'"), 'HR added');
  assert.equal(q.get("SELECT COUNT(*) n FROM employees WHERE role_key = 'secretary'").n, 1, 'no duplicate shared roles');
  assert.equal(q.get('SELECT COUNT(*) n FROM businesses').n, 3, 'sample businesses seeded once');

  // Seeding again (container restart) changes nothing.
  const n = q.get('SELECT COUNT(*) n FROM employees').n;
  await seed({ info() {}, warn() {} });
  assert.equal(q.get('SELECT COUNT(*) n FROM employees').n, n);
  assert.ok(n > v1Counts.employees);
});

test('backup + restore produce an identical, intact database', () => {
  const b = backup.createBackup('manual');
  assert.match(b.name, /^manual-\d{8}-\d{6}\.db$/);
  // Restore = copy the backup file into place (what the README describes), then open it.
  const restored = path.join(dir, 'restored.db');
  fs.copyFileSync(b.path, restored);
  const r = new DatabaseSync(restored, { readOnly: true });
  assert.equal(r.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  for (const tbl of ['employees', 'tasks', 'businesses', 'memories', 'providers', 'users']) {
    assert.equal(r.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n, q.get(`SELECT COUNT(*) n FROM ${tbl}`).n, tbl);
  }
  // FTS index survives the backup.
  q.run(`INSERT INTO documents(business_id, title, content, created_by, created_at, updated_at) VALUES (1, 'Doc', 'kopi arabika', 'test', 0, 0)`);
  const b2 = backup.createBackup('manual');
  const r2 = new DatabaseSync(b2.path, { readOnly: true });
  assert.equal(r2.prepare("SELECT COUNT(*) n FROM documents_fts WHERE documents_fts MATCH 'arabika'").get().n, 1);
  r.close();
  r2.close();
  assert.equal(backup.backupPath('../office.db'), null, 'path traversal rejected');
  assert.equal(backup.pruneBackups('manual', 1), 1);
});
