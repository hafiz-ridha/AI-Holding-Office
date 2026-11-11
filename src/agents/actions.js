// Actions the AI asked for with an important tool run only here, after the owner approved them (dashboard →
// Approvals). The approval is claimed atomically (no double runs), the tool and its arguments are checked again,
// and the outcome is stored on the approval, logged on the task and announced (chat + Telegram).
import { q, now, json } from '../db/index.js';
import { truncate } from '../lib/text.js';
import { bus } from '../events.js';
import { logTask, getTask } from '../queue/tasks.js';
import { getEmployee } from './employees.js';
import { isConnected, PROVIDERS } from '../connections/store.js';
import { getTool, validateArgs } from './tools/index.js';

const getApproval = (id) => q.get('SELECT * FROM approvals WHERE id = ?', id) || null;

export async function runApprovedAction(id) {
  const claimed = q.run(
    "UPDATE approvals SET action_status = 'running', action_at = ? WHERE id = ? AND status = 'approved' AND action IS NOT NULL AND action_status IN ('waiting', 'failed')",
    now(), id
  ).changes;
  if (!claimed) return getApproval(id);
  const a = getApproval(id);
  const act = json(a.action, {}) || {};
  const task = a.task_id ? getTask(a.task_id) : null;
  const employee = act.employee_id ? getEmployee(act.employee_id) : null;
  let ok = false;
  let result;
  try {
    const tool = getTool(act.tool);
    if (!tool) throw new Error(`alat "${act.tool}" tidak dikenal`);
    if (tool.connector && !isConnected(tool.connector)) throw new Error(`${PROVIDERS[tool.connector] || tool.connector} belum terhubung (dashboard → Koneksi)`);
    const v = validateArgs(tool, act.args);
    if (!v.ok) throw new Error(v.error);
    const out = await tool.run({ task: task || { id: null, business_id: a.business_id }, employee, businessId: a.business_id ?? null, draft: '' }, v.args);
    result = out.text || out.summary || 'Selesai';
    ok = true;
  } catch (e) {
    result = e.message;
  }
  q.run('UPDATE approvals SET action_status = ?, action_result = ?, action_at = ? WHERE id = ?', ok ? 'done' : 'failed', truncate(result, 2000), now(), id);
  if (task) logTask(task.id, ok ? 'action_done' : 'action_failed', `#${id} ${truncate(result, 500)}`, ok ? 'info' : 'warn');
  const approval = getApproval(id);
  bus.emit('action:finished', { approval, ok, result, task, employee });
  return approval;
}
