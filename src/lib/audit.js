import { q, now } from '../db/index.js';
import { truncate } from './text.js';

export function audit({ userId = null, actor = 'system', action, target = null, detail = null, ip = null, business_id = null }) {
  try {
    q.run(
      'INSERT INTO audit_logs(user_id, actor, action, target, detail, ip, business_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      userId,
      actor,
      action,
      target,
      detail ? truncate(JSON.stringify(detail), 2000) : null,
      ip,
      business_id,
      now()
    );
  } catch {
    // Audit logging must never break the request.
  }
}

// Convenience for route handlers.
export function auditReq(req, action, target = null, detail = null, businessId = null) {
  audit({
    userId: req.user?.id ?? null,
    actor: req.user?.username ?? 'anonymous',
    action,
    target,
    detail,
    ip: req.ip,
    business_id: businessId,
  });
}
