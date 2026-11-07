// Visual state of every employee for the pixel office, derived ONLY from real task/queue data.
// No state is invented: an employee is shown thinking/working/meeting only while the queue is actually running
// an AI call for them (or for a task whose results they contributed to).
import { q, json } from '../db/index.js';
import { worker } from '../queue/worker.js';

export const COMPLETED_WINDOW_MS = 15_000;
export const ERROR_WINDOW_MS = 30 * 60_000;

export function computeOfficeState(now = Date.now()) {
  const running = worker.status().running;
  const runningIds = new Set(running.map((r) => r.employeeId));
  const live = new Map(); // employeeId -> { state, task, meeting, visiting }

  for (const r of running) {
    const t = q.get('SELECT id, kind, phase, title, employee_id, business_id FROM tasks WHERE id = ?', r.taskId);
    if (!t) continue;
    const task = { id: t.id, title: t.title, kind: t.kind, phase: t.phase, business_id: t.business_id };
    if (t.phase === 'planning') {
      live.set(t.employee_id, { state: 'thinking', task });
    } else if (t.phase === 'synthesizing') {
      // Leader consolidates results: leader + contributors who are not busy elsewhere meet.
      const where = t.kind === 'instruction' ? { scope: 'hq', business_id: null } : { scope: 'business', business_id: t.business_id };
      const meeting = { task_id: t.id, kind: t.kind, ...where };
      live.set(t.employee_id, { state: 'meeting', task, meeting: { ...meeting, leader: true } });
      for (const c of q.all('SELECT DISTINCT employee_id FROM tasks WHERE parent_id = ? AND employee_id IS NOT NULL', t.id)) {
        if (!runningIds.has(c.employee_id) && !live.has(c.employee_id)) live.set(c.employee_id, { state: 'meeting', task, meeting: { ...meeting, leader: false } });
      }
    } else {
      live.set(t.employee_id, { state: 'working', task, visiting: t.business_id });
    }
  }

  const rows = q.all(
    `SELECT e.id, e.name, e.role, e.role_key, e.org_unit, e.avatar, e.enabled, e.is_manager, e.desk_index,
       (SELECT COUNT(*) FROM tasks t WHERE t.employee_id = e.id AND t.status IN ('pending','assigned')) AS waiting,
       (SELECT COUNT(*) FROM tasks t WHERE t.employee_id = e.id AND t.status = 'pending' AND t.attempts > 0) AS postponed,
       (SELECT MIN(next_attempt_at) FROM tasks t WHERE t.employee_id = e.id AND t.status = 'pending' AND t.attempts > 0) AS next_retry,
       (SELECT MAX(completed_at) FROM tasks t WHERE t.employee_id = e.id AND t.status = 'completed') AS last_done,
       (SELECT MAX(completed_at) FROM tasks t WHERE t.employee_id = e.id AND t.status = 'failed') AS last_failed
     FROM employees e ORDER BY e.desk_index, e.id`
  );
  const membership = new Map();
  for (const m of q.all('SELECT employee_id, business_id FROM business_employees ORDER BY business_id')) {
    if (!membership.has(m.employee_id)) membership.set(m.employee_id, []);
    membership.get(m.employee_id).push(m.business_id);
  }
  const manages = new Map(q.all('SELECT id, manager_employee_id FROM businesses WHERE manager_employee_id IS NOT NULL').map((b) => [b.manager_employee_id, b.id]));
  const lastTask = (id, status) =>
    q.get(`SELECT id, title, kind, business_id, error FROM tasks WHERE employee_id = ? AND status = ? ORDER BY completed_at DESC LIMIT 1`, id, status);

  return rows.map((e) => {
    const l = live.get(e.id);
    let state = l?.state;
    let task = l?.task || null;
    let reason = null;
    if (!state) {
      if (!e.enabled) state = 'off';
      else if (e.postponed > 0) {
        state = 'error';
        reason = `Tugas tertunda: AI tidak tersedia${e.next_retry ? `, dicoba lagi ${new Date(e.next_retry).toISOString()}` : ''}`;
      } else if (e.last_failed && now - e.last_failed < ERROR_WINDOW_MS && (!e.last_done || e.last_failed > e.last_done)) {
        state = 'error';
        const f = lastTask(e.id, 'failed');
        task = f ? { id: f.id, title: f.title, kind: f.kind, business_id: f.business_id } : null;
        reason = f?.error ? `Tugas gagal: ${String(f.error).slice(0, 160)}` : 'Tugas gagal';
      } else if (e.last_done && now - e.last_done < COMPLETED_WINDOW_MS) {
        state = 'completed';
        const d = lastTask(e.id, 'completed');
        task = d ? { id: d.id, title: d.title, kind: d.kind, business_id: d.business_id } : null;
      } else if (e.waiting > 0) state = 'pending';
      else state = 'idle';
    }
    const businessIds = membership.get(e.id) || [];
    return {
      id: e.id,
      name: e.name,
      role: e.role,
      role_key: e.role_key,
      org_unit: e.org_unit,
      is_manager: Boolean(e.is_manager),
      avatar: json(e.avatar, {}),
      desk_index: e.desk_index,
      business_ids: businessIds,
      manages_business_id: manages.get(e.id) ?? null,
      // v1 field kept for compatibility: first business of business-unit staff.
      home_business_id: e.org_unit === 'business' ? businessIds[0] ?? null : null,
      state,
      reason,
      waiting: e.waiting,
      task,
      meeting: l?.meeting || null,
      visiting_business_id: e.org_unit === 'shared' && l?.state === 'working' ? l.visiting ?? null : null,
    };
  });
}
