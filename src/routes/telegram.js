import { q } from '../db/index.js';
import { toPublic, updateTelegramSettings, getTelegramRow, getClient, lastCommandChat, chatLabel } from '../telegram/settings.js';
import { sendText, recordMessage, greeting } from '../telegram/notifier.js';
import { buildHoldingReport, buildBusinessReport } from '../telegram/report.js';
import { runDailyReport } from '../scheduler/index.js';
import { findBusiness } from '../holding/businesses.js';
import { bot, COMMANDS } from '../telegram/bot.js';
import { teamInfo, syncTeamTopics, unlinkTeam } from '../telegram/team.js';
import { auditReq } from '../lib/audit.js';
import { body, str, bool, httpError } from './schemas.js';

const fields = {
  bot_token: str(200),
  clear_bot_token: bool,
  chat_id: str(70),
  allowed_user_ids: { type: 'array', maxItems: 50, items: str(20) },
  report_enabled: bool,
  report_time: str(5),
  timezone: str(64),
  polling_enabled: bool,
  notify_task_started: bool,
  notify_task_completed: bool,
  notify_task_failed: bool,
  notify_system_alert: bool,
  notify_subtasks: bool,
  split_messages: bool,
};

export default async function telegramRoutes(app) {
  app.get('/api/telegram', async () => ({
    settings: toPublic(),
    bot: bot.state,
    commands: COMMANDS.map(([c, d]) => ({ command: `/${c}`, description: d })),
    today_report: q.get("SELECT status, attempts, error, updated_at FROM telegram_reports WHERE type = 'daily_report' ORDER BY id DESC LIMIT 1") || null,
    // Latest automatic send (not a command reply) and the chat an allowed user last wrote from: lets the page
    // offer a one-click fix when the configured Chat ID does not work.
    last_auto: q.get("SELECT status, chat_id, error, created_at FROM telegram_reports WHERE type != 'command' ORDER BY id DESC LIMIT 1") || null,
    last_command_chat: lastCommandChat(),
    team: teamInfo(),
  }));

  // Team group (topic per employee): create missing / rename changed topics now, or unlink the group.
  app.post('/api/telegram/team/sync', async (req) => {
    if (!getTelegramRow()?.team_chat_id) throw httpError('Belum ada grup tim. Kirim /team di grup Telegram dengan Topics aktif.');
    const r = await syncTeamTopics();
    auditReq(req, 'telegram_team_sync', null, { created: r.created, renamed: r.renamed, errors: r.errors.length });
    return { ...r, team: teamInfo() };
  });

  app.delete('/api/telegram/team', async (req) => {
    unlinkTeam();
    auditReq(req, 'telegram_team_unlinked');
    return { ok: true };
  });

  app.put('/api/telegram', { schema: { body: body(fields) } }, async (req) => {
    const r = await updateTelegramSettings(req.body);
    auditReq(req, 'telegram_updated', null, { fields: Object.keys(req.body).filter((k) => k !== 'bot_token'), token_changed: r.tokenChanged });
    if (r.tokenChanged || r.pollingChanged) await bot.start(req.log);
    return { settings: r.settings, bot: bot.state, chat: r.chat && typeof r.chat === 'object' ? { id: r.chat.id, type: r.chat.type, label: chatLabel(r.chat) } : null };
  });

  app.post('/api/telegram/test', async (req) => {
    const row = getTelegramRow();
    const text = '✅ <b>Tes AI Virtual Holding</b>\nKoneksi bot ke chat ini berhasil.';
    try {
      await sendText(row.chat_id, text, getClient(), { threadId: row.report_thread_id });
      recordMessage({ type: 'test', chatId: row.chat_id, status: 'sent', message: text });
      auditReq(req, 'telegram_test');
      return { ok: true };
    } catch (e) {
      recordMessage({ type: 'test', chatId: row?.chat_id, status: 'failed', message: text, error: e.message });
      return { ok: false, error: e.message };
    }
  });

  // Preview without sending (no API quota used: built from DB only).
  app.get('/api/telegram/preview', {
    schema: { querystring: { type: 'object', properties: { business: str(60) } } },
  }, async (req) => {
    const tz = getTelegramRow()?.timezone || 'Asia/Jakarta';
    if (req.query.business) {
      const b = findBusiness(req.query.business);
      if (!b) throw httpError('Bisnis tidak ditemukan', 404);
      return buildBusinessReport(b, tz);
    }
    return buildHoldingReport(tz);
  });

  // Manual report: separate type, never blocks or duplicates the scheduled daily report.
  app.post('/api/telegram/report-now', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { business: str(60) } } },
  }, async (req) => {
    const row = getTelegramRow();
    const tz = row?.timezone || 'Asia/Jakarta';
    let text;
    if (req.body?.business) {
      const b = findBusiness(req.body.business);
      if (!b) throw httpError('Bisnis tidak ditemukan', 404);
      text = buildBusinessReport(b, tz).text;
    } else text = buildHoldingReport(tz).text;
    try {
      await sendText(row.chat_id, text, getClient(), { intro: row.split_messages !== 0 ? `${greeting(tz)} Ini laporan terbaru yang Anda minta.` : null, threadId: row.report_thread_id });
      recordMessage({ type: 'manual_report', chatId: row.chat_id, status: 'sent', message: text });
      auditReq(req, 'telegram_manual_report');
      return { ok: true };
    } catch (e) {
      recordMessage({ type: 'manual_report', chatId: row?.chat_id, status: 'failed', message: text, error: e.message });
      return { ok: false, error: e.message };
    }
  });

  // Trigger the scheduled-report logic now (still respects the once-per-day guarantee).
  app.post('/api/telegram/daily-run', async (req) => {
    const r = await runDailyReport({ force: true });
    auditReq(req, 'telegram_daily_run', null, r);
    return r;
  });

  app.get('/api/telegram/history', async () =>
    q.all('SELECT id, type, report_date, chat_id, status, attempts, substr(message, 1, 300) AS message, error, created_at FROM telegram_reports ORDER BY id DESC LIMIT 100')
  );
}
