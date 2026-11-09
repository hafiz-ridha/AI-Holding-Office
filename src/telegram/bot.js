// Telegram bot: long polling (no webhook/public port needed), commands restricted to whitelisted user IDs.
import { q } from '../db/index.js';
import { escapeHtml, truncate } from '../lib/text.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { bus } from '../events.js';
import { getTelegramRow, getClient, allowedUserIds, setLastUpdateId, updateTelegramSettings, rememberCommandChat, chatLabel } from './settings.js';
import { sendText, recordMessage } from './notifier.js';
import { buildHoldingReport, buildBusinessReport, buildFinanceReport } from './report.js';
import { findBusiness } from '../holding/businesses.js';
import { createOwnerTask } from '../holding/taskFactory.js';
import { worker } from '../queue/worker.js';

const COMMANDS = [
  ['overview', 'Ringkasan holding saat ini'],
  ['companies', 'Daftar bisnis'],
  ['business', 'Laporan satu bisnis: /business <slug>'],
  ['report', 'Laporan harian holding (hari ini sejauh ini)'],
  ['tasks', 'Tugas aktif (opsional: /tasks <slug>)'],
  ['finance', 'Ringkasan keuangan bulan ini'],
  ['approvals', 'Persetujuan owner yang menunggu'],
  ['task', 'Buat tugas: /task <instruksi> atau /task @slug <instruksi>'],
  ['setchat', 'Jadikan chat ini tujuan laporan & notifikasi otomatis'],
  ['status', 'Status antrean & provider AI'],
  ['today', 'Ringkasan aktivitas hari ini'],
  ['pause', 'Jeda antrean tugas AI'],
  ['resume', 'Lanjutkan antrean tugas AI'],
  ['help', 'Daftar perintah'],
];

const code = (id) => `T-${String(id).padStart(5, '0')}`;
const STATUS_ICON = { pending: '⏳', assigned: '📌', processing: '⚙️', completed: '✅', failed: '❌', cancelled: '🚫' };

function helpText() {
  return '<b>AI Virtual Holding — perintah</b>\n' + COMMANDS.map(([c, d]) => `/${c} — ${escapeHtml(d)}`).join('\n') +
    '\n\nSlug bisnis dapat dilihat dengan /companies.';
}

function overviewText() {
  const c = q.get(
    `SELECT COUNT(*) total, SUM(status='completed') done, SUM(status IN ('pending','assigned','processing')) open, SUM(status='failed') failed FROM tasks`
  );
  const L = ['<b>HOLDING OVERVIEW</b>'];
  L.push(`Antrean: ${getSetting('queue_paused') ? '⏸ dijeda' : '▶️ berjalan'} · tugas aktif ${c.open || 0} · selesai ${c.done || 0} · gagal ${c.failed || 0}`);
  for (const b of q.all('SELECT * FROM businesses ORDER BY status = \'active\' DESC, id')) {
    const s = q.get(`SELECT SUM(status IN ('pending','assigned','processing')) open, SUM(status='completed') done FROM tasks WHERE business_id = ?`, b.id);
    L.push(`▸ <b>${escapeHtml(b.name)}</b> (<code>${escapeHtml(b.slug)}</code>)${b.status !== 'active' ? ' nonaktif' : ''}: aktif ${s.open || 0}, selesai ${s.done || 0}`);
  }
  const pa = q.get("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").n;
  if (pa) L.push(`🔔 ${pa} persetujuan owner menunggu (/approvals)`);
  return L.join('\n');
}

function companiesText() {
  const rows = q.all(
    `SELECT b.*, e.name AS manager FROM businesses b LEFT JOIN employees e ON e.id = b.manager_employee_id ORDER BY b.id`
  );
  if (!rows.length) return 'Belum ada bisnis. Tambahkan dari dashboard → Business Directory.';
  return '<b>Daftar bisnis</b>\n' + rows.map((b) =>
    `• <b>${escapeHtml(b.name)}</b> — <code>/business ${escapeHtml(b.slug)}</code>\n  ${escapeHtml(b.industry || '-')} · Manager: ${escapeHtml(b.manager || 'belum ada')} · ${b.status}`
  ).join('\n');
}

function tasksText(arg) {
  let biz = null;
  if (arg) {
    biz = findBusiness(arg);
    if (!biz) return `Bisnis "${escapeHtml(arg)}" tidak ditemukan. Lihat /companies.`;
  }
  const rows = q.all(
    `SELECT t.id, t.title, t.status, t.kind, e.name AS emp, b.name AS biz FROM tasks t
     LEFT JOIN employees e ON e.id = t.employee_id LEFT JOIN businesses b ON b.id = t.business_id
     WHERE t.status IN ('pending','assigned','processing') ${biz ? 'AND t.business_id = ?' : ''}
     ORDER BY t.priority DESC, t.id LIMIT 15`,
    ...(biz ? [biz.id] : [])
  );
  const recent = q.all(
    `SELECT t.id, t.title, t.status FROM tasks t WHERE t.status IN ('completed','failed') AND t.kind != 'subtask' ${biz ? 'AND t.business_id = ?' : ''}
     ORDER BY t.completed_at DESC LIMIT 5`,
    ...(biz ? [biz.id] : [])
  );
  const L = [`<b>Tugas aktif${biz ? ` — ${escapeHtml(biz.name)}` : ''}</b>`];
  if (!rows.length) L.push('Tidak ada tugas aktif.');
  for (const t of rows) L.push(`${STATUS_ICON[t.status]} ${code(t.id)} ${escapeHtml(truncate(t.title, 60))} · ${escapeHtml(t.emp || '-')}${t.biz && !biz ? ` @ ${escapeHtml(t.biz)}` : ''}`);
  if (recent.length) {
    L.push('\n<b>Terakhir selesai/gagal</b>');
    for (const t of recent) L.push(`${STATUS_ICON[t.status]} ${code(t.id)} ${escapeHtml(truncate(t.title, 60))}`);
  }
  return L.join('\n');
}

function statusText() {
  const ws = worker.status();
  const L = ['<b>Status sistem</b>'];
  L.push(`Antrean: ${ws.paused ? '⏸ dijeda' : '▶️ berjalan'} · berjalan ${ws.running.length}/${ws.concurrency}`);
  const providers = q.all('SELECT name, status, enabled, is_default, default_model FROM providers ORDER BY is_default DESC, priority');
  if (!providers.length) L.push('Provider AI: belum dikonfigurasi');
  for (const p of providers) L.push(`• ${escapeHtml(p.name)}${p.is_default ? ' (default)' : ''}: ${p.enabled ? p.status : 'nonaktif'} · <code>${escapeHtml(p.default_model || '-')}</code>`);
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  L.push(`RAM proses: ${mb} MB · uptime ${Math.round(process.uptime() / 60)} menit`);
  return L.join('\n');
}

function approvalsText() {
  const rows = q.all(`SELECT a.id, a.detail, a.created_at, b.name AS biz FROM approvals a LEFT JOIN businesses b ON b.id = a.business_id WHERE a.status = 'pending' ORDER BY a.id LIMIT 10`);
  if (!rows.length) return 'Tidak ada persetujuan yang menunggu.';
  return '<b>Persetujuan owner menunggu</b>\n' + rows.map((a) => `#${a.id}${a.biz ? ` [${escapeHtml(a.biz)}]` : ''} ${escapeHtml(truncate(a.detail, 200))}`).join('\n') +
    '\n\nPutuskan di dashboard → Approvals.';
}

// Where automatic reports go, compared with the chat a command came from.
function destinationLine(chatId) {
  const dest = getTelegramRow()?.chat_id;
  if (!dest) return 'Chat ID tujuan laporan otomatis belum diatur. Kirim /setchat untuk memakai chat ini.';
  if (dest === String(chatId)) return '✅ Laporan & notifikasi otomatis dikirim ke chat ini.';
  return `Laporan & notifikasi otomatis saat ini dikirim ke Chat ID <code>${escapeHtml(dest)}</code>. Kirim /setchat untuk memakai chat ini.`;
}

export async function handleCommand(text, from, chatId, tz, chat = null) {
  const m = String(text || '').trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?\s*([\s\S]*)$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();
  const allowed = allowedUserIds().includes(String(from?.id));
  if (cmd === 'start' && !allowed) {
    return `Akses ditolak. User ID Telegram Anda: <code>${from?.id}</code>\nMinta admin menambahkan ID ini di dashboard → Telegram.`;
  }
  if (!allowed) return undefined; // silently ignore unauthorised users
  const actor = `telegram:${from.id}`;
  rememberCommandChat(chat || { id: chatId }, from);
  switch (cmd) {
    case 'start':
      return `Halo ${escapeHtml(from.first_name || '')}! Chat ID ini: <code>${chatId}</code>\n${destinationLine(chatId)}\n\n${helpText()}`;
    case 'setchat': {
      try {
        await updateTelegramSettings({ chat_id: String(chatId) });
      } catch (e) {
        return `Gagal memakai chat ini: ${escapeHtml(e.message)}`;
      }
      audit({ actor, action: 'telegram_chat_set', detail: { via: 'telegram', chat_id: String(chatId) } });
      return `✅ Laporan harian & notifikasi otomatis sekarang dikirim ke chat ini${chat ? ` (${escapeHtml(chatLabel(chat))})` : ''}.\nChat ID: <code>${chatId}</code>`;
    }
    case 'help':
      return helpText();
    case 'overview':
    case 'today':
      return cmd === 'today' ? buildHoldingReport(tz).text.split('<b>BUSINESS REPORTS:</b>')[0].trim() : overviewText();
    case 'companies':
      return companiesText();
    case 'business': {
      if (!arg) return 'Gunakan: /business &lt;slug&gt;\n\n' + companiesText();
      const biz = findBusiness(arg);
      if (!biz) return `Bisnis "${escapeHtml(arg)}" tidak ditemukan. Lihat /companies.`;
      return buildBusinessReport(biz, tz).text;
    }
    case 'report': {
      if (arg) {
        const biz = findBusiness(arg);
        if (!biz) return `Bisnis "${escapeHtml(arg)}" tidak ditemukan. Lihat /companies.`;
        return buildBusinessReport(biz, tz).text;
      }
      return buildHoldingReport(tz).text;
    }
    case 'tasks':
      return tasksText(arg);
    case 'finance':
      return buildFinanceReport(tz);
    case 'approvals':
      return approvalsText();
    case 'status':
      return statusText();
    case 'pause':
      setSetting('queue_paused', true);
      audit({ actor, action: 'queue_paused', detail: { via: 'telegram' } });
      return '⏸ Antrean tugas AI dijeda. Tugas yang sedang berjalan akan diselesaikan.';
    case 'resume':
      setSetting('queue_paused', false);
      bus.emit('queue:wake');
      audit({ actor, action: 'queue_resumed', detail: { via: 'telegram' } });
      return '▶️ Antrean tugas AI dilanjutkan.';
    case 'task': {
      if (!arg) return 'Gunakan: /task &lt;instruksi&gt; (ke Group CEO) atau /task @slug &lt;instruksi&gt; (ke Business Manager)';
      let mode = 'holding';
      let businessId = null;
      let body = arg;
      const mm = arg.match(/^@([\w-]+)\s+([\s\S]+)$/);
      if (mm) {
        const biz = findBusiness(mm[1]);
        if (!biz) return `Bisnis "${escapeHtml(mm[1])}" tidak ditemukan. Lihat /companies.`;
        mode = 'business';
        businessId = biz.id;
        body = mm[2];
      }
      try {
        const t = createOwnerTask({ mode, title: truncate(body.split('\n')[0], 120), description: body, businessId, createdBy: actor });
        audit({ actor, action: 'task_created', target: code(t.id), business_id: businessId, detail: { via: 'telegram', mode } });
        return `📝 Tugas dibuat: <b>${code(t.id)}</b> ${escapeHtml(t.title)}\n${mode === 'holding' ? 'Diteruskan ke Group CEO.' : 'Diteruskan ke Business Manager.'}`;
      } catch (e) {
        return `Gagal membuat tugas: ${escapeHtml(e.message)}`;
      }
    }
    default:
      return `Perintah tidak dikenal. ${helpText()}`;
  }
}

class Bot {
  constructor() {
    this.ctrl = null;
    this.running = false;
    this.log = console;
    this.state = { status: 'stopped', message: '' };
  }

  async start(log) {
    if (log) this.log = log;
    await this.stop();
    const row = getTelegramRow();
    const client = getClient();
    if (!client || !row?.polling_enabled) {
      this.state = { status: 'stopped', message: client ? 'Polling dinonaktifkan' : 'Bot token belum diatur' };
      return;
    }
    this.running = true;
    this.ctrl = new AbortController();
    this.state = { status: 'starting', message: 'Menghubungkan ke Telegram…' };
    // Wait for the first contact (deleteWebhook + setMyCommands, each bounded by the client timeout) so the dashboard
    // shows the real status right after the token is saved instead of a stale "stopped" until the first poll returns.
    await new Promise((ready) => this.loop(client, this.ctrl.signal, ready));
  }

  async stop() {
    this.running = false;
    this.ctrl?.abort();
    this.ctrl = null;
    if (this.loopPromise) await this.loopPromise.catch(() => {});
    this.loopPromise = null;
  }

  loop(client, signal, ready = () => {}) {
    this.loopPromise = (async () => {
      let backoff = 2000;
      try {
        await client.deleteWebhook(); // polling and webhooks are mutually exclusive in the Bot API
        await client.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description })));
        if (!signal.aborted) this.state = { status: 'running', message: 'Long polling aktif' };
      } catch (e) {
        if (!signal.aborted) this.state = { status: 'error', message: e.message };
        this.log.warn?.(`Telegram init: ${e.message}`);
      }
      ready();
      while (this.running && !signal.aborted) {
        try {
          const offset = (getTelegramRow()?.last_update_id || 0) + 1;
          const updates = await client.getUpdates(offset, 50, signal);
          this.state = { status: 'running', message: 'Long polling aktif' };
          backoff = 2000;
          for (const u of updates) {
            setLastUpdateId(u.update_id);
            await this.onUpdate(client, u).catch((e) => this.log.warn?.(`Telegram update error: ${e.message}`));
          }
        } catch (e) {
          if (signal.aborted || e.code === 'ABORTED') break;
          this.state = { status: 'error', message: e.message };
          this.log.warn?.(`Telegram polling: ${e.message}`);
          await new Promise((r) => setTimeout(r, e.retryAfter ? e.retryAfter * 1000 : backoff));
          backoff = Math.min(backoff * 2, 60000);
        }
      }
      this.state = { status: 'stopped', message: '' };
    })();
  }

  async onUpdate(client, u) {
    const msg = u.message;
    if (!msg?.text || !msg.text.startsWith('/')) return;
    const row = getTelegramRow();
    const tz = row?.timezone || 'Asia/Jakarta';
    const reply = await handleCommand(msg.text, msg.from, msg.chat.id, tz, msg.chat);
    if (reply === undefined) {
      this.log.info?.(`Telegram: perintah dari user tidak diizinkan (${msg.from?.id}) diabaikan`);
      return;
    }
    if (!reply) return;
    try {
      await sendText(msg.chat.id, reply, client);
      recordMessage({ type: 'command', chatId: String(msg.chat.id), status: 'sent', message: `${msg.text.split(/\s/)[0]} → ${reply.slice(0, 200)}` });
    } catch (e) {
      recordMessage({ type: 'command', chatId: String(msg.chat.id), status: 'failed', message: msg.text, error: e.message });
    }
  }
}

export const bot = new Bot();
export { COMMANDS };
