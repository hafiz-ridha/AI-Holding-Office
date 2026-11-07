// SQLite-backed task queue worker. Wakes on events plus a slow interval; default concurrency 1.
import { getSetting } from '../lib/settings.js';
import { bus } from '../events.js';
import { claimNext, failTask, postponeTask, logTask, recoverInterrupted, getTask, PLANNED_KINDS } from './tasks.js';
import { executeTask, BudgetError } from '../agents/orchestrator.js';
import { RouterError } from '../router/modelRouter.js';
import { setEmployeeStatus, resetEmployeeStatuses } from '../agents/employees.js';

class Worker {
  constructor() {
    this.running = new Map(); // taskId -> { ctrl, employeeId, task }
    this.timer = null;
    this.stopping = false;
    this.ticking = false;
    this.log = console;
    this.onWake = () => this.tick();
    this.onCancel = ({ task }) => {
      const r = task && this.running.get(task.id);
      if (r) r.ctrl.abort();
    };
  }

  start({ log, intervalMs = 5000 } = {}) {
    if (log) this.log = log;
    this.stopping = false;
    resetEmployeeStatuses();
    const n = recoverInterrupted();
    if (n) this.log.warn?.(`${n} tugas yang terputus dijadwalkan ulang`);
    bus.on('queue:wake', this.onWake);
    bus.on('task:cancelled', this.onCancel);
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  async stop(graceMs = 10000) {
    this.stopping = true;
    clearInterval(this.timer);
    bus.off('queue:wake', this.onWake);
    bus.off('task:cancelled', this.onCancel);
    const deadline = Date.now() + graceMs;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    // Anything still running is re-queued on next boot by recoverInterrupted().
    for (const r of this.running.values()) r.ctrl.abort();
  }

  isPaused() {
    return getSetting('queue_paused');
  }

  status() {
    return {
      paused: this.isPaused(),
      running: [...this.running.values()].map((r) => ({ taskId: r.task.id, employeeId: r.employeeId })),
      concurrency: getSetting('max_concurrency'),
    };
  }

  runningEmployeeIds() {
    return [...this.running.values()].map((r) => r.employeeId).filter(Boolean);
  }

  tick() {
    if (this.stopping || this.ticking || this.isPaused()) return;
    this.ticking = true;
    try {
      const max = getSetting('max_concurrency');
      while (this.running.size < max) {
        const task = claimNext(this.runningEmployeeIds());
        if (!task) break;
        this.run(task);
      }
    } catch (e) {
      this.log.error?.({ err: e }, 'queue tick failed');
    } finally {
      this.ticking = false;
    }
  }

  async run(task) {
    const ctrl = new AbortController();
    this.running.set(task.id, { ctrl, employeeId: task.employee_id, task });
    setEmployeeStatus(task.employee_id, 'working');
    const firstStart = task.attempts === 0 && (task.phase === 'planning' || !PLANNED_KINDS.has(task.kind));
    logTask(task.id, 'started', task.kind === 'instruction' ? `Fase: ${task.phase}` : 'Mulai dikerjakan');
    if (firstStart) bus.emit('task:started', { task });
    try {
      await executeTask(task, ctrl.signal);
    } catch (e) {
      const current = getTask(task.id);
      if (!current || current.status !== 'processing') {
        // Cancelled while running: nothing else to do.
      } else if (e instanceof RouterError && e.kind === 'cancelled') {
        logTask(task.id, 'aborted', 'Panggilan AI dihentikan', 'warn');
      } else if (e instanceof RouterError) {
        postponeTask(current, e.message, {
          maxAttempts: getSetting('max_task_attempts'),
          delayMinutes: getSetting('retry_delay_minutes'),
        });
        bus.emit('system:alert', {
          key: `postponed:${e.kind}`,
          title: 'Tugas ditunda: AI tidak tersedia',
          message: `${task.title}\n${e.message}`,
        });
      } else if (e instanceof BudgetError) {
        failTask(current, e.message);
      } else {
        this.log.error?.({ err: e, taskId: task.id }, 'task execution error');
        failTask(current, `Kesalahan internal: ${e.message}`);
      }
    } finally {
      this.running.delete(task.id);
      setEmployeeStatus(task.employee_id, 'idle');
      if (!this.stopping) setImmediate(() => this.tick());
    }
  }
}

export const worker = new Worker();
