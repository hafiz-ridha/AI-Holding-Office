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
    split_messages: row.split_messages === undefined ? true : Boolean(row.split_messages),
    report_thread_id: row.report_thread_id ?? null,
    team_chat_id: row.team_chat_id ?? null,
    updated_at: row.updated_at,
  };
}

const BOOL_FIELDS = [
  'report_enabled', 'polling_enabled', 'notify_task_started', 'notify_task_completed',
  'notify_task_failed', 'notify_system_alert', 'notify_subtasks', 'split_messages',
];

// A chat the bot must be able to reach. Common mistakes get a clear message instead of a later "chat not found".
async function checkChat(chatId, token) {
  const botId = String(token || '').split(':')[0];
  if (botId && chatId === botId) {
    throw httpError('Chat ID ini adalah ID bot Anda sendiri (angka sebelum ":" di token), bukan ID Anda. Kirim /start ke bot untuk melihat User ID Anda, atau kirim /setchat dari chat tujuan.');
  }
  if (!token) return null;
  try {
    return await new TelegramClient(token).getChat(chatId);
  } catch (e) {
    if (e.status === 400 || e.status === 403) {
      throw httpError(`Bot tidak bisa mengirim ke Chat ID ${chatId} (${e.message.replace(/^Telegram:\s*/, '')}). Pastikan Anda sudah menekan Start di chat pribadi dengan bot, atau bot sudah ditambahkan ke grup/channel (channel: jadikan admin). Cara termudah: kirim /setchat dari chat tujuan.`);
    }
    return null; // network problem: keep the value, sending will report it
  }
}

export function chatLabel(chat) {
  if (!chat || typeof chat !== 'object') return '';
  if (chat.type === 'private') return [chat.first_name, chat.last_name].filter(Boolean).join(' ') + (chat.username ? ` (@${chat.username})` : '') || 'chat pribadi';
  return `${chat.title || chat.username || 'chat'} (${chat.type === 'channel' ? 'channel' : 'grup'})`;
}

// The chat an allowed user last sent a command from (offered on the dashboard when automatic sends fail).
export function rememberCommandChat(chat, from) {
  if (!chat?.id) return;
  const v = JSON.stringify({ chat_id: String(chat.id), label: chatLabel(chat) || String(chat.id), user_id: String(from?.id || ''), at: now() });
  q.run("INSERT OR REPLACE INTO system_settings(key, value, updated_at) VALUES ('_telegram_last_chat', ?, ?)", v, now());
}

export function lastCommandChat() {
  return json(q.get("SELECT value FROM system_settings WHERE key = '_telegram_last_chat'")?.value, null);
}

// Returns { settings, tokenChanged, chat }.
export async function updateTelegramSettings(data) {
  const sets = [];
  const vals = [];
  let tokenChanged = false;
  let chat = null;
  let newToken = null;
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
    newToken = token;
  } else if (data.clear_bot_token) {
    sets.push('bot_token_enc = NULL', 'bot_token_hint = NULL', 'bot_username = NULL');
    tokenChanged = true;
  }
  if ('chat_id' in data) {
    const c = String(data.chat_id || '').trim();
    if (c && !/^-?\d{1,20}$/.test(c) && !/^@[A-Za-z0-9_]{5,64}$/.test(c)) throw httpError('Chat ID harus angka (contoh: 123456789 atau -100123...) atau @channel');
    const row = getTelegramRow();
    // Checked against Telegram when it changes (or the token changes): the bot must be able to reach that chat.
    if (c && (c !== row?.chat_id || newToken)) chat = await checkChat(c, newToken || getBotToken());
    sets.push('chat_id = ?');
    vals.push(c || null);
    // Topic of a group with Topics (from /setchat inside a topic). A new chat without a topic: no topic.
    const thread = 'report_thread_id' in data ? (Number.isInteger(data.report_thread_id) ? data.report_thread_id : null) : c === row?.chat_id ? row?.report_thread_id ?? null : null;
    sets.push('report_thread_id = ?');
    vals.push(thread);
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
  return { settings: toPublic(), tokenChanged, pollingChanged: 'polling_enabled' in data, chat };
}

export function setLastUpdateId(id) {
  q.run('UPDATE telegram_settings SET last_update_id = ? WHERE id = 1', id);
}
