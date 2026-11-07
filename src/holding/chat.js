// Agent chat: a conversation feed built ONLY from real task events (no extra AI calls, no invented chatter),
// plus owner messages that can be plain notes or turn into real AI tasks whose results come back as replies.
import { q, now, json } from '../db/index.js';
import { bus } from '../events.js';
import { truncate } from '../lib/text.js';
import { getSetting } from '../lib/settings.js';
import { getTask } from '../queue/tasks.js';
import { getEmployee, getManager } from '../agents/employees.js';
import { getBusiness } from './businesses.js';
import { createOwnerTask } from './taskFactory.js';
import { computeOfficeState } from './officeState.js';
import { worker } from '../queue/worker.js';

const MAX_REPLY = 2000;
const CHAT_PREFIX = 'chat:';
const code = (id) => `T-${String(id).padStart(5, '0')}`;

function httpError(msg, codeNum = 400) {
  const e = new Error(msg);
  e.statusCode = codeNum;
  return e;
}

export function postMessage({
  businessId = null, senderType, senderEmployeeId = null, senderName, recipientEmployeeId = null, recipientName = null,
  taskId = null, kind = 'message', content,
}) {
  const r = q.run(
    `INSERT INTO chat_messages(business_id, sender_type, sender_employee_id, sender_name, recipient_employee_id, recipient_name,
       task_id, kind, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    businessId, senderType, senderEmployeeId, String(senderName || '-').slice(0, 80), recipientEmployeeId,
    recipientName ? String(recipientName).slice(0, 80) : null, taskId, kind, truncate(content, 4000), now()
  );
  const msg = { id: r.lastInsertRowid, business_id: businessId, sender_type: senderType, sender_employee_id: senderEmployeeId, kind };
  bus.emit('chat:message', { message: msg });
  return r.lastInsertRowid;
}

/**
 * businessId: undefined = all channels (holding view), null = HQ channel only, number = that business only.
 */
export function listMessages({ businessId, after = 0, before = null, limit = 60 } = {}) {
  const where = [];
  const vals = [];
  if (businessId !== undefined) {
    where.push('m.business_id IS ?');
    vals.push(businessId);
  }
  if (after) {
    where.push('m.id > ?');
    vals.push(after);
  }
  if (before) {
    where.push('m.id < ?');
    vals.push(before);
  }
  const rows = q.all(
    `SELECT m.*, e.avatar AS sender_avatar, e.role AS sender_role, b.name AS business_name, b.color AS business_color
     FROM chat_messages m LEFT JOIN employees e ON e.id = m.sender_employee_id LEFT JOIN businesses b ON b.id = m.business_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.id ${after ? 'ASC' : 'DESC'} LIMIT ?`,
    ...vals, limit
  );
  const list = after ? rows : rows.reverse();
  return list.map((m) => ({ ...m, sender_avatar: json(m.sender_avatar, null), task_code: m.task_id ? code(m.task_id) : null }));
}

// Employees currently running an AI call in this channel (real "typing" indicator).
export function typingIn(businessId) {
  const out = [];
  for (const r of worker.status().running) {
    const t = q.get('SELECT id, business_id, employee_id FROM tasks WHERE id = ?', r.taskId);
    if (!t) continue;
    if (businessId !== undefined && t.business_id !== businessId) continue;
    const e = getEmployee(t.employee_id);
    if (e) out.push({ employee_id: e.id, name: e.name, task_id: t.id });
  }
  return out;
}

export function clearMessages(businessId) {
  if (businessId === undefined) return q.run('DELETE FROM chat_messages').changes;
  return q.run('DELETE FROM chat_messages WHERE business_id IS ?', businessId).changes;
}

// ---------------- owner messages ----------------
function defaultRecipient(businessId) {
  if (businessId) {
    const b = getBusiness(businessId);
    const bm = b?.manager_employee_id ? getEmployee(b.manager_employee_id) : null;
    if (bm?.enabled) return bm;
  }
  return getManager();
}

function slashCommand(text, businessId) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  const states = computeOfficeState();
  const scope = (e) => businessId === null || businessId === undefined || e.business_ids.includes(businessId) || e.manages_business_id === businessId || e.task?.business_id === businessId;
  if (cmd === '/help') {
    return [
      'Perintah obrolan:',
      '/status: status antrean & tugas aktif',
      '/agents: siapa yang sedang bekerja',
      '/help: bantuan ini',
      'Mode pesan: "Balasan cepat" = 1 panggilan AI ke penerima; "Tugas penuh" = orkestrasi CEO/Business Manager; "Catatan" = tanpa AI.',
    ].join('\n');
  }
  if (cmd === '/agents') {
    const busy = states.filter((e) => scope(e) && ['thinking', 'working', 'meeting'].includes(e.state));
    if (!busy.length) return 'Tidak ada agen yang sedang memanggil AI saat ini.';
    return busy.map((e) => `${e.name} (${e.role.split(' — ')[0]}): ${e.state}${e.task ? ` · ${code(e.task.id)} ${e.task.title}` : ''}`).join('\n');
  }
  if (cmd === '/status') {
    const w = businessId ? 'AND business_id = ?' : '';
    const vals = businessId ? [businessId] : [];
    const c = q.get(`SELECT SUM(status IN ('pending','assigned')) waiting, SUM(status='processing') processing FROM tasks WHERE 1=1 ${w}`, ...vals);
    return `Antrean ${getSetting('queue_paused') ? 'DIJEDA' : 'berjalan'} · menunggu ${c.waiting || 0} · diproses ${c.processing || 0} · agen aktif ${states.filter((e) => scope(e) && ['thinking', 'working', 'meeting'].includes(e.state)).length}`;
  }
  return `Perintah tidak dikenal: ${cmd}. Ketik /help.`;
}

/**
 * mode: 'note'  -> stored only, no AI
 *       'reply' -> one direct AI task for the recipient; the answer is posted back as a chat reply
 *       'task'  -> full orchestration (Group CEO -> holding task, Business Manager -> business task, others -> direct)
 */
export function sendOwnerMessage({ businessId = null, content, recipientEmployeeId = null, mode = 'reply', ownerName = 'owner' }) {
  const text = String(content || '').trim();
  if (!text) throw httpError('Pesan kosong');
  if (businessId) {
    const b = getBusiness(businessId);
    if (!b) throw httpError('Bisnis tidak ditemukan', 404);
    if (b.status !== 'active' && mode !== 'note') throw httpError(`Bisnis ${b.name} sedang nonaktif`);
  }
  if (text.startsWith('/')) {
    const ownerId = postMessage({ businessId, senderType: 'owner', senderName: ownerName, kind: 'command', content: text });
    postMessage({ businessId, senderType: 'system', senderName: 'Sistem', kind: 'system', content: slashCommand(text, businessId) });
    return { message_id: ownerId, task: null };
  }
  const recipient = recipientEmployeeId ? getEmployee(recipientEmployeeId) : defaultRecipient(businessId);
  if (!recipient) throw httpError('Penerima tidak ditemukan', 404);
  if (mode === 'note') {
    const id = postMessage({ businessId, senderType: 'owner', senderName: ownerName, recipientEmployeeId: recipient.id, recipientName: recipient.name, kind: 'note', content: text });
    return { message_id: id, task: null };
  }
  const title = truncate(text.split('\n')[0], 120);
  // Store the owner's message first: the queue may pick the task up synchronously and the agent's
  // "started" message must appear after the owner's message.
  const id = postMessage({
    businessId, senderType: 'owner', senderName: ownerName, recipientEmployeeId: recipient.id,
    recipientName: recipient.name, kind: 'message', content: text,
  });
  let task;
  try {
    if (mode === 'task' && recipient.is_manager) {
      task = createOwnerTask({ mode: 'holding', title, description: text, businessId, createdBy: `${CHAT_PREFIX}${ownerName}` });
    } else if (mode === 'task' && businessId && getBusiness(businessId)?.manager_employee_id === recipient.id) {
      task = createOwnerTask({ mode: 'business', title, description: text, businessId, createdBy: `${CHAT_PREFIX}${ownerName}` });
    } else {
      const description = mode === 'reply'
        ? `${text}\n\n(Pesan obrolan dari owner. Balas langsung seperti pesan chat: ringkas, jelas, maksimal ±150 kata, kecuali owner meminta dokumen atau laporan lengkap.)`
        : text;
      task = createOwnerTask({ mode: 'direct', title, description, businessId, employeeId: recipient.id, createdBy: `${CHAT_PREFIX}${ownerName}` });
    }
  } catch (e) {
    q.run('DELETE FROM chat_messages WHERE id = ?', id); // nothing was sent: do not keep a message that has no task
    throw e;
  }
  q.run('UPDATE chat_messages SET task_id = ?, business_id = ? WHERE id = ?', task.id, task.business_id ?? businessId, id);
  return { message_id: id, task: { id: task.id, code: code(task.id), kind: task.kind } };
}

// ---------------- feed from real task events ----------------
const emp = (id) => (id ? getEmployee(id) : null);
const fromChat = (t) => String(t.created_by || '').startsWith(CHAT_PREFIX);
const ownerOf = (t) => (fromChat(t) ? String(t.created_by).slice(CHAT_PREFIX.length) : 'Owner');

function excerpt(text, max = 320) {
  const s = String(text || '');
  const m = s.match(/##\s*Ringkasan[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  return truncate((m ? m[1] : s).replace(/```[\s\S]*?```/g, '[kode]').trim(), max);
}

function say(task, e, extra) {
  if (!e) return;
  postMessage({ businessId: task.business_id ?? null, senderType: 'employee', senderEmployeeId: e.id, senderName: e.name, taskId: task.id, ...extra });
}

function onCreated({ task }) {
  if (!task.parent_id) return;
  const parent = getTask(task.parent_id);
  const from = emp(parent?.employee_id);
  const to = emp(task.employee_id);
  if (!from || !to) return;
  const where = task.business_id && task.business_id !== parent.business_id ? ` untuk ${getBusiness(task.business_id)?.name || 'bisnis'}` : '';
  say(task, from, { recipientEmployeeId: to.id, recipientName: to.name, kind: 'assign', content: `@${to.name} tolong kerjakan${where}: ${task.title}` });
}

function onStarted({ task }) {
  const e = emp(task.employee_id);
  const content =
    task.kind === 'instruction' ? `Saya menganalisis instruksi "${task.title}" dan menentukan siapa yang mengerjakan.`
      : task.kind === 'business' ? `Menyusun rencana kerja untuk "${task.title}".`
        : `Mulai mengerjakan "${task.title}".`;
  say(task, e, { kind: 'start', content });
}

function onSynthesizing({ task }) {
  const e = emp(task.employee_id);
  const kids = q.all('SELECT DISTINCT e.name FROM tasks t JOIN employees e ON e.id = t.employee_id WHERE t.parent_id = ?', task.id).map((r) => r.name);
  say(task, e, { kind: 'meeting', content: `Semua hasil sudah masuk${kids.length ? ` dari ${kids.join(', ')}` : ''}. Saya gabungkan dalam rapat untuk "${task.title}".` });
}

function onCompleted({ task }) {
  const e = emp(task.employee_id);
  if (!e) return;
  const parent = task.parent_id ? getTask(task.parent_id) : null;
  const boss = parent ? emp(parent.employee_id) : null;
  if (!parent && fromChat(task) && task.kind === 'direct') {
    // Chat reply to the owner: the actual AI answer.
    say(task, e, { recipientName: ownerOf(task), kind: 'message', content: truncate(task.result, MAX_REPLY) });
    return;
  }
  if (task.kind === 'subtask') {
    say(task, e, { recipientEmployeeId: boss?.id ?? null, recipientName: boss?.name ?? null, kind: 'done', content: `${boss ? `@${boss.name} ` : ''}Selesai: ${task.title}\n${excerpt(task.result, 280)}` });
  } else if (task.kind === 'business') {
    const to = boss ? { recipientEmployeeId: boss.id, recipientName: boss.name } : { recipientName: ownerOf(task) };
    say(task, e, { ...to, kind: 'report', content: `${boss ? `@${boss.name} ` : ''}Laporan bisnis siap: ${task.title}\n${excerpt(task.result)}` });
  } else {
    say(task, e, { recipientName: ownerOf(task), kind: 'report', content: `Selesai: ${task.title}\n${excerpt(task.result, 600)}` });
  }
}

function onFailed({ task, error }) {
  const e = emp(task.employee_id);
  const parent = task.parent_id ? getTask(task.parent_id) : null;
  const boss = parent ? emp(parent.employee_id) : null;
  say(task, e, { recipientEmployeeId: boss?.id ?? null, recipientName: boss?.name ?? ownerOf(task), kind: 'fail', content: `Gagal: ${task.title}\n${truncate(error || task.error || '', 300)}` });
}

function onPostponed({ task, error }) {
  postMessage({ businessId: task.business_id ?? null, senderType: 'system', senderName: 'Sistem', taskId: task.id, kind: 'system', content: `${code(task.id)} "${task.title}" ditunda karena AI belum tersedia; akan dicoba lagi otomatis. ${truncate(error || '', 200)}` });
}

function onApproval({ task, items }) {
  const e = emp(getTask(task.id)?.employee_id);
  say(task, e, { recipientName: 'Owner', kind: 'approval', content: `Butuh persetujuan owner:\n${items.map((i) => `• ${i}`).join('\n')}` });
}

const handlers = {
  'task:created': onCreated,
  'task:started': onStarted,
  'task:synthesizing': onSynthesizing,
  'task:completed': onCompleted,
  'task:failed': onFailed,
  'task:postponed': onPostponed,
  'approval:created': onApproval,
};
const safe = (fn) => (payload) => {
  try {
    fn(payload);
  } catch {
    // The chat feed must never break task processing.
  }
};
const bound = Object.fromEntries(Object.entries(handlers).map(([k, fn]) => [k, safe(fn)]));

export function startChatFeed() {
  stopChatFeed();
  for (const [ev, fn] of Object.entries(bound)) bus.on(ev, fn);
}

export function stopChatFeed() {
  for (const [ev, fn] of Object.entries(bound)) bus.off(ev, fn);
}
