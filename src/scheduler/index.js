// Lightweight internal scheduler (one 30 s timer, no cron service). State lives in SQLite, so it survives restarts:
//  - daily Telegram report: claimed via a unique row per date -> never sent twice
//  - daily database backup + pruning
//  - daily cleanup of expired sessions and old logs
//  - recurring tasks (each due run creates exactly one task, see holding/recurring.js)
import { q, now } from '../db/index.js';
import { getSetting } from '../lib/settings.js';
import { localDate, localTime } from '../lib/time.js';
import { getTelegramRow, getClient } from '../telegram/settings.js';
import { sendText } from '../telegram/notifier.js';
import { buildHoldingReport } from '../telegram/report.js';
import { createBackup, pruneBackups } from '../services/backup.js';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { bus } from '../events.js';
import { runDueRecurring } from '../holding/recurring.js';

const MAX_REPORT_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000;
let timer = null;
let busy = false;
let log = console;
let lastCleanupDay = null;

// Claim today's report row atomically. Returns the row id to send, or null if already sent/claimed.
export function claimDailyReport(dateStr, chatId) {
  const t = now();
  try {
    const r = q.run(
      `INSERT INTO telegram_reports(type, report_date, chat_id, status, attempts, created_at, updated_at)
       VALUES ('daily_report', ?, ?, 'sending', 1, ?, ?)`,
      dateStr, chatId, t, t
    );
    return r.lastInsertRowid;
  } catch (e) {
    if (!/UNIQUE/i.test(e.message)) throw e;
  }
  // Row exists: retry only a failed send, a limited number of times, and not too often.
  const r = q.run(
    `UPDATE telegram_reports SET status = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE type = 'daily_report' AND report_date = ? AND status = 'failed' AND attempts < ? AND updated_at <= ?`,
    t, dateStr, MAX_REPORT_ATTEMPTS, t - RETRY_AFTER_MS
  );
  if (!r.changes) return null;
  return q.get("SELECT id FROM telegram_reports WHERE type = 'daily_report' AND report_date = ?", dateStr).id;
}

export async function runDailyReport({ force = false, at = Date.now() } = {}) {
  const row = getTelegramRow();
  if (!row || !row.report_enabled || !row.chat_id || !row.bot_token_enc) return { skipped: 'not configured' };
  const tz = row.timezone || 'Asia/Jakarta';
  if (!force && localTime(at, tz) < row.report_time) return { skipped: 'not time yet' };
  const dateStr = localDate(at, tz);
  const id = claimDailyReport(dateStr, row.chat_id);
  if (!id) return { skipped: 'already sent' };
  const { text } = buildHoldingReport(tz, at);
  try {
    await sendText(row.chat_id, text, getClient());
    q.run("UPDATE telegram_reports SET status = 'sent', message = ?, error = NULL, updated_at = ? WHERE id = ?", text.slice(0, 4000), now(), id);
    log.info?.(`Laporan harian ${dateStr} terkirim`);
    return { sent: true, dateStr };
  } catch (e) {
    q.run("UPDATE telegram_reports SET status = 'failed', message = ?, error = ?, updated_at = ? WHERE id = ?", text.slice(0, 4000), e.message.slice(0, 500), now(), id);
    bus.emit('system:alert', { key: 'daily-report', title: 'Laporan harian gagal dikirim', message: e.message });
    return { sent: false, error: e.message };
  }
}

export function runBackupIfDue(at = Date.now()) {
  if (!getSetting('backup_enabled')) return null;
  const tz = getSetting('timezone');
  if (localTime(at, tz) < getSetting('backup_time')) return null;
  const day = localDate(at, tz).replace(/-/g, '');
  // File names use UTC stamps, so "already backed up today" is tracked by local day in a marker setting.
  const marker = q.get("SELECT value FROM system_settings WHERE key = '_last_auto_backup'");
  if (marker && JSON.parse(marker.value) === day) return null;
  try {
    const b = createBackup('auto');
    pruneBackups('auto', getSetting('backup_retention'));
    pruneBackups('pre-migrate', 5);
    q.run(`INSERT OR REPLACE INTO system_settings(key, value, updated_at) VALUES ('_last_auto_backup', ?, ?)`, JSON.stringify(day), now());
    log.info?.(`Backup otomatis dibuat: ${b.name}`);
    return b;
  } catch (e) {
    bus.emit('system:alert', { key: 'backup', title: 'Backup database gagal', message: e.message });
    return null;
  }
}

export function runCleanup(at = Date.now()) {
  const day = localDate(at, getSetting('timezone'));
  if (lastCleanupDay === day) return null;
  lastCleanupDay = day;
  const cutoff = at - getSetting('log_retention_days') * 86400_000;
  const out = {
    sessions: purgeExpiredSessions(),
    usage: q.run('DELETE FROM usage_logs WHERE created_at < ?', cutoff).changes,
    taskLogs: q.run('DELETE FROM task_logs WHERE created_at < ?', cutoff).changes,
    conversations: q.run('DELETE FROM conversations WHERE created_at < ?', cutoff).changes,
    telegram: q.run("DELETE FROM telegram_reports WHERE created_at < ? AND type != 'daily_report'", cutoff).changes,
    audit: q.run('DELETE FROM audit_logs WHERE created_at < ?', cutoff).changes,
    chat: q.run('DELETE FROM chat_messages WHERE created_at < ?', cutoff).changes,
  };
  q.exec('PRAGMA optimize');
  return out;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await runDailyReport();
    runDueRecurring();
    runBackupIfDue();
    runCleanup();
  } catch (e) {
    log.error?.({ err: e }, 'scheduler tick failed');
  } finally {
    busy = false;
  }
}

export function startScheduler({ logger, intervalMs = 30_000 } = {}) {
  if (logger) log = logger;
  stopScheduler();
  timer = setInterval(tick, intervalMs);
  setTimeout(tick, 5_000).unref();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
