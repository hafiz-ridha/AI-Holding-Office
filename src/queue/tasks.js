// Task persistence & state transitions. All status changes go through here so events and parents stay consistent.
import { q, tx, now, json } from '../db/index.js';
import { truncate } from '../lib/text.js';
import { bus } from '../events.js';

export const STATUSES = ['pending', 'assigned', 'processing', 'completed', 'failed', 'cancelled'];
export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const PRIORITY = { low: 1, normal: 2, high: 3, urgent: 4 };

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

export function getTask(id) {
  return q.get('SELECT * FROM tasks WHERE id = ?', id);
}

// Activity log; inherits the task's business_id so per-business activity can be listed without joins.
export function logTask(taskId, event, message = null, level = 'info') {
  q.run(
    `INSERT INTO task_logs(task_id, business_id, level, event, message, created_at)
     VALUES (?, (SELECT business_id FROM tasks WHERE id = ?), ?, ?, ?, ?)`,
    taskId,
    taskId,
    level,
    event,
    message ? truncate(message, 2000) : null,
    now()
  );
}

// Kinds: instruction (holding task, Group CEO) | business (business task, Business Manager)
//        | subtask (employee subtask) | direct (single employee task created by the owner).
export const PLANNED_KINDS = new Set(['instruction', 'business']);
const LEVEL = { instruction: 'holding', business: 'business', subtask: 'employee', direct: 'employee' };

export function createTask({
  kind, title, description = '', createdBy = 'owner', employeeId, priority = 2, parentId = null, status,
  businessId = null, managerEmployeeId = null,
}) {
  const t = now();
  const phase = PLANNED_KINDS.has(kind) ? 'planning' : null;
  const st = status || (kind === 'instruction' ? 'pending' : 'assigned');
  const r = q.run(
    `INSERT INTO tasks(parent_id, kind, phase, level, business_id, manager_employee_id, title, description, created_by,
       employee_id, priority, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    parentId,
    kind,
    phase,
    LEVEL[kind] || 'employee',
    businessId,
    managerEmployeeId,
    truncate(title, 200),
    truncate(description, 20000),
    createdBy,
    employeeId,
    priority,
    st,
    t,
    t
  );
  const task = getTask(r.lastInsertRowid);
  logTask(task.id, 'created', `${kind} dibuat oleh ${createdBy}`);
  bus.emit('task:created', { task });
  bus.emit('queue:wake');
  return task;
}

// Atomically claim the next runnable task. Excludes employees already busy so one character = one desk.
export function claimNext(busyEmployeeIds = []) {
  return tx(() => {
    const busy = busyEmployeeIds.length ? `AND t.employee_id NOT IN (${busyEmployeeIds.map(() => '?').join(',')})` : '';
    const row = q.get(
      `SELECT t.id FROM tasks t JOIN employees e ON e.id = t.employee_id
       WHERE t.status IN ('pending','assigned') AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ?)
         AND e.enabled = 1 ${busy}
       ORDER BY t.priority DESC, COALESCE(t.parent_id, t.id) ASC, t.id ASC LIMIT 1`,
      now(),
      ...busyEmployeeIds
    );
    if (!row) return null;
    const t = now();
    q.run(
      `UPDATE tasks SET status = 'processing', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
      t,
      t,
      row.id
    );
    return getTask(row.id);
  });
}

export function addUsageToTask(taskId, r) {
  q.run(
    `UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, tokens_estimated = tokens_estimated + ?,
       cost_usd = cost_usd + ?, provider_name = ?, model_used = ?, updated_at = ? WHERE id = ?`,
    r.tokensIn,
    r.tokensOut,
    r.estimated ? r.tokensIn + r.tokensOut : 0,
    r.costUsd || 0,
    r.providerName,
    r.model,
    now(),
    taskId
  );
}

export function saveConversation(taskId, employeeId, prompt, response, r, businessId = null) {
  const t = now();
  const sql = `INSERT INTO conversations(task_id, employee_id, business_id, role, content, provider, model, created_at)
               VALUES (?,?,?,?,?,?,?,?)`;
  q.run(sql, taskId, employeeId, businessId, 'user', truncate(prompt, 20000), r?.providerName ?? null, r?.model ?? null, t);
  if (response !== null) {
    q.run(sql, taskId, employeeId, businessId, 'assistant', truncate(response, 40000), r?.providerName ?? null, r?.model ?? null, t);
  }
}

export function completeTask(task, result) {
  const t = now();
  const changed = q.run(
    `UPDATE tasks SET status = 'completed', phase = CASE WHEN kind IN ('instruction','business') THEN 'done' ELSE phase END,
       result = ?, error = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'`,
    truncate(result, 60000),
    t,
    t,
    task.id
  );
  if (!changed.changes) return getTask(task.id); // cancelled meanwhile
  logTask(task.id, 'completed', 'Tugas selesai');
  const updated = getTask(task.id);
  bus.emit('task:completed', { task: updated });
  if (updated.parent_id) checkParent(updated.parent_id);
  return updated;
}

export function failTask(task, error) {
  const t = now();
  const changed = q.run(
    `UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'`,
    truncate(error, 2000),
    t,
    t,
    task.id
  );
  if (!changed.changes) return getTask(task.id);
  logTask(task.id, 'failed', error, 'error');
  const updated = getTask(task.id);
  bus.emit('task:failed', { task: updated, error });
  if (updated.parent_id) checkParent(updated.parent_id);
  return updated;
}

// All providers failed / quota reached: back to pending with a delay; give up after max attempts.
export function postponeTask(task, error, { maxAttempts, delayMinutes }) {
  const attempts = task.attempts + 1;
  if (attempts >= maxAttempts) {
    q.run('UPDATE tasks SET attempts = ? WHERE id = ?', attempts, task.id);
    return failTask({ ...task, attempts }, `Gagal setelah ${attempts} percobaan: ${error}`);
  }
  const next = now() + delayMinutes * 60_000 * attempts;
  q.run(
    `UPDATE tasks SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'processing'`,
    attempts,
    next,
    truncate(error, 2000),
    now(),
    task.id
  );
  logTask(task.id, 'postponed', `Percobaan ${attempts}/${maxAttempts} gagal, dijadwalkan ulang ${new Date(next).toISOString()}: ${error}`, 'warn');
  const updated = getTask(task.id);
  bus.emit('task:postponed', { task: updated, error });
  return updated;
}

// Called whenever a subtask reaches a terminal state.
export function checkParent(parentId) {
  const root = getTask(parentId);
  if (!root || root.status !== 'processing' || root.phase !== 'executing') return;
  const kids = q.all('SELECT status FROM tasks WHERE parent_id = ?', parentId);
  if (!kids.length || kids.some((k) => !TERMINAL.has(k.status))) return;
  if (kids.some((k) => k.status === 'completed')) {
    q.run(`UPDATE tasks SET phase = 'synthesizing', status = 'assigned', updated_at = ? WHERE id = ?`, now(), parentId);
    logTask(parentId, 'synthesizing', root.kind === 'business' ? 'Subtugas selesai, Business Manager menyusun laporan' : 'Semua tugas turunan selesai, Group CEO menggabungkan hasil');
    bus.emit('queue:wake');
  } else {
    failTask(root, 'Semua subtugas gagal atau dibatalkan');
  }
}

export function setPhase(taskId, phase, status = null) {
  if (status) q.run('UPDATE tasks SET phase = ?, status = ?, updated_at = ? WHERE id = ?', phase, status, now(), taskId);
  else q.run('UPDATE tasks SET phase = ?, updated_at = ? WHERE id = ?', phase, now(), taskId);
}

export function savePlan(taskId, plan) {
  q.run('UPDATE tasks SET plan = ?, updated_at = ? WHERE id = ?', JSON.stringify(plan), now(), taskId);
}

export function cancelTask(id, by = 'owner') {
  const task = getTask(id);
  if (!task) throw httpError('Tugas tidak ditemukan', 404);
  if (TERMINAL.has(task.status)) throw httpError('Tugas sudah berakhir');
  // Cancel the task and every unfinished descendant (holding -> business -> subtask).
  const ids = [
    id,
    ...q
      .all(
        `WITH RECURSIVE d(id) AS (SELECT id FROM tasks WHERE parent_id = ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
         SELECT tasks.id FROM tasks JOIN d ON d.id = tasks.id WHERE tasks.status NOT IN ('completed','failed','cancelled')`,
        id
      )
      .map((r) => r.id),
  ];
  const t = now();
  tx(() => {
    for (const tid of ids) {
      q.run(`UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?`, t, t, tid);
      logTask(tid, 'cancelled', `Dibatalkan oleh ${by}`, 'warn');
    }
  });
  for (const tid of ids) bus.emit('task:cancelled', { task: getTask(tid) });
  if (task.parent_id) checkParent(task.parent_id);
  return { cancelled: ids };
}

export function retryTask(id) {
  const task = getTask(id);
  if (!task) throw httpError('Tugas tidak ditemukan', 404);
  const t = now();
  if (task.status === 'pending' || task.status === 'assigned') {
    q.run('UPDATE tasks SET next_attempt_at = NULL, updated_at = ? WHERE id = ?', t, id);
    logTask(id, 'retry', 'Dijalankan sekarang oleh admin');
    bus.emit('queue:wake');
    return getTask(id);
  }
  if (!['failed', 'cancelled'].includes(task.status)) throw httpError('Hanya tugas gagal/dibatalkan/tertunda yang dapat diulang');
  tx(() => {
    if (PLANNED_KINDS.has(task.kind)) {
      const kids = q.all('SELECT id, status FROM tasks WHERE parent_id = ?', id);
      if (!kids.length) {
        q.run(`UPDATE tasks SET status='pending', phase='planning', attempts=0, next_attempt_at=NULL, error=NULL, completed_at=NULL, updated_at=? WHERE id=?`, t, id);
      } else {
        const redo = kids.filter((k) => k.status === 'failed' || k.status === 'cancelled');
        for (const k of redo) {
          q.run(`UPDATE tasks SET status='assigned', attempts=0, next_attempt_at=NULL, error=NULL, completed_at=NULL, updated_at=? WHERE id=?`, t, k.id);
          logTask(k.id, 'retry', 'Diulang bersama instruksi induk');
        }
        if (redo.length) {
          q.run(`UPDATE tasks SET status='processing', phase='executing', attempts=0, error=NULL, completed_at=NULL, updated_at=? WHERE id=?`, t, id);
        } else {
          q.run(`UPDATE tasks SET status='assigned', phase='synthesizing', attempts=0, next_attempt_at=NULL, error=NULL, completed_at=NULL, updated_at=? WHERE id=?`, t, id);
        }
      }
    } else {
      q.run(`UPDATE tasks SET status='assigned', attempts=0, next_attempt_at=NULL, error=NULL, completed_at=NULL, updated_at=? WHERE id=?`, t, id);
    }
    // Re-open finished ancestors so results flow back up the hierarchy again.
    let pid = task.parent_id;
    while (pid) {
      const parent = getTask(pid);
      if (!parent || !TERMINAL.has(parent.status)) break;
      q.run(`UPDATE tasks SET status='processing', phase='executing', error=NULL, completed_at=NULL, updated_at=? WHERE id=?`, t, parent.id);
      logTask(parent.id, 'retry', `Dibuka kembali karena tugas turunan #${id} diulang`);
      pid = parent.parent_id;
    }
    logTask(id, 'retry', 'Diulang oleh admin');
  });
  bus.emit('queue:wake');
  return getTask(id);
}

// After a restart: tasks that were mid-AI-call are re-queued; waiting parents are re-checked.
export function recoverInterrupted() {
  const stuck = q.all(`SELECT * FROM tasks WHERE status = 'processing'`);
  let n = 0;
  for (const t of stuck) {
    if (PLANNED_KINDS.has(t.kind) && t.phase === 'executing') {
      checkParent(t.id);
      continue;
    }
    q.run(`UPDATE tasks SET status = 'assigned', updated_at = ? WHERE id = ?`, now(), t.id);
    logTask(t.id, 'recovered', 'Dijadwalkan ulang setelah aplikasi restart', 'warn');
    n++;
  }
  return n;
}

export function taskPublic(t, extra = {}) {
  if (!t) return null;
  return {
    id: t.id,
    code: `T-${String(t.id).padStart(5, '0')}`,
    parent_id: t.parent_id,
    kind: t.kind,
    level: t.level,
    phase: t.phase,
    business_id: t.business_id,
    manager_employee_id: t.manager_employee_id,
    title: t.title,
    description: t.description,
    input: t.description,
    output: t.result,
    created_by: t.created_by,
    employee_id: t.employee_id,
    priority: t.priority,
    status: t.status,
    attempts: t.attempts,
    next_attempt_at: t.next_attempt_at,
    started_at: t.started_at,
    completed_at: t.completed_at,
    result: t.result,
    plan: json(t.plan, null),
    error: t.error,
    provider_name: t.provider_name,
    model_used: t.model_used,
    tokens_in: t.tokens_in,
    tokens_out: t.tokens_out,
    tokens_estimated: t.tokens_estimated,
    cost_usd: t.cost_usd,
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...extra,
  };
}
