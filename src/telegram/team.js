// Telegram team group: a Telegram group with Topics where every AI employee has their own topic (plus one topic for
// reports & notifications). Linked with /team inside the group (the bot must be an admin that may manage topics).
//
//  - Writing in an employee's topic talks to that employee through the same chat as the dashboard
//    (sendOwnerMessage): a quick AI reply by default, "/tugas ..." = full task, "/catat ..." = note only.
//  - The employee's answers, and reports/approvals/failures addressed to the owner, come back into that topic,
//    each starting with a person emoji for the job in the character's skin tone (from the virtual office), the
//    name and the role.
//    Topic icons use the colour of the character's shirt. Owner messages from the dashboard are mirrored into the topic.
//  - New or renamed employees get their topic automatically (checked by the scheduler).
// One bot speaks for everyone (a bot cannot change its profile photo per message), so the emoji + name say
// who is talking. Telegram allows ~20 messages per minute in a group: topic messages are queued accordingly.
import { q, now, json } from '../db/index.js';
import { bus } from '../events.js';
import { escapeHtml, truncate, splitMessage } from '../lib/text.js';
import { getTelegramRow, getClient, allowedUserIds, getBotToken } from './settings.js';
import { recordMessage } from './notifier.js';
import { getEmployee, businessIdsOf } from '../agents/employees.js';
import { getBusiness } from '../holding/businesses.js';
import { sendOwnerMessage } from '../holding/chat.js';
import { config } from '../config.js';

export const REPORTS_TOPIC = '📊 Laporan & Notifikasi';
const code = (id) => `T-${String(id).padStart(5, '0')}`;
const pause = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (Number.isFinite(config.telegramTypingScale) ? config.telegramTypingScale : 1))));

// ---------------- colours ----------------
const rgb = (hex) => {
  const n = parseInt(String(hex || '').replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
function nearest(hex, palette) {
  const [r, g, b] = rgb(hex);
  let best = palette[0];
  let bd = Infinity;
  for (const p of palette) {
    const [r2, g2, b2] = rgb(p[0]);
    const d = 2 * (r - r2) ** 2 + 4 * (g - g2) ** 2 + 3 * (b - b2) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best[1];
}
// The only icon colours Telegram accepts for forum topics.
const TOPIC_COLORS = [['#6fb9f0', 0x6fb9f0], ['#ffd67e', 0xffd67e], ['#cb86db', 0xcb86db], ['#8eee98', 0x8eee98], ['#ff93b2', 0xff93b2], ['#fb6f5f', 0xfb6f5f]];
const avatarOf = (e) => json(e?.avatar, {}) || {};
const shirtOf = (e) => avatarOf(e).shirt || '#3b82f6'; // same defaults as the office sprites
const skinOf = (e) => avatarOf(e).skin || '#f1c27d';
export const topicColor = (e) => nearest(shirtOf(e), TOPIC_COLORS);
const roleShort = (e) => String(e.role || '').split(' — ')[0].trim() || e.role_key || '';

// Person emoji for an employee: the job (gender-neutral emoji) with the character's skin tone from the virtual office.
// [base, rest]: the skin-tone modifier goes right after the base person.
const JOBS = [
  [(e) => e.is_manager || e.role_key === 'ceo', ['🤵', '']],
  [(e) => e.role_key === 'business_manager', ['🧑', '‍💼']],
  [(e, r) => /develop|program|engineer|\bit\b|teknologi|devops|data/.test(r), ['🧑', '‍💻']],
  [(e, r) => /research|riset|peneliti|analis|analyst/.test(r), ['🧑', '‍🔬']],
  [(e, r) => /marketing|pemasaran|konten|content|sosial|social|desain|design|kreatif|creative|brand/.test(r), ['🧑', '‍🎨']],
  [(e, r) => /barista|chef|koki|dapur|kitchen|cook|masak/.test(r), ['🧑', '‍🍳']],
  [(e, r) => /secretar|sekretaris|resepsionis|reception|customer|layanan|\bcs\b|support/.test(r), ['💁', '']],
  [(e, r) => /legal|hukum|lawyer/.test(r), ['🧑', '‍⚖️']],
  [(e, r) => /operasi|operation|gudang|logistik|warehouse|teknisi|technician|maintenance/.test(r), ['🧑', '‍🔧']],
  [(e, r) => /trainer|pelatih|guru|teacher|edukasi|education/.test(r), ['🧑', '‍🏫']],
  [() => true, ['🧑', '‍💼']], // finance, HR, sales, managers, everyone else: office worker
];
const TONES = [[0.8, '\u{1F3FB}'], [0.68, '\u{1F3FC}'], [0.55, '\u{1F3FD}'], [0.4, '\u{1F3FE}'], [-1, '\u{1F3FF}']];
export function personEmoji(e) {
  const r = `${e.role_key || ''} ${e.role || ''}`.toLowerCase();
  const [base, rest] = JOBS.find(([test]) => test(e, r))[1];
  const [R, G, B] = rgb(skinOf(e));
  const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
  return `${base}${TONES.find(([min]) => lum > min)[1]}${rest}`;
}
export const speaker = (e) => `${personEmoji(e)} <b>${escapeHtml(e.name)}</b> · <i>${escapeHtml(roleShort(e))}</i>`;

// AI answers are Markdown: show the basics as Telegram HTML (bold, italic, code, headings, bullets).
export function mdToTelegram(text) {
  return escapeHtml(String(text || ''))
    .replace(/```[\s\S]*?```/g, (m) => `<pre>${m.slice(3, -3).replace(/^\w*\n/, '')}</pre>`)
    .replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

// ---------------- topics ----------------
export const teamChatId = () => getTelegramRow()?.team_chat_id || null;

// Chat channel of an employee in the dashboard chat: managed business, own business, or HQ.
export function channelOf(e) {
  const managed = q.get("SELECT id FROM businesses WHERE manager_employee_id = ? AND status = 'active' ORDER BY id LIMIT 1", e.id);
  if (managed) return managed.id;
  if (e.org_unit === 'business') return businessIdsOf(e.id)[0] ?? null;
  return null;
}

export function topicName(e) {
  const biz = channelOf(e);
  const bname = biz ? getBusiness(biz)?.name : null;
  return truncate(`${e.name} · ${roleShort(e)}${bname ? ` — ${bname}` : ''}`, 120);
}

export const topicOf = (chatId, employeeId) => q.get('SELECT * FROM telegram_topics WHERE chat_id = ? AND employee_id = ?', String(chatId), employeeId);
export const topicByThread = (chatId, threadId) => q.get('SELECT * FROM telegram_topics WHERE chat_id = ? AND thread_id = ?', String(chatId), threadId);
export const reportsTopic = (chatId) => q.get("SELECT * FROM telegram_topics WHERE chat_id = ? AND kind = 'reports'", String(chatId));

function wanted() {
  return [
    { kind: 'reports', employee_id: null, name: REPORTS_TOPIC, color: 0xfb6f5f },
    ...q.all('SELECT * FROM employees WHERE enabled = 1 ORDER BY is_manager DESC, desk_index, id')
      .map((e) => ({ kind: 'employee', employee_id: e.id, name: topicName(e), color: topicColor(e) })),
  ];
}

/** Topics that are missing or renamed (cheap: DB only). */
export function pendingTopicChanges(chatId = teamChatId()) {
  if (!chatId) return [];
  return wanted().filter((w) => {
    const row = w.employee_id ? topicOf(chatId, w.employee_id) : reportsTopic(chatId);
    return !row || row.name !== w.name;
  });
}

let syncing = null;
/** Create missing topics and rename changed ones. Safe to call often; runs one sync at a time. */
export function syncTeamTopics({ client = getClient() } = {}) {
  const chatId = teamChatId();
  if (!chatId || !client) return Promise.resolve({ created: 0, renamed: 0, errors: [] });
  if (syncing) return syncing;
  syncing = (async () => {
    const out = { created: 0, renamed: 0, errors: [] };
    for (const w of pendingTopicChanges(chatId)) {
      const row = w.employee_id ? topicOf(chatId, w.employee_id) : reportsTopic(chatId);
      const attempt = async () => {
        if (!row) {
          const t = await client.createForumTopic(chatId, w.name, w.color);
          q.run(
            'INSERT INTO telegram_topics(chat_id, kind, employee_id, thread_id, name, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
            chatId, w.kind, w.employee_id, t.message_thread_id, w.name, w.color, now(), now()
          );
          out.created++;
        } else {
          await client.editForumTopic(chatId, row.thread_id, w.name);
          q.run('UPDATE telegram_topics SET name = ?, updated_at = ? WHERE id = ?', w.name, now(), row.id);
          out.renamed++;
        }
      };
      try {
        await attempt();
      } catch (e) {
        if (e.retryAfter) {
          await pause(Math.min(e.retryAfter, 30) * 1000);
          try {
            await attempt();
          } catch (e2) {
            out.errors.push(`${w.name}: ${e2.message}`);
          }
        } else if (row && /TOPIC_ID_INVALID|thread not found|TOPIC_DELETED/i.test(e.message)) {
          q.run('DELETE FROM telegram_topics WHERE id = ?', row.id); // deleted in Telegram: recreated next time
        } else {
          out.errors.push(`${w.name}: ${e.message}`);
          if (/not enough rights|CHAT_ADMIN_REQUIRED|not a forum|chat not found/i.test(e.message)) break;
        }
      }
      await pause(1100);
    }
    return out;
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Scheduler hook: new/renamed employees get their topic without anyone asking. */
export function maybeSyncTeam() {
  if (teamChatId() && !syncing && pendingTopicChanges().length) syncTeamTopics().catch(() => {});
}

/** Link the group (from /team). Checks Topics + admin rights. Returns { ok, error }. */
export async function linkTeam(chat, client = getClient()) {
  if (!client) return { ok: false, error: 'Bot token belum diatur.' };
  if (!chat || chat.type !== 'supergroup' || !chat.is_forum) {
    return { ok: false, error: 'Kirim /team di grup yang fitur Topics-nya aktif (Info grup → Edit → Topics). Bot harus admin dengan izin "Kelola topik".' };
  }
  const botId = Number(getBotToken().split(':')[0]) || (await client.getMe()).id;
  const me = await client.getChatMember(chat.id, botId).catch(() => null);
  if (!me || me.status !== 'administrator' || me.can_manage_topics === false) {
    return { ok: false, error: 'Jadikan bot admin grup ini dengan izin "Kelola topik" (Manage topics), lalu kirim /team lagi.' };
  }
  q.run('UPDATE telegram_settings SET team_chat_id = ?, team_title = ?, updated_at = ? WHERE id = 1', String(chat.id), chat.title || null, now());
  return { ok: true };
}

export function unlinkTeam() {
  q.run('UPDATE telegram_settings SET team_chat_id = NULL, team_title = NULL, updated_at = ? WHERE id = 1', now());
}

export function teamInfo() {
  const row = getTelegramRow();
  const chatId = row?.team_chat_id;
  if (!chatId) return null;
  const base = String(chatId).replace(/^-100/, '');
  const topics = q.all(
    `SELECT t.*, e.name AS employee_name, e.avatar, e.enabled FROM telegram_topics t LEFT JOIN employees e ON e.id = t.employee_id
     WHERE t.chat_id = ? ORDER BY t.kind = 'reports' DESC, t.id`, chatId
  ).map((t) => ({
    kind: t.kind, employee_id: t.employee_id, name: t.name, thread_id: t.thread_id, enabled: t.enabled !== 0,
    avatar: json(t.avatar, null), icon: t.employee_id ? personEmoji({ ...t, ...(getEmployee(t.employee_id) || {}) }) : '📊', link: `https://t.me/c/${base}/${t.thread_id}`,
  }));
  return {
    chat_id: chatId, title: row.team_title || null, topics, pending: pendingTopicChanges(chatId).length, syncing: Boolean(syncing),
    reports_here: row.chat_id === chatId && Boolean(row.report_thread_id) && reportsTopic(chatId)?.thread_id === row.report_thread_id,
  };
}

// ---------------- topic messages (rate limited queue) ----------------
const queue = [];
let sending = false;
function enqueue(threadId, html, type = 'team') {
  queue.push({ threadId, html, type });
  if (!sending) drain();
}
async function drain() {
  sending = true;
  while (queue.length) {
    const item = queue.shift();
    const chatId = teamChatId();
    const client = getClient();
    if (!chatId || !client) continue;
    try {
      for (const part of splitMessage(item.html)) {
        try {
          await client.sendMessage(chatId, part, { message_thread_id: item.threadId });
        } catch (e) {
          if (!/can't parse entities/i.test(e.message)) throw e;
          await client.call('sendMessage', { chat_id: chatId, message_thread_id: item.threadId, text: part.replace(/<[^>]+>/g, '') });
        }
      }
      recordMessage({ type: item.type, chatId, status: 'sent', message: item.html });
    } catch (e) {
      recordMessage({ type: item.type, chatId, status: 'failed', message: item.html, error: e.message });
      // Topic deleted in Telegram: forget it, the next sync creates a new one.
      if (/thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(e.message)) q.run('DELETE FROM telegram_topics WHERE chat_id = ? AND thread_id = ?', chatId, item.threadId);
    }
    await pause(3100); // a group may receive ~20 messages per minute
  }
  sending = false;
}

// ---------------- dashboard chat -> topics ----------------
let fromTelegram = false; // owner messages written in Telegram are not echoed back
const OUT_KINDS = { message: '', report: '📄 ', approval: '🔔 ', fail: '⚠️ ' };

function onChatMessage({ message }) {
  const chatId = teamChatId();
  if (!chatId) return;
  const m = q.get('SELECT * FROM chat_messages WHERE id = ?', message.id);
  if (!m) return;
  if (m.sender_type === 'owner') {
    if (fromTelegram || !m.recipient_employee_id || !['message', 'note'].includes(m.kind)) return;
    const t = topicOf(chatId, m.recipient_employee_id);
    if (t) enqueue(t.thread_id, `🖥 <i>${escapeHtml(m.sender_name)} (dashboard${m.kind === 'note' ? ', catatan' : ''}):</i>\n${escapeHtml(m.content)}`);
    return;
  }
  // Answers & reports addressed to the owner; agent-to-agent traffic stays in the dashboard.
  if (m.sender_type !== 'employee' || m.recipient_employee_id || !(m.kind in OUT_KINDS)) return;
  const e = getEmployee(m.sender_employee_id);
  const t = e && topicOf(chatId, e.id);
  if (!t) return;
  const ref = m.task_id && m.kind !== 'message' ? `\n<i>${code(m.task_id)}</i>` : '';
  enqueue(t.thread_id, `${speaker(e)}\n${OUT_KINDS[m.kind]}${mdToTelegram(m.content)}${ref}`);
}

// The employee starts working on a message from its topic: show "typing…" there.
function onTaskStarted({ task }) {
  const chatId = teamChatId();
  if (!chatId || !String(task.created_by || '').startsWith('chat:') || task.parent_id) return;
  const t = topicOf(chatId, task.employee_id);
  const client = getClient();
  if (t && client) client.call('sendChatAction', { chat_id: chatId, message_thread_id: t.thread_id, action: 'typing' }).catch(() => {});
}

const safe = (fn) => (p) => {
  try {
    fn(p);
  } catch {
    // never break the chat feed or the task queue
  }
};
const handlers = { 'chat:message': safe(onChatMessage), 'task:started': safe(onTaskStarted) };
export function startTeamBridge() {
  stopTeamBridge();
  for (const [ev, fn] of Object.entries(handlers)) bus.on(ev, fn);
}
export function stopTeamBridge() {
  for (const [ev, fn] of Object.entries(handlers)) bus.off(ev, fn);
}

// ---------------- topics -> employees ----------------
/**
 * A message in an employee's topic of the team group. Returns a reply text for the topic, or null when the message
 * is not for an employee topic (General / reports topic / other chats: normal command handling).
 */
export function handleTopicMessage(msg) {
  const chatId = teamChatId();
  if (!chatId || String(msg.chat?.id) !== chatId || !msg.is_topic_message) return null;
  const topic = topicByThread(chatId, msg.message_thread_id);
  if (!topic || topic.kind !== 'employee') return null;
  if (!allowedUserIds().includes(String(msg.from?.id))) return undefined; // not allowed: ignored silently
  const text = String(msg.text || '').trim();
  let mode = 'reply';
  let content = text;
  if (/^\/(tugas|task)(@\w+)?(\s|$)/i.test(text)) mode = 'task';
  else if (/^\/(catat|note)(@\w+)?(\s|$)/i.test(text)) mode = 'note';
  else if (text.startsWith('/')) return null; // other commands (/report, /status, …) are answered in this topic
  if (mode !== 'reply') content = text.replace(/^\/\w+(@\w+)?\s*/, '');
  const e = getEmployee(topic.employee_id);
  if (!e || !e.enabled) return `${e?.name || 'Karyawan ini'} sedang nonaktif.`;
  if (!content) return mode === 'task' ? 'Gunakan: /tugas <instruksi>' : 'Gunakan: /catat <teks>';
  fromTelegram = true;
  try {
    const r = sendOwnerMessage({ businessId: channelOf(e), content, recipientEmployeeId: e.id, mode, ownerName: msg.from?.first_name || 'Owner' });
    if (mode === 'note') return '📝 Dicatat (tanpa AI).';
    if (mode === 'task') return `📌 Tugas dibuat: <b>${r.task.code}</b>. Hasilnya saya laporkan di topik ini.`;
    return ''; // quick reply: the answer comes into this topic
  } catch (err) {
    return `Gagal mengirim ke ${escapeHtml(e.name)}: ${escapeHtml(err.message)}`;
  } finally {
    fromTelegram = false;
  }
}
