// System test (run manually: npm run test:system). Starts the real server as a child process with a temp data dir:
//  1. idle RAM/CPU   2. crash (hard kill) during a holding task -> restart -> task recovered & completed
//  3. daily Telegram report: sent once, not re-sent after restart   4. load: tasks + 600 API requests, peak RAM
// Uses local mock AI/Telegram servers only. Never touches production data.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider } from '../mock-provider.js';
import { startMockTelegram } from '../mock-telegram.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-system-'));
const results = {};

const ai = await startMockProvider({ key: 'sys-key', delayMs: 1200 });
const tg = await startMockTelegram();
let child = null;

function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--max-old-space-size=96', 'src/server.js'], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'warn',
      APP_SECRET: 'system-test-secret-system-test-secret-12', ADMIN_PASSWORD: 'system-password-123', COOKIE_SECURE: 'false',
      TELEGRAM_API_BASE: tg.base, QUEUE_INTERVAL_MS: '1000', SCHEDULER_INTERVAL_MS: '1000', API_RATE_LIMIT_PER_MIN: '5000',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return waitHealthy();
}

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

let cookie = '';
let csrf = '';
async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'system-password-123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  csrf = (await r.json()).csrfToken;
}
async function api(p, method = 'GET', body) {
  const r = await fetch(BASE + p, { method, headers: { cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const overview = () => api('/api/overview');
async function waitTask(id, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await api(`/api/tasks/${id}`)).task;
    if (['completed', 'failed', 'cancelled'].includes(t.status)) return t;
    await sleep(500);
  }
  throw new Error(`task ${id} did not finish`);
}

try {
  // ---- 1. boot + idle ----
  const t0 = Date.now();
  await start();
  results.boot_ms = Date.now() - t0;
  await login();
  await sleep(4000);
  const a = await overview();
  await sleep(30000);
  const b = await overview();
  results.idle = { rss_mb: b.system.rss_mb, heap_mb: b.system.heap_mb, cpu_percent_30s: +(((b.system.cpu_ms - a.system.cpu_ms) / 30000) * 100).toFixed(2) };
  console.log('idle', results.idle);

  // ---- 2. configure AI + Telegram ----
  await api('/api/providers', 'POST', { preset: 'custom', name: 'Mock', base_url: ai.baseUrl, api_key: 'sys-key', default_model: 'ok-model' });
  await api('/api/telegram', 'PUT', { bot_token: tg.token, chat_id: '42', allowed_user_ids: ['1'], report_enabled: true, report_time: '00:00', timezone: 'Asia/Jakarta', polling_enabled: false });
  await sleep(2500);
  const dailyBefore = tg.sent.filter((m) => /DAILY REPORT/.test(m.text)).length;

  // ---- 3. crash in the middle of a holding task ----
  const root1 = await api('/api/tasks', 'POST', { mode: 'holding', title: 'Evaluasi seluruh bisnis (uji restart)', description: 'uji' });
  for (let i = 0; i < 60; i++) {
    const p = await api('/api/tasks?status=processing&kind=business');
    if (p.items.length) break;
    await sleep(250);
  }
  child.kill('SIGKILL'); // simulate container crash / power loss
  await new Promise((r) => child.once('exit', r));
  await start();
  await login();
  const done1 = await waitTask(root1.id);
  const tasksAll = await api('/api/tasks?limit=100&kind=');
  let recovered = 0;
  for (const t of tasksAll.items) recovered += (await api(`/api/tasks/${t.id}`)).logs.filter((l) => l.event === 'recovered').length;
  await sleep(3000);
  const dailyAfter = tg.sent.filter((m) => /DAILY REPORT/.test(m.text)).length;
  results.restart = { holding_task_status: done1.status, tasks_recovered_after_crash: recovered, daily_reports_sent_before_restart: dailyBefore, daily_reports_sent_total_after_restart: dailyAfter };
  console.log('restart', results.restart);

  // ---- 4. load ----
  const peak = { rss: 0, heap: 0 };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const o = await overview().catch(() => null);
      if (o) {
        peak.rss = Math.max(peak.rss, o.system.rss_mb);
        peak.heap = Math.max(peak.heap, o.system.heap_mb);
      }
      await sleep(500);
    }
  })();
  const businesses = await api('/api/businesses');
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await api('/api/tasks', 'POST', { mode: 'holding', title: `Holding load ${i}`, description: 'beban' })).id);
  for (const biz of businesses) ids.push((await api('/api/tasks', 'POST', { mode: 'business', business_id: biz.id, title: `Business load ${biz.slug}`, description: 'beban' })).id);
  const endpoints = ['/api/overview', '/api/office', '/api/tasks?limit=30', '/api/businesses', '/api/organization', '/api/employees'];
  const tReq = Date.now();
  for (let i = 0; i < 60; i++) await Promise.all(endpoints.concat(endpoints.slice(0, 4)).map((e) => api(e)));
  results.api_600_requests_ms = Date.now() - tReq;
  for (const id of ids) await waitTask(id, 240000);
  sampling = false;
  await sampler;
  await sleep(5000);
  const after = await overview();
  results.load = { tasks_completed: ids.length, ai_calls: after.usage.today.requests, peak_rss_mb: peak.rss, peak_heap_mb: peak.heap, rss_after_mb: after.system.rss_mb };
  console.log('load', results.load);
  results.db_size_kb = Math.round(fs.statSync(path.join(dataDir, 'office.db')).size / 1024);
  results.platform = `${process.platform} ${process.arch}, Node ${process.version}`;
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
  await ai.close();
  await tg.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
