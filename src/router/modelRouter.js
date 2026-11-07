// AI Model Router: picks provider/model candidates, enforces quotas & concurrency, falls back on errors,
// logs every network attempt to usage_logs. Never retries forever: bounded by max_model_attempts and max_retries.
import { q, now, json } from '../db/index.js';
import { getSetting } from '../lib/settings.js';
import { todayRange, nextUtcMidnight } from '../lib/time.js';
import { estimateMessagesTokens, estimateTokens, truncate } from '../lib/text.js';
import { ProviderError } from '../providers/base.js';
import { adapterFor, setProviderStatus, modelPricing } from '../providers/service.js';
import { bus } from '../events.js';
import { tierOf } from '../agents/employees.js';

export class RouterError extends Error {
  // kind: no_provider | quota | all_failed | cancelled
  constructor(message, kind, attempts = []) {
    super(message);
    this.name = 'RouterError';
    this.kind = kind;
    this.attempts = attempts;
  }
}

// ---- in-memory state (cheap; resets on restart, which is acceptable) ----
const modelCooldown = new Map(); // `${providerId}:${model}` -> until ms
const rpmWindow = new Map(); // providerId -> [timestamps]

// Simple semaphore so that even ad-hoc calls (model tests) respect max_concurrency.
let active = 0;
const waiters = [];
async function acquire(signal) {
  while (active >= getSetting('max_concurrency')) {
    if (signal?.aborted) throw new RouterError('Dibatalkan', 'cancelled');
    await new Promise((resolve, reject) => {
      const w = { resolve, reject };
      waiters.push(w);
      signal?.addEventListener('abort', () => reject(new RouterError('Dibatalkan', 'cancelled')), { once: true });
    });
  }
  active++;
}
function release() {
  active = Math.max(0, active - 1);
  const w = waiters.shift();
  if (w) w.resolve();
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RouterError('Dibatalkan', 'cancelled'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new RouterError('Dibatalkan', 'cancelled'));
      },
      { once: true }
    );
  });

export function resetRouterState() {
  modelCooldown.clear();
  rpmWindow.clear();
}

// ---- candidate selection ----
export function buildCandidates(employee = null) {
  const providers = q.all('SELECT * FROM providers WHERE enabled = 1 ORDER BY is_default DESC, priority ASC, id ASC');
  const byId = new Map(providers.map((p) => [p.id, p]));
  const def = providers.find((p) => p.is_default) || providers[0] || null;
  const list = [];
  const seen = new Set();
  const push = (p, model, source) => {
    if (!p || !model) return;
    const key = `${p.id}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ provider: p, model, source });
  };
  const fallbacks = (p) => (p ? json(p.fallback_models, []) : []);

  // 1. Employee-specific model (only when the admin set one on the employee).
  if (employee && (employee.provider_id || employee.model)) {
    const ep = employee.provider_id ? byId.get(employee.provider_id) : def;
    if (ep) push(ep, employee.model || ep.default_model, 'employee');
    if (ep && ep !== def) {
      push(ep, ep.default_model, 'employee-provider');
      for (const m of fallbacks(ep)) push(ep, m, 'employee-fallback');
    }
  }
  // 1b. Tier default: Group CEO / Business Manager / Shared Services / business staff.
  if (employee) {
    const tier = getSetting('tier_models')?.[tierOf(employee)];
    if (tier && (tier.provider_id || tier.model)) {
      const tp = tier.provider_id ? byId.get(tier.provider_id) : def;
      if (tp) push(tp, tier.model || tp.default_model, 'tier');
    }
  }
  // 2–3. Default provider: default model, then its fallback (free) models.
  if (def) {
    push(def, def.default_model, 'default');
    for (const m of fallbacks(def)) push(def, m, 'fallback');
  }
  // 4. Backup providers by priority.
  for (const p of providers) {
    if (p === def) continue;
    push(p, p.default_model, 'backup');
    for (const m of fallbacks(p)) push(p, m, 'backup-fallback');
  }
  return list;
}

function requestsToday(providerId = null) {
  const [start] = todayRange(getSetting('timezone'));
  if (providerId === null) return q.get('SELECT COUNT(*) n FROM usage_logs WHERE created_at >= ? AND purpose != ?', start, 'test').n;
  return q.get('SELECT COUNT(*) n FROM usage_logs WHERE provider_id = ? AND created_at >= ?', providerId, start).n;
}

function skipReason(c) {
  const t = now();
  const p = c.provider;
  if (p.cooldown_until && p.cooldown_until > t) return `provider cooldown sampai ${new Date(p.cooldown_until).toISOString()}`;
  const mc = modelCooldown.get(`${p.id}:${c.model}`);
  if (mc && mc > t) return 'model cooldown';
  if (p.daily_request_limit > 0 && requestsToday(p.id) >= p.daily_request_limit) return 'batas request harian provider tercapai';
  return null;
}

async function waitForRpmSlot(p, signal) {
  if (!p.rpm_limit || p.rpm_limit <= 0) return true;
  const arr = (rpmWindow.get(p.id) || []).filter((ts) => ts > now() - 60_000);
  rpmWindow.set(p.id, arr);
  if (arr.length < p.rpm_limit) return true;
  const waitMs = arr[0] + 60_000 - now() + 50;
  if (waitMs > 30_000) return false; // too long: try another candidate instead
  await sleep(waitMs, signal);
  return true;
}

function markRpm(p) {
  const arr = rpmWindow.get(p.id) || [];
  arr.push(now());
  rpmWindow.set(p.id, arr);
}

function logUsage(entry) {
  q.run(
    `INSERT INTO usage_logs(task_id, employee_id, business_id, provider_id, provider_name, model, purpose, ok, http_status, error,
      tokens_in, tokens_out, estimated, cost_usd, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    entry.taskId ?? null,
    entry.employeeId ?? null,
    entry.businessId ?? null,
    entry.providerId,
    entry.providerName,
    entry.model,
    entry.purpose,
    entry.ok ? 1 : 0,
    entry.httpStatus ?? null,
    entry.error ? truncate(entry.error, 500) : null,
    entry.tokensIn || 0,
    entry.tokensOut || 0,
    entry.estimated ? 1 : 0,
    entry.costUsd ?? null,
    entry.latencyMs ?? null,
    now()
  );
}

function alert(key, title, message) {
  bus.emit('system:alert', { key, title, message });
}

// Apply side effects of a provider error (cooldowns, status). Returns true if the whole provider should be skipped.
function handleError(c, e) {
  const p = c.provider;
  const t = now();
  switch (e.kind) {
    case 'auth':
      setProviderStatus(p.id, 'auth_error', e.message);
      alert(`auth:${p.id}`, `Provider ${p.name}: autentikasi gagal`, e.message);
      return true;
    case 'quota': {
      const until = t + 60 * 60_000;
      setProviderStatus(p.id, 'quota', e.message, { cooldown_until: until });
      p.cooldown_until = until;
      alert(`quota:${p.id}`, `Provider ${p.name}: kuota/kredit habis`, e.message);
      return true;
    }
    case 'rate_limit': {
      if (e.daily) {
        const until = nextUtcMidnight(t);
        setProviderStatus(p.id, 'rate_limited', e.message, { cooldown_until: until });
        p.cooldown_until = until;
        alert(`daily:${p.id}`, `Provider ${p.name}: kuota harian habis`, `${e.message}\nCooldown sampai ${new Date(until).toISOString()}`);
        return true;
      }
      modelCooldown.set(`${p.id}:${c.model}`, t + Math.max(e.retryAfterMs || 60_000, 10_000));
      return false;
    }
    case 'not_found':
    case 'bad_request':
    case 'empty':
    case 'unsupported':
      modelCooldown.set(`${p.id}:${c.model}`, t + (e.kind === 'empty' ? 5 * 60_000 : 60 * 60_000));
      return false;
    default:
      return false;
  }
}

function computeCost(providerId, model, result) {
  if (typeof result.costUsd === 'number') return result.costUsd;
  const pr = modelPricing(providerId, model);
  if (!pr) return null;
  if (pr.is_free) return 0;
  if (pr.pricing_prompt === null || pr.pricing_completion === null) return null;
  return result.tokensIn * pr.pricing_prompt + result.tokensOut * pr.pricing_completion;
}

/**
 * Run a chat completion through the routing chain.
 * @returns {Promise<{content, providerId, providerName, model, tokensIn, tokensOut, estimated, costUsd, attempts}>}
 */
export async function routeChat({ messages, employee = null, taskId = null, businessId = null, purpose = 'work', maxTokens, temperature, signal, candidates = null }) {
  const maxDaily = getSetting('max_daily_requests');
  if (maxDaily > 0 && requestsToday() >= maxDaily) {
    alert('global-daily', 'Batas request harian tercapai', `Batas ${maxDaily} request/hari sudah tercapai. Tugas ditunda.`);
    throw new RouterError(`Batas ${maxDaily} request AI per hari tercapai`, 'quota');
  }
  const list = candidates || buildCandidates(employee);
  if (!list.length) {
    throw new RouterError('Belum ada provider AI aktif dengan model default. Atur di menu AI Providers.', 'no_provider');
  }

  const maxCandidates = getSetting('max_model_attempts');
  const attempts = [];
  const skippedProviders = new Set();
  let tried = 0;

  await acquire(signal);
  try {
    for (const c of list) {
      if (signal?.aborted) throw new RouterError('Dibatalkan', 'cancelled', attempts);
      if (tried >= maxCandidates) break;
      if (skippedProviders.has(c.provider.id)) continue;
      const reason = skipReason(c);
      if (reason) {
        attempts.push({ provider: c.provider.name, model: c.model, skipped: reason });
        continue;
      }
      if (!(await waitForRpmSlot(c.provider, signal))) {
        attempts.push({ provider: c.provider.name, model: c.model, skipped: 'batas request per menit' });
        continue;
      }
      tried++;
      let adapter;
      try {
        adapter = adapterFor(c.provider);
      } catch (e) {
        attempts.push({ provider: c.provider.name, model: c.model, error: e.message });
        skippedProviders.add(c.provider.id);
        continue;
      }
      const retries = Math.max(0, Math.min(c.provider.max_retries ?? 1, 3));
      for (let r = 0; r <= retries; r++) {
        if (maxDaily > 0 && requestsToday() >= maxDaily) {
          throw new RouterError(`Batas ${maxDaily} request AI per hari tercapai`, 'quota', attempts);
        }
        const started = now();
        markRpm(c.provider);
        try {
          const res = await adapter.chat({ model: c.model, messages, maxTokens, temperature, signal });
          const estimated = !res.hasUsage;
          const tokensIn = estimated ? estimateMessagesTokens(messages) : res.tokensIn;
          const tokensOut = estimated ? estimateTokens(res.content) : res.tokensOut;
          const costUsd = computeCost(c.provider.id, c.model, { ...res, tokensIn, tokensOut });
          logUsage({
            taskId, businessId, employeeId: employee?.id, providerId: c.provider.id, providerName: c.provider.name, model: c.model,
            purpose, ok: true, tokensIn, tokensOut, estimated, costUsd, latencyMs: now() - started,
          });
          if (c.provider.status !== 'ok') setProviderStatus(c.provider.id, 'ok', `Berhasil dipakai (${c.model})`, { cooldown_until: null });
          attempts.push({ provider: c.provider.name, model: c.model, ok: true });
          return {
            content: res.content,
            providerId: c.provider.id,
            providerName: c.provider.name,
            model: c.model,
            source: c.source,
            tokensIn,
            tokensOut,
            estimated,
            costUsd,
            finishReason: res.finishReason,
            attempts,
          };
        } catch (e) {
          if (e instanceof RouterError) throw e;
          const err = e instanceof ProviderError ? e : new ProviderError(e.message, { kind: 'server' });
          if (err.kind === 'cancelled') throw new RouterError('Dibatalkan', 'cancelled', attempts);
          logUsage({
            taskId, businessId, employeeId: employee?.id, providerId: c.provider.id, providerName: c.provider.name, model: c.model,
            purpose, ok: false, httpStatus: err.status, error: err.message, latencyMs: now() - started,
          });
          attempts.push({ provider: c.provider.name, model: c.model, error: err.message, kind: err.kind });
          const transient = ['server', 'timeout', 'network'].includes(err.kind);
          if (transient && r < retries) {
            await sleep(1000 * 2 ** r + Math.floor(Math.random() * 500), signal);
            continue;
          }
          if (transient) setProviderStatus(c.provider.id, 'error', err.message);
          if (handleError(c, err)) skippedProviders.add(c.provider.id);
          break;
        }
      }
    }
  } finally {
    release();
  }

  const summary = attempts
    .slice(-6)
    .map((a) => `${a.provider}/${a.model}: ${a.error || a.skipped}`)
    .join('; ');
  throw new RouterError(`Semua model gagal atau tidak tersedia. ${summary}`, 'all_failed', attempts);
}
