// Minimal Telegram Bot API client using native fetch.
import { config } from '../config.js';

export class TelegramError extends Error {
  constructor(message, { status = null, code = null, retryAfter = null, migrateTo = null } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.migrateTo = migrateTo; // a group was upgraded to a supergroup: its new chat id
  }
}

export class TelegramClient {
  constructor(token) {
    this.token = token;
  }

  async call(method, params = {}, { timeoutMs = 15000, signal } = {}) {
    if (!this.token) throw new TelegramError('Bot token belum diatur');
    if (signal?.aborted) throw new TelegramError('aborted', { code: 'ABORTED' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(`${config.telegramApiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new TelegramError('aborted', { code: 'ABORTED' });
      // Never include the URL (it contains the token) in error messages.
      throw new TelegramError(ctrl.signal.aborted ? 'Timeout ke Telegram API' : `Tidak dapat terhubung ke Telegram: ${e.cause?.code || 'network error'}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok || !data?.ok) {
      throw new TelegramError(`Telegram: ${data?.description || `HTTP ${res.status}`}`, {
        status: res.status,
        code: data?.error_code,
        retryAfter: data?.parameters?.retry_after ?? null,
        migrateTo: data?.parameters?.migrate_to_chat_id ?? null,
      });
    }
    return data.result;
  }

  getMe() {
    return this.call('getMe');
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  getUpdates(offset, timeoutSec, signal) {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      { timeoutMs: (timeoutSec + 15) * 1000, signal }
    );
  }

  // Checks that the bot can reach a chat (the bot must have been started there / be a member of the group).
  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  // Forum topics (groups with Topics): one per AI employee.
  createForumTopic(chatId, name, iconColor) {
    return this.call('createForumTopic', { chat_id: chatId, name, ...(iconColor ? { icon_color: iconColor } : {}) });
  }

  editForumTopic(chatId, threadId, name) {
    return this.call('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name });
  }

  deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }
}
