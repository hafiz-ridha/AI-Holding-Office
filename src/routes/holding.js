// Holding-level views: overview, organization chart, consolidated reports, approvals, office state, usage.
import { q } from '../db/index.js';
import { listEmployees, tierOf } from '../agents/employees.js';
import { computeOfficeState } from '../holding/officeState.js';
import { listBusinesses } from '../holding/businesses.js';
import { listReports, getReport } from '../holding/reports.js';
import { listApprovals, decideApproval, decideApprovals } from '../holding/approvals.js';
import { summary as financeSummary, monthRange } from '../holding/finance.js';
import { listProviders } from '../providers/service.js';
import { worker } from '../queue/worker.js';
import { getSetting } from '../lib/settings.js';
import { localDate, todayRange } from '../lib/time.js';
import { auditReq } from '../lib/audit.js';
import { bot } from '../telegram/bot.js';
import { idParam, body, str, httpError } from './schemas.js';

function countTasks(where = '1=1', ...vals) {
  const r = q.get(
    `SELECT COUNT(*) total, SUM(status='completed') completed, SUM(status IN ('pending','assigned')) pending,
       SUM(status='processing') processing, SUM(status='failed') failed, SUM(status='cancelled') cancelled
     FROM tasks WHERE ${where}`,
    ...vals
  );
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0]));
}

function employeeDetail(id) {
  const e = q.get('SELECT * FROM employees WHERE id = ?', id);
  if (!e) throw httpError('Karyawan tidak ditemukan', 404);
  const state = computeOfficeState().find((x) => x.id === e.id);
  const tz = getSetting('timezone');
  const [start, end] = todayRange(tz);
  const usage = (where, ...vals) => {
    const r = q.get(`SELECT COUNT(*) requests, SUM(ok) ok, SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out, SUM(cost_usd) cost FROM usage_logs WHERE employee_id = ? ${where}`, e.id, ...vals);
    return { requests: r.requests || 0, ok: r.ok || 0, tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0, cost_usd: r.cost };
  };
  const last = q.get('SELECT provider_name, model, ok, created_at FROM usage_logs WHERE employee_id = ? ORDER BY id DESC LIMIT 1', e.id);
  const tiers = getSetting('tier_models');
  const tier = tierOf(e);
  const def = q.get('SELECT name, default_model FROM providers WHERE is_default = 1 AND enabled = 1');
  const prov = (pid) => (pid ? q.get('SELECT name FROM providers WHERE id = ?', pid)?.name : null);
  let configured;
  if (e.provider_id || e.model) configured = { source: 'karyawan', provider: prov(e.provider_id) || def?.name || null, model: e.model || null };
  else if (tiers?.[tier]?.provider_id || tiers?.[tier]?.model) configured = { source: `tingkatan ${tier}`, provider: prov(tiers[tier].provider_id) || def?.name || null, model: tiers[tier].model || null };
  else configured = { source: 'provider default', provider: def?.name || null, model: def?.default_model || null };
  const taskCols = `t.id, t.kind, t.title, t.status, t.phase, t.priority, t.business_id, b.name AS business_name, t.provider_name, t.model_used,
    t.tokens_in, t.tokens_out, t.started_at, t.completed_at, t.created_at, t.error`;
  const lastResult = q.get(`SELECT id, title, result, completed_at FROM tasks WHERE employee_id = ? AND status = 'completed' AND result IS NOT NULL ORDER BY completed_at DESC LIMIT 1`, e.id);
  return {
    employee: { id: e.id, name: e.name, role: e.role, role_key: e.role_key, org_unit: e.org_unit, is_manager: Boolean(e.is_manager), enabled: Boolean(e.enabled), avatar: JSON.parse(e.avatar || '{}'), personality: e.personality },
    businesses: q.all(
      `SELECT DISTINCT b.id, b.name, b.color, (b.manager_employee_id = ?) AS is_manager FROM businesses b
       LEFT JOIN business_employees be ON be.business_id = b.id WHERE be.employee_id = ? OR b.manager_employee_id = ? ORDER BY b.id`,
      e.id, e.id, e.id
    ).map((b) => ({ ...b, is_manager: Boolean(b.is_manager) })),
    state,
    active_tasks: q.all(`SELECT ${taskCols} FROM tasks t LEFT JOIN businesses b ON b.id = t.business_id WHERE t.employee_id = ? AND t.status IN ('pending','assigned','processing') ORDER BY t.priority DESC, t.id LIMIT 10`, e.id),
    recent_tasks: q.all(`SELECT ${taskCols} FROM tasks t LEFT JOIN businesses b ON b.id = t.business_id WHERE t.employee_id = ? AND t.status IN ('completed','failed','cancelled') ORDER BY t.completed_at DESC LIMIT 8`, e.id),
    usage: { today: usage('AND created_at >= ? AND created_at < ?', start, end), total: usage('') },
    last_ai_call: last || null,
    configured_model: configured,
    last_result: lastResult ? { task_id: lastResult.id, title: lastResult.title, excerpt: lastResult.result.slice(0, 1500), completed_at: lastResult.completed_at } : null,
  };
}

// Coordination happening in a meeting room: holding level (scope=hq) or one business.
function coordination(businessId) {
  const scopeWhere = businessId ? "t.kind = 'business' AND t.business_id = ?" : "t.kind = 'instruction'";
  const vals = businessId ? [businessId] : [];
  const runningIds = new Set(worker.status().running.map((r) => r.taskId));
  const active = q.all(
    `SELECT t.id, t.title, t.phase, t.status, t.employee_id, e.name AS leader, b.name AS business_name FROM tasks t
     LEFT JOIN employees e ON e.id = t.employee_id LEFT JOIN businesses b ON b.id = t.business_id
     WHERE ${scopeWhere} AND t.status IN ('pending','assigned','processing') ORDER BY t.id DESC LIMIT 10`,
    ...vals
  ).map((t) => ({
    ...t,
    in_meeting_now: runningIds.has(t.id) && t.phase === 'synthesizing',
    participants: q.all(
      `SELECT c.id AS task_id, c.title, c.status, e.name, e.role, b.name AS business_name FROM tasks c
       LEFT JOIN employees e ON e.id = c.employee_id LEFT JOIN businesses b ON b.id = c.business_id WHERE c.parent_id = ? ORDER BY c.id`,
      t.id
    ),
  }));
  const recent = q.all(
    `SELECT l.task_id, l.event, l.message, l.created_at, t.title, e.name AS leader FROM task_logs l JOIN tasks t ON t.id = l.task_id
     LEFT JOIN employees e ON e.id = t.employee_id
     WHERE ${scopeWhere} AND l.event IN ('planned','synthesizing','completed','failed','no_manager') ORDER BY l.id DESC LIMIT 15`,
    ...vals
  );
  return { scope: businessId ? 'business' : 'hq', business_id: businessId || null, active, recent };
}

export default async function holdingRoutes(app) {
  app.get('/api/overview', async () => {
    const tz = getSetting('timezone');
    const [start, end] = todayRange(tz);
    const [mFrom, mTo] = monthRange(localDate(Date.now(), tz));
    const businesses = listBusinesses().map((b) => ({
      ...b,
      finance_month: financeSummary(b.id, mFrom, mTo),
    }));
    const usageToday = q.get(
      `SELECT COUNT(*) requests, SUM(ok) ok, SUM(tokens_in + tokens_out) tokens, SUM(cost_usd) cost FROM usage_logs WHERE created_at >= ? AND created_at < ? AND purpose != 'test'`,
      start, end
    );
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = localDate(Date.now() - i * 86400_000, tz);
      const [s, e] = todayRange(tz, Date.parse(`${d}T12:00:00Z`));
      const r = q.get('SELECT COUNT(*) requests, SUM(tokens_in + tokens_out) tokens FROM usage_logs WHERE created_at >= ? AND created_at < ?', s, e);
      last7.push({ date: d, requests: r.requests || 0, tokens: r.tokens || 0 });
    }
    const mem = process.memoryUsage();
    return {
      holding: {
        businesses_total: businesses.length,
        businesses_active: businesses.filter((b) => b.status === 'active').length,
        employees_total: q.get('SELECT COUNT(*) n FROM employees').n,
        employees_enabled: q.get('SELECT COUNT(*) n FROM employees WHERE enabled = 1').n,
        tasks: countTasks(),
        tasks_today: countTasks('created_at >= ? AND created_at < ?', start, end),
        holding_tasks: countTasks('business_id IS NULL'),
      },
      businesses,
      providers: listProviders().map((p) => ({ id: p.id, name: p.name, status: p.status, enabled: p.enabled, is_default: p.is_default, default_model: p.default_model, cooldown_until: p.cooldown_until })),
      usage: { today: { requests: usageToday.requests || 0, ok: usageToday.ok || 0, tokens: usageToday.tokens || 0, cost_usd: usageToday.cost }, last7, daily_limit: getSetting('max_daily_requests') },
      queue: worker.status(),
      telegram: bot.state,
      approvals_pending: q.get("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").n,
      system: {
        rss_mb: Math.round(mem.rss / 1048576),
        heap_mb: Math.round(mem.heapUsed / 1048576),
        cpu_ms: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
        uptime_sec: Math.round(process.uptime()),
        node: process.version,
      },
    };
  });

  app.get('/api/office', async () => ({
    businesses: q.all(
      `SELECT b.id, b.slug, b.name, b.color, b.status, b.industry, b.manager_employee_id, (b.logo_file IS NOT NULL) AS has_logo,
         (SELECT COUNT(*) FROM tasks t WHERE t.business_id = b.id AND t.status IN ('pending','assigned','processing')) AS active_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.business_id = b.id AND t.status = 'completed') AS completed_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.business_id = b.id AND t.status = 'failed') AS failed_tasks,
         (SELECT MAX(created_at) FROM task_logs l WHERE l.business_id = b.id) AS last_activity_at
       FROM businesses b ORDER BY b.id`
    ).map((b) => ({ ...b, has_logo: Boolean(b.has_logo) })),
    employees: computeOfficeState(),
    queue: { paused: getSetting('queue_paused'), running: worker.status().running.length },
    ts: Date.now(),
  }));

  app.get('/api/office/employees/:id', { schema: { params: idParam } }, async (req) => employeeDetail(req.params.id));

  app.get('/api/office/coordination', {
    schema: { querystring: { type: 'object', properties: { business_id: { type: 'integer', minimum: 1 } } } },
  }, async (req) => coordination(req.query.business_id || null));

  app.get('/api/organization', async () => {
    const all = listEmployees();
    const byId = new Map(all.map((e) => [e.id, e]));
    const businesses = listBusinesses().map((b) => ({
      business: { id: b.id, name: b.name, slug: b.slug, color: b.color, status: b.status, logo_url: b.logo_url, industry: b.industry },
      manager: b.manager_employee_id ? byId.get(b.manager_employee_id) || null : null,
      staff: b.employee_ids.filter((id) => id !== b.manager_employee_id).map((id) => byId.get(id)).filter((e) => e && e.org_unit === 'business'),
      shared_helpers: b.employee_ids.map((id) => byId.get(id)).filter((e) => e && e.org_unit === 'shared'),
    }));
    return {
      group_ceo: all.find((e) => e.is_manager) || null,
      businesses,
      shared: all.filter((e) => e.org_unit === 'shared'),
      unassigned: all.filter((e) => e.org_unit === 'business' && !e.business_ids.length),
    };
  });

  app.get('/api/reports', {
    schema: { querystring: { type: 'object', properties: { scope: { type: 'string', enum: ['holding', 'business'] }, business_id: { type: 'integer' } } } },
  }, async (req) => listReports({ scope: req.query.scope || null, businessId: req.query.business_id ?? undefined, limit: 100 }));

  app.get('/api/reports/:id', { schema: { params: idParam } }, async (req) => {
    const r = getReport(req.params.id);
    if (!r) throw httpError('Laporan tidak ditemukan', 404);
    return r;
  });

  app.get('/api/approvals', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          business: { type: 'string', pattern: '^(hq|\\d+)$' }, // 'hq' = holding level, or a business id
        },
      },
    },
  }, async (req) => {
    const b = req.query.business;
    return listApprovals({ status: req.query.status || null, businessId: b === undefined ? undefined : b === 'hq' ? null : Number(b) });
  });

  // Bulk decision for many approvals at once (same decision and note). Each decided item gets its own audit entry.
  app.post('/api/approvals/decide', {
    schema: {
      body: body({
        ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 1 } },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        note: str(500),
      }, ['ids', 'decision']),
    },
  }, async (req) => {
    const r = decideApprovals(req.body.ids, req.body.decision, req.user.username, req.body.note);
    for (const a of r.decided) auditReq(req, `approval_${req.body.decision}`, `approval:${a.id}`, { bulk: r.decided.length }, a.business_id);
    return r;
  });

  app.post('/api/approvals/:id/decide', {
    schema: { params: idParam, body: body({ decision: { type: 'string', enum: ['approved', 'rejected'] }, note: str(500) }, ['decision']) },
  }, async (req) => {
    const a = decideApproval(req.params.id, req.body.decision, req.user.username, req.body.note);
    auditReq(req, `approval_${req.body.decision}`, `approval:${a.id}`, null, a.business_id);
    return a;
  });

  app.get('/api/usage', {
    schema: { querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } } } },
  }, async (req) => {
    const since = Date.now() - req.query.days * 86400_000;
    return {
      by_model: q.all(
        `SELECT provider_name, model, COUNT(*) requests, SUM(ok) ok, SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out, SUM(cost_usd) cost, AVG(latency_ms) avg_latency
         FROM usage_logs WHERE created_at >= ? GROUP BY provider_name, model ORDER BY requests DESC`,
        since
      ),
      by_business: q.all(
        `SELECT COALESCE(b.name, 'Holding / umum') AS business, COUNT(*) requests, SUM(u.tokens_in + u.tokens_out) tokens
         FROM usage_logs u LEFT JOIN businesses b ON b.id = u.business_id WHERE u.created_at >= ? GROUP BY u.business_id ORDER BY requests DESC`,
        since
      ),
      recent_errors: q.all('SELECT provider_name, model, http_status, error, created_at FROM usage_logs WHERE ok = 0 AND created_at >= ? ORDER BY id DESC LIMIT 20', since),
    };
  });
}
