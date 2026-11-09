// Event-driven Telegram notifications with a serial send queue, alert throttling, and history in telegram_reports.
import { q, now } from '../db/index.js';
import { bus } from '../events.js';
import { escapeHtml, truncate, splitMessage, naturalParts } from '../lib/text.js';
import { config } from '../config.js';
import { getTelegramRow, getClient } from './settings.js';
import { getEmployee } from '../agents/employees.js';

const ALERT_THROTTLE_MS = 30 * 60_000;
const lastAlert = new Map();
const queue = [];
let sending = false;
let log = console;

export function recordMessage({ type, chatId, status, message, error = null, reportDate = null, attempts = 1 }) {
  const t = now();
  const r = q.run(
    `INSERT INTO telegram_reports(type, report_date, chat_id, status, attempts, message, error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    type, reportDate, chatId ?? null, status, attempts, truncate(message, 4000), error ? truncate(error, 500) : null, t, t
  );
  return r.lastInsertRowid;
}

// Telegram errors with what to do about them (shown in the notification history and on the dashboard).
export function explainTelegramError(message) {
  const m = String(message || '');
  if (/chat not found/i.test(m)) return `${m} — Chat ID tujuan salah, atau bot belum di-Start di chat itu / belum ada di grup. Kirim /setchat dari chat tujuan, atau perbaiki Chat ID di dashboard → Telegram.`;
  if (/bot was blocked by the user/i.test(m)) return `${m} — Buka bot di Telegram lalu tekan Restart/Unblock.`;
  if (/bot was kicked|bot is not a member/i.test(m)) return `${m} — Tambahkan bot lagi ke grup/channel, lalu kirim /setchat dari sana.`;
  if (/not enough rights|have no rights/i.test(m)) return `${m} — Jadikan bot admin dengan izin mengirim pesan.`;
  return m;
}

// Greeting that opens a scheduled/manual report, by the time of day in the holding timezone.
export function greeting(tz = 'Asia/Jakarta', ms = Date.now()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date(ms)));
  const part = h >= 4 && h < 10 ? 'pagi' : h < 15 && h >= 10 ? 'siang' : h < 18 && h >= 15 ? 'sore' : 'malam';
  return `Selamat ${part}! 👋`;
}

const splitOn = () => {
  const row = getTelegramRow();
  return row ? row.split_messages !== 0 : true;
};
const pause = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (Number.isFinite(config.telegramTypingScale) ? config.telegramTypingScale : 1))));

/**
 * Sends a message. Long reports are sent as several natural messages (one per section) with a "typing…" indicator
 * and a short pause before each, unless switched off in the Telegram settings; very long parts are still split at
 * Telegram's length limit. opts.intro: an extra first message (e.g. a greeting). Throws on failure.
 */
export async function sendText(chatId, html, client = getClient(), { natural = splitOn(), intro = null } = {}) {
  if (!client) throw new Error('Bot token belum diatur');
  if (!chatId) throw new Error('Chat ID belum diatur. Kirim /setchat dari chat tujuan, atau isi Chat ID di dashboard → Telegram.');
  const parts = natural ? naturalParts(html) : splitMessage(html);
  if (intro) parts.unshift(intro);
  const chatty = natural && parts.length > 1;
  for (const [i, part] of parts.entries()) {
    if (chatty) {
      await client.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      await pause(Math.min(2400, 600 + part.length * 2.5));
    } else if (i > 0) await pause(1100); // stay under Telegram per-chat limits
    try {
      await client.sendMessage(chatId, part);
    } catch (e) {
      if (e.migrateTo) {
        // The group became a supergroup (new id): follow it, also for the configured report chat.
        q.run('UPDATE telegram_settings SET chat_id = ?, updated_at = ? WHERE id = 1 AND chat_id = ?', String(e.migrateTo), now(), String(chatId));
        chatId = e.migrateTo;
        await client.sendMessage(chatId, part);
      } else if (e.retryAfter) {
        await new Promise((r) => setTimeout(r, Math.min(e.retryAfter, 30) * 1000));
        await client.sendMessage(chatId, part);
      } else if (/can't parse entities/i.test(e.message)) {
        // Fallback: plain text if HTML formatting got broken by splitting.
        await client.call('sendMessage', { chat_id: chatId, text: part.replace(/<[^>]+>/g, '') });
      } else {
        e.message = explainTelegramError(e.message);
        throw e;
      }
    }
  }
}

function enqueue(type, html) {
  queue.push({ type, html });
  if (!sending) drain();
}

async function drain() {
  sending = true;
  while (queue.length) {
    const item = queue.shift();
    const row = getTelegramRow();
    const chatId = row?.chat_id;
    try {
      await sendText(chatId, item.html);
      recordMessage({ type: item.type, chatId, status: 'sent', message: item.html });
    } catch (e) {
      recordMessage({ type: item.type, chatId, status: 'failed', message: item.html, error: e.message });
      log.warn?.(`Telegram ${item.type} gagal: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1100)); // stay under Telegram per-chat limits
  }
  sending = false;
}

function ready(flag, task) {
  const row = getTelegramRow();
  if (!row || !row.bot_token_enc || !row.chat_id || !row[flag]) return false;
  // Business tasks and employee subtasks are covered by the holding result; notify only if enabled.
  if (task && (task.kind === 'subtask' || task.kind === 'business') && !row.notify_subtasks) return false;
  return true;
}

function bizName(task) {
  if (!task?.business_id) return '';
  const b = q.get('SELECT name FROM businesses WHERE id = ?', task.business_id);
  return b ? ` [${escapeHtml(b.name)}]` : '';
}

const code = (t) => `T-${String(t.id).padStart(5, '0')}`;
const empName = (t) => {
  const e = t.employee_id ? getEmployee(t.employee_id) : null;
  return e ? `${e.name} (${e.role})` : '-';
};

function onStarted({ task }) {
  if (!ready('notify_task_started', task)) return;
  enqueue(
    'task_started',
    `▶️ <b>Tugas dimulai</b>${bizName(task)}\n<b>${code(task)}</b> ${escapeHtml(task.title)}\nPenanggung jawab: ${escapeHtml(empName(task))}`
  );
}

// Why that model answered (stored by the AI router with the task), as one short italic line.
function modelWhy(task) {
  let c = null;
  try {
    c = task.model_choice ? JSON.parse(task.model_choice) : null;
  } catch {}
  return c?.text ? `\n<i>${escapeHtml(truncate(c.text, 300))}</i>` : '';
}

function onCompleted({ task }) {
  if (!ready('notify_task_completed', task)) return;
  const summary = truncate(String(task.result || '').replace(/```[\s\S]*?```/g, '[kode]'), 1200);
  enqueue(
    'task_completed',
    `✅ <b>Tugas selesai</b>${bizName(task)}\n<b>${code(task)}</b> ${escapeHtml(task.title)}\n` +
      `Model: <code>${escapeHtml(task.provider_name || '-')} / ${escapeHtml(task.model_used || '-')}</code>${modelWhy(task)}\n\n${escapeHtml(summary)}`
  );
}

function onFailed({ task, error }) {
  if (!ready('notify_task_failed', task)) return;
  enqueue(
    'task_failed',
    `❌ <b>Tugas gagal</b>${bizName(task)}\n<b>${code(task)}</b> ${escapeHtml(task.title)}\nPenyebab: ${escapeHtml(truncate(error || task.error || '-', 800))}`
  );
}

// Owner approval requests are always notified when system alerts are enabled (they need a human decision).
function onApproval({ task, ids, items }) {
  if (!ready('notify_system_alert')) return;
  enqueue(
    'approval',
    `🔔 <b>Persetujuan owner dibutuhkan</b>${bizName(task)}\n<b>${code(task)}</b> ${escapeHtml(task.title)}\n` +
      items.map((it, i) => `• #${ids[i] ?? '-'} ${escapeHtml(truncate(it, 300))}`).join('\n') +
      '\n\nPutuskan di dashboard → Approvals. AI tidak mengeksekusi tindakan apa pun.'
  );
}

function onAlert({ key, title, message }) {
  const t = now();
  if (lastAlert.has(key) && t - lastAlert.get(key) < ALERT_THROTTLE_MS) return;
  lastAlert.set(key, t);
  if (!ready('notify_system_alert')) return;
  enqueue('system_alert', `⚠️ <b>System Alert</b>\n<b>${escapeHtml(title)}</b>\n${escapeHtml(truncate(message, 1500))}`);
}

export function startNotifier(logger) {
  if (logger) log = logger;
  bus.on('task:started', onStarted);
  bus.on('task:completed', onCompleted);
  bus.on('task:failed', onFailed);
  bus.on('system:alert', onAlert);
  bus.on('approval:created', onApproval);
}

export function stopNotifier() {
  bus.off('task:started', onStarted);
  bus.off('task:completed', onCompleted);
  bus.off('task:failed', onFailed);
  bus.off('system:alert', onAlert);
  bus.off('approval:created', onApproval);
}

export function resetAlertThrottle() {
  lastAlert.clear();
}

export function notifierIdle() {
  return !sending && queue.length === 0;
}
