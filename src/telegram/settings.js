// Telegram configuration (single row). The bot token is encrypted at rest and never returned to the frontend.
import { q, now, json } from '../db/index.js';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto.js';
import { isValidTimezone } from '../lib/time.js';
import { TelegramClient } from './client.js';

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

export function getTelegramRow() {
  return q.get('SELECT * FROM telegram_settings WHERE id = 1');
}

export function getBotToken() {
  const row = getTelegramRow();
  if (!row?.bot_token_enc) return '';
  try {
    return decryptSecret(row.bot_token_enc);
  } catch {
    return '';
  }
}

export function getClient() {
  const token = getBotToken();
  return token ? new TelegramClient(token) : null;
}

export function allowedUserIds(row = getTelegramRow()) {
  return json(row?.allowed_user_ids, []).map(String);
}

export function toPublic(row = getTelegramRow()) {
  return {
    has_bot_token: Boolean(row.bot_token_enc),
    bot_token_hint: row.bot_token_hint || '',
    bot_username: row.bot_username || '',
    chat_id: row.chat_id || '',
    allowed_user_ids: allowedUserIds(row),
    report_enabled: Boolean(row.report_enabled),
    report_time: row.report_time,
    timezone: row.timezone,
    polling_enabled: Boolean(row.polling_enabled),
    notify_task_started: Boolean(row.notify_task_started),
    notify_task_completed: Boolean(row.notify_task_completed),
    notify_task_failed: Boolean(row.notify_task_failed),
    notify_system_alert: Boolean(row.notify_system_alert),
    notify_subtasks: Boolean(row.notify_subtasks),
    updated_at: row.updated_at,
  };
}

const BOOL_FIELDS = [
  'report_enabled', 'polling_enabled', 'notify_task_started', 'notify_task_completed',
  'notify_task_failed', 'notify_system_alert', 'notify_subtasks',
];

// Returns { settings, tokenChanged }.
export async function updateTelegramSettings(data) {
  const sets = [];
  const vals = [];
  let tokenChanged = false;
  if (typeof data.bot_token === 'string' && data.bot_token.trim()) {
    const token = data.bot_token.trim();
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(token)) throw httpError('Format bot token tidak valid (contoh: 123456:ABC...)');
    // Validate against Telegram before saving.
    let me;
    try {
      me = await new TelegramClient(token).getMe();
    } catch (e) {
      throw httpError(`Bot token ditolak Telegram: ${e.message}`);
    }
    sets.push('bot_token_enc = ?', 'bot_token_hint = ?', 'bot_username = ?', 'last_update_id = 0');
    vals.push(encryptSecret(token), maskSecret(token), me.username || '');
    tokenChanged = true;
  } else if (data.clear_bot_token) {
    sets.push('bot_token_enc = NULL', 'bot_token_hint = NULL', 'bot_username = NULL');
    tokenChanged = true;
  }
  if ('chat_id' in data) {
    const c = String(data.chat_id || '').trim();
    if (c && !/^-?\d{1,20}$/.test(c) && !/^@[A-Za-z0-9_]{5,64}$/.test(c)) throw httpError('Chat ID harus angka (contoh: 123456789 atau -100123...) atau @channel');
    sets.push('chat_id = ?');
    vals.push(c || null);
  }
  if ('allowed_user_ids' in data) {
    const list = (Array.isArray(data.allowed_user_ids) ? data.allowed_user_ids : String(data.allowed_user_ids).split(/[\s,]+/))
      .map((s) => String(s).trim())
      .filter(Boolean);
    for (const id of list) if (!/^\d{1,20}$/.test(id)) throw httpError(`User ID tidak valid: ${id}`);
    sets.push('allowed_user_ids = ?');
    vals.push(JSON.stringify([...new Set(list)].slice(0, 50)));
  }
  if ('report_time' in data) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.report_time)) throw httpError('Jam laporan harus format HH:MM');
    sets.push('report_time = ?');
    vals.push(data.report_time);
  }
  if ('timezone' in data) {
    if (!isValidTimezone(data.timezone)) throw httpError('Zona waktu tidak valid');
    sets.push('timezone = ?');
    vals.push(data.timezone);
  }
  for (const f of BOOL_FIELDS) {
    if (f in data) {
      sets.push(`${f} = ?`);
      vals.push(data[f] ? 1 : 0);
    }
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now());
    q.run(`UPDATE telegram_settings SET ${sets.join(', ')} WHERE id = 1`, ...vals);
  }
  return { settings: toPublic(), tokenChanged, pollingChanged: 'polling_enabled' in data };
}

export function setLastUpdateId(id) {
  q.run('UPDATE telegram_settings SET last_update_id = ? WHERE id = 1', id);
}
