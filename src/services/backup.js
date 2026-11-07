// SQLite backups via VACUUM INTO (consistent snapshot while the app runs; no extra tooling).
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

export const BACKUP_NAME = /^(auto|manual|pre-migrate)-\d{8}-\d{6}\.db$/;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function createBackup(kind = 'manual') {
  fs.mkdirSync(config.backupDir, { recursive: true });
  let name = `${kind}-${stamp()}.db`;
  let file = path.join(config.backupDir, name);
  let i = 1;
  while (fs.existsSync(file)) {
    // Same-second collision: bump the timestamp.
    name = `${kind}-${stamp(new Date(Date.now() + 1000 * i++))}.db`;
    file = path.join(config.backupDir, name);
  }
  getDb().prepare('VACUUM INTO ?').run(file);
  const size = fs.statSync(file).size;
  return { name, size, path: file };
}

export function listBackups() {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs
    .readdirSync(config.backupDir)
    .filter((f) => BACKUP_NAME.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(config.backupDir, f));
      return { name: f, size: st.size, created_at: st.mtimeMs };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

export function backupPath(name) {
  if (!BACKUP_NAME.test(name)) return null;
  const file = path.join(config.backupDir, name);
  return fs.existsSync(file) ? file : null;
}

// Keep the newest `keep` files of one kind.
export function pruneBackups(kind, keep) {
  const files = listBackups().filter((b) => b.name.startsWith(`${kind}-`));
  let removed = 0;
  for (const b of files.slice(keep)) {
    fs.unlinkSync(path.join(config.backupDir, b.name));
    removed++;
  }
  return removed;
}

export function hasBackupForDay(kind, yyyymmdd) {
  return listBackups().some((b) => b.name.startsWith(`${kind}-${yyyymmdd}`));
}
