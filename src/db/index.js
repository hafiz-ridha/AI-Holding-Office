// Thin wrapper around the built-in node:sqlite driver.
// All DB access goes through this module, so switching to better-sqlite3 later is a one-file change.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let db = null;

export function openDb(file) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -4000;
    PRAGMA temp_store = MEMORY;
  `);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database belum dibuka');
  return db;
}

export function closeDb() {
  if (db) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
    db.close();
    db = null;
  }
}

// node:sqlite returns null-prototype objects; normalise to plain objects for JSON/serialisation.
function plain(row) {
  return row ? { ...row } : undefined;
}

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export function resetStatementCache() {
  stmtCache.clear();
}

export const q = {
  get(sql, ...params) {
    return plain(stmt(sql).get(...params));
  },
  all(sql, ...params) {
    return stmt(sql).all(...params).map(plain);
  },
  run(sql, ...params) {
    const r = stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  exec(sql) {
    getDb().exec(sql);
  },
};

let txDepth = 0;
// Synchronous transaction helper (node:sqlite is synchronous, so no interleaving inside fn).
export function tx(fn) {
  if (txDepth > 0) return fn();
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {}
    throw e;
  } finally {
    txDepth--;
  }
}

export function now() {
  return Date.now();
}

export function json(v, def = null) {
  if (v === null || v === undefined || v === '') return def;
  try {
    return JSON.parse(v);
  } catch {
    return def;
  }
}
