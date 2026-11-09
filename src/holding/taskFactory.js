// Single entry point for owner-created work (dashboard and Telegram), with validation of the hierarchy rules.
import { q } from '../db/index.js';
import { createTask, PRIORITY } from '../queue/tasks.js';
import { getEmployee, getManager } from '../agents/employees.js';
import { getBusiness } from './businesses.js';
import { canAccessBusiness } from './context.js';

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

/**
 * mode: 'holding'  -> holding task for the Group CEO (optionally focused on one business)
 *       'business' -> business task straight to that Business Manager (saves the CEO planning call)
 *       'direct'   -> one employee, optional business context
 */
export function createOwnerTask(params) {
  return createTask(resolveOwnerTask(params));
}

// Validates the hierarchy rules and returns the createTask() arguments, without creating anything
// (also used to check a recurring task before it is saved).
export function resolveOwnerTask({ mode = 'holding', title, description = '', priority = 'normal', businessId = null, employeeId = null, createdBy = 'owner' }) {
  const prio = typeof priority === 'number' ? priority : PRIORITY[priority] || 2;
  const business = businessId ? getBusiness(businessId) : null;
  if (businessId && !business) throw httpError('Bisnis tidak ditemukan', 404);
  if (business && business.status !== 'active') throw httpError(`Bisnis ${business.name} sedang nonaktif`);

  if (mode === 'holding') {
    const ceo = getManager();
    if (!ceo) throw httpError('Group CEO tidak aktif');
    return { kind: 'instruction', title, description, priority: prio, businessId: business?.id ?? null, employeeId: ceo.id, managerEmployeeId: ceo.id, createdBy };
  }
  if (mode === 'business') {
    if (!business) throw httpError('Pilih bisnis untuk business task');
    let bm = business.manager_employee_id ? getEmployee(business.manager_employee_id) : null;
    if (!bm || !bm.enabled) bm = getManager();
    if (!bm) throw httpError('Tidak ada Business Manager atau Group CEO aktif');
    return { kind: 'business', title, description, priority: prio, businessId: business.id, employeeId: bm.id, managerEmployeeId: bm.id, createdBy };
  }
  if (mode === 'direct') {
    const emp = employeeId ? getEmployee(employeeId) : null;
    if (!emp) throw httpError('Pilih karyawan untuk tugas langsung');
    if (!emp.enabled) throw httpError(`${emp.name} sedang nonaktif`);
    if (business && !canAccessBusiness(emp, business.id)) {
      throw httpError(`${emp.name} tidak menangani bisnis ${business.name}. Tambahkan ke tim bisnis atau pilih Shared Services.`);
    }
    if (!business && emp.org_unit === 'business') {
      const only = q.all('SELECT business_id FROM business_employees WHERE employee_id = ?', emp.id);
      if (only.length === 1) businessId = only[0].business_id; // business staff always work in their business context
    }
    return { kind: 'direct', title, description, priority: prio, businessId: business?.id ?? businessId ?? null, employeeId: emp.id, createdBy };
  }
  throw httpError('Mode tugas tidak dikenal');
}
