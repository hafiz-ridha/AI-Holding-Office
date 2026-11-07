// Business reports (scope=business) and consolidated holding reports (scope=holding).
import { q, now } from '../db/index.js';
import { truncate } from '../lib/text.js';

export function saveReport({ businessId = null, taskId = null, scope, title, content, employeeId = null }) {
  const r = q.run(
    `INSERT INTO business_reports(business_id, task_id, scope, title, content, employee_id, created_at) VALUES (?,?,?,?,?,?,?)`,
    businessId, taskId, scope, truncate(title, 200), truncate(content, 60000), employeeId, now()
  );
  return r.lastInsertRowid;
}

export function listReports({ businessId, scope = null, limit = 50 } = {}) {
  const where = [];
  const vals = [];
  if (businessId !== undefined) {
    where.push('r.business_id IS ?');
    vals.push(businessId);
  }
  if (scope) {
    where.push('r.scope = ?');
    vals.push(scope);
  }
  return q.all(
    `SELECT r.id, r.business_id, b.name AS business_name, r.task_id, r.scope, r.title, substr(r.content, 1, 400) AS excerpt,
       r.employee_id, e.name AS employee_name, r.created_at
     FROM business_reports r LEFT JOIN businesses b ON b.id = r.business_id LEFT JOIN employees e ON e.id = r.employee_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ?`,
    ...vals, limit
  );
}

export function getReport(id) {
  return q.get(
    `SELECT r.*, b.name AS business_name, e.name AS employee_name FROM business_reports r
     LEFT JOIN businesses b ON b.id = r.business_id LEFT JOIN employees e ON e.id = r.employee_id WHERE r.id = ?`,
    id
  );
}
