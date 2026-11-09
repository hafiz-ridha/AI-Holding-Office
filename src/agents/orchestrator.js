// Agent Orchestrator for the holding hierarchy:
//   holding task (Group CEO)  ->  business task (Business Manager)  ->  employee subtask (staff / shared services)
// Each claimed task runs exactly one step (plan, work, or synthesis) through the shared Model Router.
import { q, json } from '../db/index.js';
import { getSetting } from '../lib/settings.js';
import { extractJsonObject, estimateMessagesTokens, truncate } from '../lib/text.js';
import { formatDateTime } from '../lib/time.js';
import { routeChat, RouterError } from '../router/modelRouter.js';
import { detectNeed, isChatReply } from '../router/modelSelector.js';
import { recallKnowledge, formatKnowledge, addKnowledgeRefs, captureTask } from '../holding/knowledge.js';
import { getEmployee, getManager, recentMemories, addMemory } from './employees.js';
import {
  holdingPlanMessages, businessPlanMessages, workMessages, businessSynthesisMessages, holdingSynthesisMessages,
} from './prompts.js';
import {
  createTask, completeTask, failTask, logTask, addUsageToTask, saveConversation, setPhase, savePlan, getTask, PRIORITY,
} from '../queue/tasks.js';
import { getBusiness, businessTeam, sharedServices } from '../holding/businesses.js';
import { businessContextText, holdingOverviewText, canAccessBusiness } from '../holding/context.js';
import { saveReport } from '../holding/reports.js';
import { createApprovalsFromResult } from '../holding/approvals.js';
import { research, needsWeb } from '../research/web.js';

export class BudgetError extends Error {}

function outputBudget(task, employee, messages) {
  const budget = getSetting('max_tokens_per_task');
  const used = (task.tokens_in || 0) + (task.tokens_out || 0);
  const input = estimateMessagesTokens(messages);
  const cap = employee?.max_tokens > 0 ? employee.max_tokens : getSetting('max_output_tokens');
  const remaining = budget - used - input;
  if (remaining < 200) {
    throw new BudgetError(`Batas token per pekerjaan (${budget}) tidak cukup: terpakai ${used}, input ±${input}.`);
  }
  return Math.min(cap, remaining);
}

async function callAI({ task, employee, messages, purpose, signal }) {
  const need = detectNeed({ purpose, task, employee, inputTokens: estimateMessagesTokens(messages) });
  const res = await routeChat({
    messages,
    employee,
    taskId: task.id,
    businessId: task.business_id ?? null,
    purpose,
    maxTokens: outputBudget(task, employee, messages),
    temperature: employee?.temperature ?? 0.7,
    signal,
    need,
  });
  addUsageToTask(task.id, res);
  saveConversation(task.id, employee?.id ?? null, messages[messages.length - 1].content, res.content, res, task.business_id ?? null);
  logTask(task.id, 'ai_call', `${purpose}: ${res.providerName} / ${res.model} (${res.tokensIn}+${res.tokensOut} token${res.estimated ? ', estimasi' : ''})`);
  if (res.choice) logTask(task.id, 'model_choice', res.choice.text);
  return res;
}

const memo = (emp, task, text, importance = 1) =>
  addMemory(emp.id, task.id, `[${formatDateTime(Date.now(), getSetting('timezone'))}] ${task.title}: ${truncate(text, 300)}`, importance, task.business_id ?? null);

// Second Brain notes relevant to this task (same business scope only), as a prompt block; remembers which were used.
function brain(task, employee) {
  try {
    const r = recallKnowledge({ task, employee });
    addKnowledgeRefs(task.id, r.notes);
    return formatKnowledge(r, getSetting('timezone'));
  } catch {
    return ''; // knowledge is a bonus: never block the work
  }
}

// Fresh outside data (trends, news, social media, competitors, prices, ...) for tasks that need it, fetched by the
// server before the AI call and given as cited sources. Quick chat replies only when explicitly asked. Never blocks.
const CHAT_WEB = /\b(berita|news|tren|trend|cari di internet|cek internet|harga|kurs|viral|terbaru)\b/i;
async function webFor(task) {
  if (!getSetting('web_research_enabled') || !needsWeb(task)) return '';
  if (isChatReply(task) && !CHAT_WEB.test(task.description || task.title)) return '';
  try {
    const business = task.business_id ? getBusiness(task.business_id) : null;
    const r = await research(task, { business, pages: getSetting('web_research_pages') });
    if (r.refs.length) {
      q.run('UPDATE tasks SET web_refs = ? WHERE id = ?', JSON.stringify(r.refs), task.id);
      logTask(task.id, 'web_research', `${r.refs.length} sumber web (${r.plan.kind}: "${r.plan.topic}")${r.errors.length ? `; sebagian gagal: ${r.errors.join('; ')}` : ''}`.slice(0, 500));
    } else if (r.errors.length) {
      logTask(task.id, 'web_research_failed', r.errors.join('; ').slice(0, 300), 'warn');
    }
    return r.block;
  } catch (e) {
    logTask(task.id, 'web_research_failed', e.message, 'warn');
    return '';
  }
}

function finish(task, employee, content, { report = null } = {}) {
  if (report) {
    saveReport({ businessId: task.business_id ?? null, taskId: task.id, scope: report, title: task.title, content, employeeId: employee?.id ?? null });
  }
  if (report || task.kind === 'direct') createApprovalsFromResult(task, content);
  const done = completeTask(task, content);
  try {
    captureTask(done); // work results only; quick chat replies are skipped inside
  } catch {}
  return done;
}

function pick(list, key) {
  const k = String(key || '').toLowerCase().trim();
  if (!k) return null;
  return list.find((e) => e.slug === k) || list.find((e) => e.role_key === k) || list.find((e) => k.length > 2 && e.role.toLowerCase().includes(k)) || null;
}

// ---------------- Level 1: Group CEO ----------------
async function planHolding(task, signal) {
  const ceo = getEmployee(task.employee_id) || getManager();
  if (!ceo) throw new Error('Tidak ada Group CEO aktif');
  const tz = getSetting('timezone');
  const { businesses, text } = holdingOverviewText(task);
  const shared = sharedServices();
  const maxBusinessTasks = getSetting('max_business_tasks');
  const maxShared = getSetting('max_shared_tasks');
  const messages = holdingPlanMessages({
    ceo, task, overview: text, shared, maxBusinessTasks, maxShared,
    memories: recentMemories(ceo.id, getSetting('memory_items'), task.business_id ?? null), tz, knowledge: brain(task, ceo),
    web: await webFor(task),
  });
  const res = await callAI({ task, employee: ceo, messages, purpose: 'plan', signal });
  const plan = extractJsonObject(res.content);
  const hasLists = plan && (Array.isArray(plan.business_tasks) || Array.isArray(plan.shared_tasks) || Array.isArray(plan.subtasks));
  if (!plan || (!hasLists && !plan.direct_answer)) {
    logTask(task.id, 'plan_unparsed', 'Rencana bukan JSON valid; jawaban Group CEO dipakai sebagai hasil', 'warn');
    savePlan(task.id, { analysis: null, direct_answer: res.content, business_tasks: [], shared_tasks: [] });
    memo(ceo, task, res.content, 2);
    return finish(task, ceo, res.content, { report: 'holding' });
  }

  const bySlug = new Map(businesses.map((b) => [b.slug, b]));
  const created = [];
  const skipped = [];
  for (const bt of (plan.business_tasks || []).slice(0, maxBusinessTasks)) {
    const b = bySlug.get(String(bt?.business || '').toLowerCase().trim());
    if (!b) {
      skipped.push(`bisnis "${bt?.business}" tidak dikenal/tidak aktif`);
      continue;
    }
    let bm = b.manager_employee_id ? getEmployee(b.manager_employee_id) : null;
    if (!bm || !bm.enabled) {
      bm = ceo; // no active manager: the Group CEO acts as manager for this business
      logTask(task.id, 'no_manager', `Bisnis ${b.name} tidak punya Business Manager aktif; ditangani Group CEO`, 'warn');
    }
    const child = createTask({
      kind: 'business', parentId: task.id, businessId: b.id, employeeId: bm.id, managerEmployeeId: bm.id,
      title: String(bt.title || `Tugas ${b.name}`).slice(0, 200), description: String(bt.description || bt.title || task.description),
      createdBy: `employee:${ceo.slug}`, priority: PRIORITY[bt.priority] || task.priority,
    });
    created.push({ id: child.id, type: 'business', business: b.slug, assignee: bm.slug, employee: bm.name, title: child.title });
  }
  // Legacy "subtasks" (v1 plan format) are treated as shared-service tasks.
  const sharedPlan = [...(plan.shared_tasks || []), ...(plan.subtasks || [])].slice(0, maxShared);
  for (const st of sharedPlan) {
    const emp = pick(shared, st?.assignee);
    if (!emp) {
      skipped.push(`shared service "${st?.assignee}" tidak dikenal`);
      continue;
    }
    const bslug = st.business ? String(st.business).toLowerCase().trim() : null;
    const b = bslug ? bySlug.get(bslug) : null;
    if (bslug && !b) {
      skipped.push(`bisnis "${st.business}" untuk shared service tidak dikenal`);
      continue;
    }
    const businessId = b ? b.id : task.business_id ?? null;
    const child = createTask({
      kind: 'subtask', parentId: task.id, businessId, employeeId: emp.id, managerEmployeeId: ceo.id,
      title: String(st.title || st.description).slice(0, 200), description: String(st.description || st.title),
      createdBy: `employee:${ceo.slug}`, priority: PRIORITY[st.priority] || task.priority,
    });
    created.push({ id: child.id, type: 'shared', business: b?.slug ?? null, assignee: emp.slug, employee: emp.name, title: child.title });
  }
  if (skipped.length) logTask(task.id, 'plan_skipped', skipped.join('; '), 'warn');

  if (!created.length) {
    const answer = String(plan.direct_answer || plan.analysis || res.content);
    savePlan(task.id, { analysis: plan.analysis ?? null, direct_answer: answer, business_tasks: [], shared_tasks: [] });
    memo(ceo, task, answer, 2);
    return finish(task, ceo, answer, { report: 'holding' });
  }
  savePlan(task.id, { analysis: plan.analysis ?? null, children: created });
  setPhase(task.id, 'executing');
  logTask(task.id, 'planned', `Group CEO membuat ${created.length} tugas: ${created.map((c) => `${c.employee}${c.business ? `@${c.business}` : ''}`).join(', ')}`);
  return getTask(task.id);
}

async function synthesizeHolding(task, signal) {
  const ceo = getEmployee(task.employee_id) || getManager();
  const kids = q.all(
    `SELECT t.title, t.status, t.result, t.error, e.name AS employee, e.role, b.name AS business FROM tasks t
     LEFT JOIN employees e ON e.id = t.employee_id LEFT JOIN businesses b ON b.id = t.business_id
     WHERE t.parent_id = ? ORDER BY t.id`,
    task.id
  );
  const budgetChars = Math.max(2000, Math.floor(getSetting('max_tokens_per_task') * 0.5 * 4) - (task.tokens_in + task.tokens_out) * 4);
  const messages = holdingSynthesisMessages({
    ceo, task, analysis: json(task.plan, {})?.analysis, results: kids, budgetChars, tz: getSetting('timezone'),
  });
  const res = await callAI({ task, employee: ceo, messages, purpose: 'synthesis', signal });
  memo(ceo, task, res.content, 2);
  return finish(task, ceo, res.content, { report: 'holding' });
}

// ---------------- Level 2: Business Manager ----------------
async function planBusiness(task, signal) {
  const bm = getEmployee(task.employee_id);
  const b = getBusiness(task.business_id);
  if (!bm || !b) throw new Error('Business Manager atau bisnis tidak ditemukan');
  if (b.status !== 'active') throw new Error(`Bisnis ${b.name} sedang nonaktif`);
  if (!canAccessBusiness(bm, b.id)) throw new Error(`${bm.name} tidak memiliki akses ke bisnis ${b.name}`);
  const tz = getSetting('timezone');
  const maxSubtasks = getSetting('bm_max_subtasks');
  const team = [...businessTeam(b.id).filter((e) => e.id !== bm.id), ...sharedServices()].filter(
    (e, i, arr) => arr.findIndex((x) => x.id === e.id) === i
  );
  const parent = task.parent_id ? getTask(task.parent_id) : null;
  const messages = businessPlanMessages({
    manager: bm, task, team: maxSubtasks > 0 ? team : [], maxSubtasks,
    businessContext: businessContextText(bm, task, { kbQuery: `${task.title} ${task.description}` }),
    memories: recentMemories(bm.id, getSetting('memory_items'), b.id), tz, parentTitle: parent?.title, knowledge: brain(task, bm),
    web: await webFor(task),
  });
  const res = await callAI({ task, employee: bm, messages, purpose: 'plan', signal });
  const plan = extractJsonObject(res.content);
  const subtasks = maxSubtasks > 0 && Array.isArray(plan?.subtasks) ? plan.subtasks.filter((s) => s && (s.title || s.description)).slice(0, maxSubtasks) : [];
  if (!subtasks.length) {
    const answer = plan ? String(plan.direct_answer || plan.analysis || res.content) : res.content;
    savePlan(task.id, { analysis: plan?.analysis ?? null, direct_answer: answer, subtasks: [] });
    memo(bm, task, answer, 2);
    return finish(task, bm, answer, { report: 'business' });
  }
  const created = [];
  for (const s of subtasks) {
    const emp = pick(team, s.assignee) || bm; // assignees outside this business's team are not allowed
    const child = createTask({
      kind: 'subtask', parentId: task.id, businessId: b.id, employeeId: emp.id, managerEmployeeId: bm.id,
      title: String(s.title || s.description).slice(0, 200), description: String(s.description || s.title),
      createdBy: `employee:${bm.slug}`, priority: PRIORITY[s.priority] || task.priority,
    });
    created.push({ id: child.id, assignee: emp.slug, employee: emp.name, title: child.title });
  }
  savePlan(task.id, { analysis: plan.analysis ?? null, subtasks: created });
  setPhase(task.id, 'executing');
  logTask(task.id, 'planned', `${bm.name} membuat ${created.length} subtugas: ${created.map((c) => `${c.employee} (${c.title})`).join(', ')}`);
  return getTask(task.id);
}

async function synthesizeBusiness(task, signal) {
  const bm = getEmployee(task.employee_id);
  const b = getBusiness(task.business_id);
  const kids = q.all(
    `SELECT t.title, t.status, t.result, t.error, e.name AS employee, e.role FROM tasks t
     LEFT JOIN employees e ON e.id = t.employee_id WHERE t.parent_id = ? AND t.business_id IS ? ORDER BY t.id`,
    task.id, task.business_id
  );
  const budgetChars = Math.max(2000, Math.floor(getSetting('max_tokens_per_task') * 0.5 * 4) - (task.tokens_in + task.tokens_out) * 4);
  const messages = businessSynthesisMessages({
    manager: bm, task, businessName: b?.name || '-', analysis: json(task.plan, {})?.analysis, results: kids, budgetChars, tz: getSetting('timezone'),
  });
  const res = await callAI({ task, employee: bm, messages, purpose: 'synthesis', signal });
  memo(bm, task, res.content, 2);
  return finish(task, bm, res.content, { report: 'business' });
}

// ---------------- Level 3: employee ----------------
async function runWork(task, signal) {
  const employee = getEmployee(task.employee_id);
  if (!employee) throw new Error('Karyawan untuk tugas ini tidak ditemukan');
  if (task.business_id && !canAccessBusiness(employee, task.business_id)) {
    throw new Error(`${employee.name} tidak ditugaskan pada bisnis ini (isolasi data)`);
  }
  const tz = getSetting('timezone');
  let parent = null;
  let siblingResults = [];
  if (task.parent_id) {
    const p = getTask(task.parent_id);
    if (p) {
      parent = { title: p.title, description: p.description, analysis: json(p.plan, {})?.analysis };
      // Only siblings from the same business context are shared.
      siblingResults = q.all(
        `SELECT t.title, t.result, e.name AS employee FROM tasks t LEFT JOIN employees e ON e.id = t.employee_id
         WHERE t.parent_id = ? AND t.business_id IS ? AND t.status = 'completed' AND t.kind = 'subtask' AND t.id != ?
         ORDER BY t.completed_at LIMIT 3`,
        task.parent_id, task.business_id ?? null, task.id
      );
    }
  }
  const messages = workMessages({
    employee, task, parent, siblingResults,
    businessContext: task.business_id ? businessContextText(employee, task, { kbQuery: `${task.title} ${task.description}` }) : '',
    memories: recentMemories(employee.id, getSetting('memory_items'), task.business_id ?? null), tz,
    knowledge: brain(task, employee),
    web: await webFor(task),
  });
  const res = await callAI({ task, employee, messages, purpose: 'work', signal });
  // Quick chat replies are conversation, not work: kept in the chat history only, not in working memory.
  if (!isChatReply(task)) memo(employee, task, res.content);
  return finish(task, employee, res.content);
}

export async function executeTask(task, signal) {
  if (task.kind === 'instruction') {
    if (task.phase === 'synthesizing') return synthesizeHolding(task, signal);
    if (task.phase === 'planning' || !task.phase) return planHolding(task, signal);
    throw new Error(`Fase tidak dikenal: ${task.phase}`);
  }
  if (task.kind === 'business') {
    if (task.phase === 'synthesizing') return synthesizeBusiness(task, signal);
    if (task.phase === 'planning' || !task.phase) return planBusiness(task, signal);
    throw new Error(`Fase tidak dikenal: ${task.phase}`);
  }
  return runWork(task, signal);
}

export { RouterError, failTask };
