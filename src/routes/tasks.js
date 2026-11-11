import { artifactsForTask } from '../connections/artifacts.js';
import { q } from '../db/index.js';
import { getTask, taskPublic, cancelTask, retryTask, STATUSES } from '../queue/tasks.js';
import { createOwnerTask } from '../holding/taskFactory.js';
import { auditReq } from '../lib/audit.js';
import { idParam, body, str, nullableInt, httpError } from './schemas.js';

const KINDS = ['instruction', 'business', 'subtask', 'direct'];

export default async function taskRoutes(app) {
  app.get(
    '/api/tasks',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: [...STATUSES, 'active', ''] },
            employee_id: { type: 'integer' },
            business_id: { type: 'string', pattern: '^(\\d+|holding|)$' },
            kind: { type: 'string', enum: [...KINDS, 'top', ''] },
            recurring_id: { type: 'integer', minimum: 1 },
            q: str(100),
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          },
        },
      },
    },
    async (req) => {
      const { status, employee_id, business_id, kind, q: search, page, limit, recurring_id } = req.query;
      const where = [];
      const vals = [];
      if (status === 'active') where.push("t.status IN ('pending','assigned','processing')");
      else if (status) {
        where.push('t.status = ?');
        vals.push(status);
      }
      if (employee_id) {
        where.push('t.employee_id = ?');
        vals.push(employee_id);
      }
      if (business_id === 'holding') where.push('t.business_id IS NULL');
      else if (business_id) {
        where.push('t.business_id = ?');
        vals.push(Number(business_id));
      }
      if (recurring_id) {
        where.push('t.recurring_id = ?');
        vals.push(recurring_id);
      }
      if (kind === 'top') where.push('t.parent_id IS NULL');
      else if (kind) {
        where.push('t.kind = ?');
        vals.push(kind);
      }
      if (search) {
        where.push('(t.title LIKE ? OR t.description LIKE ?)');
        vals.push(`%${search}%`, `%${search}%`);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = q.get(`SELECT COUNT(*) n FROM tasks t ${w}`, ...vals).n;
      const rows = q.all(
        `SELECT t.*, e.name AS employee_name, e.role AS employee_role, b.name AS business_name, b.color AS business_color,
           (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS child_count
         FROM tasks t LEFT JOIN employees e ON e.id = t.employee_id LEFT JOIN businesses b ON b.id = t.business_id
         ${w} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
        ...vals, limit, (page - 1) * limit
      );
      return {
        total,
        page,
        items: rows.map((t) =>
          taskPublic({ ...t, result: t.result ? t.result.slice(0, 300) : null }, {
            employee_name: t.employee_name, employee_role: t.employee_role, business_name: t.business_name,
            business_color: t.business_color, child_count: t.child_count,
          })
        ),
      };
    }
  );

  app.post(
    '/api/tasks',
    {
      schema: {
        body: body(
          {
            mode: { type: 'string', enum: ['holding', 'business', 'direct'] },
            title: str(200, 3),
            description: str(20000),
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
            business_id: nullableInt,
            employee_id: nullableInt,
          },
          ['mode', 'title']
        ),
      },
    },
    async (req, reply) => {
      const t = createOwnerTask({
        mode: req.body.mode, title: req.body.title.trim(), description: req.body.description || '',
        priority: req.body.priority || 'normal', businessId: req.body.business_id ?? null, employeeId: req.body.employee_id ?? null,
        createdBy: `owner:${req.user.username}`,
      });
      auditReq(req, 'task_created', `T-${t.id}`, { mode: req.body.mode }, t.business_id);
      return reply.code(201).send(taskPublic(t));
    }
  );

  app.get('/api/tasks/:id', { schema: { params: idParam } }, async (req) => {
    const t = getTask(req.params.id);
    if (!t) throw httpError('Tugas tidak ditemukan', 404);
    const emp = t.employee_id ? q.get('SELECT id, name, role FROM employees WHERE id = ?', t.employee_id) : null;
    const biz = t.business_id ? q.get('SELECT id, name, slug, color FROM businesses WHERE id = ?', t.business_id) : null;
    const children = q.all(
      `SELECT t.id, t.kind, t.title, t.status, t.phase, t.business_id, t.employee_id, e.name AS employee_name, b.name AS business_name,
         (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS child_count
       FROM tasks t LEFT JOIN employees e ON e.id = t.employee_id LEFT JOIN businesses b ON b.id = t.business_id
       WHERE t.parent_id = ? ORDER BY t.id`,
      t.id
    ).map((c) => ({ ...c, code: `T-${String(c.id).padStart(5, '0')}` }));
    const parent = t.parent_id ? q.get('SELECT id, title, kind FROM tasks WHERE id = ?', t.parent_id) : null;
    return {
      task: taskPublic(t),
      employee: emp,
      business: biz,
      parent: parent ? { ...parent, code: `T-${String(parent.id).padStart(5, '0')}` } : null,
      children,
      logs: q.all('SELECT level, event, message, created_at FROM task_logs WHERE task_id = ? ORDER BY id', t.id),
      conversations: q.all(
        'SELECT c.role, c.content, c.provider, c.model, c.created_at, e.name AS employee FROM conversations c LEFT JOIN employees e ON e.id = c.employee_id WHERE c.task_id = ? ORDER BY c.id',
        t.id
      ),
      usage: q.all('SELECT provider_name, model, purpose, ok, http_status, error, tokens_in, tokens_out, estimated, cost_usd, latency_ms, created_at FROM usage_logs WHERE task_id = ? ORDER BY id', t.id),
      approvals: q.all('SELECT id, detail, status, decided_at, action IS NOT NULL AS is_action, action_status, action_result FROM approvals WHERE task_id = ?', t.id),
      files: artifactsForTask(t.id),
      agent_steps: q.all("SELECT level, event, message, created_at FROM task_logs WHERE task_id = ? AND event IN ('tool_call','tool_result','tool_error','tool_limit','approval_requested','action_done','action_failed') ORDER BY id", t.id),
    };
  });

  app.post('/api/tasks/:id/cancel', { schema: { params: idParam } }, async (req) => {
    const r = cancelTask(req.params.id, req.user.username);
    auditReq(req, 'task_cancelled', `T-${req.params.id}`);
    return r;
  });

  app.post('/api/tasks/:id/retry', { schema: { params: idParam } }, async (req) => {
    const t = retryTask(req.params.id);
    auditReq(req, 'task_retried', `T-${req.params.id}`);
    return taskPublic(t);
  });
}
