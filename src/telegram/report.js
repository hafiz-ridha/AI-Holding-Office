// Holding & business reports built from SQLite data only (no AI call, no invented numbers).
import { q } from '../db/index.js';
import { dayRange, displayDate, localDate } from '../lib/time.js';
import { escapeHtml, truncate } from '../lib/text.js';
import { readable, cleanError } from '../lib/readable.js';
import { summary as financeSummary, monthRange, formatMoney } from '../holding/finance.js';

const code = (id) => `T-${String(id).padStart(5, '0')}`;
const b = (s) => `<b>${escapeHtml(s)}</b>`;

export function section(text, heading) {
  const re = new RegExp(`##\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

export function plainSnippet(text, max) {
  return truncate(
    readable(text, { fences: true })
      .replace(/```[\s\S]*?```/g, '[kode]')
      .replace(/[#*_`>|]/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim(),
    max
  );
}

const isNone = (s) => !s || /^tidak ada\.?$/i.test(plainSnippet(s, 40));

function taskCounts(where, ...vals) {
  const r = q.get(
    `SELECT COUNT(*) total, SUM(status='completed') completed, SUM(status='failed') failed,
       SUM(status IN ('pending','assigned','processing')) pending FROM tasks WHERE ${where}`,
    ...vals
  );
  return { total: r.total || 0, completed: r.completed || 0, failed: r.failed || 0, pending: r.pending || 0 };
}

export function businessDayStats(biz, start, end) {
  const created = taskCounts('business_id = ? AND created_at >= ? AND created_at < ?', biz.id, start, end);
  const completedToday = q.get("SELECT COUNT(*) n FROM tasks WHERE business_id = ? AND status='completed' AND completed_at >= ? AND completed_at < ?", biz.id, start, end).n;
  const failedToday = q.all("SELECT id, title, error FROM tasks WHERE business_id = ? AND status='failed' AND completed_at >= ? AND completed_at < ? ORDER BY id DESC LIMIT 3", biz.id, start, end);
  const open = q.get("SELECT COUNT(*) n FROM tasks WHERE business_id = ? AND status IN ('pending','assigned','processing')", biz.id).n;
  const reports = q.all("SELECT id, title, content FROM business_reports WHERE business_id = ? AND scope = 'business' AND created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 2", biz.id, start, end);
  const highlights = reports.length
    ? reports.map((r) => `${truncate(r.title, 50)}: ${plainSnippet(section(r.content, 'Ringkasan') || r.content, 160)}`)
    : q.all("SELECT title FROM tasks WHERE business_id = ? AND status='completed' AND completed_at >= ? AND completed_at < ? AND kind != 'subtask' ORDER BY id DESC LIMIT 3", biz.id, start, end).map((t) => truncate(t.title, 80));
  const issues = [];
  for (const f of failedToday) issues.push(`Gagal ${code(f.id)} ${truncate(f.title, 50)}: ${truncate(cleanError(f.error || ''), 80)}`);
  for (const r of reports) {
    const m = section(r.content, 'Masalah');
    if (!isNone(m)) issues.push(plainSnippet(m, 160));
  }
  const approvals = q.get("SELECT COUNT(*) n FROM approvals WHERE business_id = ? AND status = 'pending'", biz.id).n;
  if (approvals) issues.push(`${approvals} persetujuan owner menunggu`);
  if (!biz.manager_employee_id) issues.push('Belum ada Business Manager');
  return { created, completedToday, open, highlights, issues };
}

export function renderBusinessBlock(biz, stats, { detailed = false, tz = 'Asia/Jakarta' } = {}) {
  const L = [];
  L.push(`▸ ${b(biz.name)}${biz.status !== 'active' ? ' (nonaktif)' : ''}`);
  L.push(`  • Aktivitas hari ini: ${stats.created.total} tugas baru, ${stats.completedToday} selesai, ${stats.created.failed} gagal`);
  L.push(`  • Jumlah pekerjaan terbuka: ${stats.open}`);
  L.push(`  • Hasil penting: ${stats.highlights.length ? '' : 'belum ada'}`);
  for (const h of stats.highlights) L.push(`    – ${escapeHtml(h)}`);
  L.push(`  • Perlu diperhatikan: ${stats.issues.length ? '' : 'tidak ada'}`);
  for (const i of stats.issues.slice(0, 4)) L.push(`    – ${escapeHtml(i)}`);
  if (detailed) {
    const [from, to] = monthRange(localDate(Date.now(), tz));
    const fin = financeSummary(biz.id, from, to);
    L.push('  • Keuangan bulan ini:');
    if (!fin) L.push('    – belum ada catatan bulan ini');
    else for (const c of fin.currencies) L.push(`    – ${c.currency}: masuk ${formatMoney(c.income, c.currency)}, keluar ${formatMoney(c.expense, c.currency)}, bersih ${formatMoney(c.net, c.currency)}`);
    const latest = q.get("SELECT title, content, created_at FROM business_reports WHERE business_id = ? ORDER BY id DESC LIMIT 1", biz.id);
    if (latest) L.push(`  • Laporan terakhir: ${escapeHtml(truncate(latest.title, 60))}\n    ${escapeHtml(plainSnippet(section(latest.content, 'Rekomendasi') || latest.content, 300))}`);
  }
  return L.join('\n');
}

function usageLines(start, end) {
  const usage = q.all(
    `SELECT provider_name AS provider, model, COUNT(*) AS requests, SUM(ok) AS ok, SUM(tokens_in + tokens_out) AS tokens,
       SUM(estimated) AS est, SUM(cost_usd) AS cost, SUM(CASE WHEN ok = 1 AND cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost
     FROM usage_logs WHERE created_at >= ? AND created_at < ? AND purpose != 'test' GROUP BY provider_name, model ORDER BY requests DESC`,
    start, end
  );
  if (!usage.length) return ['• Tidak ada request AI hari ini.'];
  const L = [];
  for (const u of usage.slice(0, 5)) L.push(`• ${escapeHtml(u.provider)} / <code>${escapeHtml(u.model)}</code>: ${u.requests} request (${u.ok} sukses)`);
  const tok = usage.reduce((n, u) => n + (u.tokens || 0), 0);
  L.push(`• Total request: ${usage.reduce((n, u) => n + u.requests, 0)} · Estimasi token: ${tok.toLocaleString('id-ID')}${usage.some((u) => u.est) ? ' (sebagian diestimasi)' : ''}`);
  const known = usage.filter((u) => u.cost !== null);
  L.push(known.length ? `• Estimasi biaya: $${known.reduce((n, u) => n + (u.cost || 0), 0).toFixed(4)}${usage.some((u) => u.unknown_cost) ? ' (sebagian tanpa data harga)' : ''}` : '• Estimasi biaya: tidak tersedia');
  return L;
}

export function buildHoldingReport(tz, ms = Date.now()) {
  const dateStr = localDate(ms, tz);
  const [start, end] = dayRange(dateStr, tz);
  const businesses = q.all('SELECT * FROM businesses ORDER BY status = \'active\' DESC, id');
  const active = businesses.filter((x) => x.status === 'active');
  const today = taskCounts('created_at >= ? AND created_at < ?', start, end);
  const completedToday = q.get("SELECT COUNT(*) n FROM tasks WHERE status='completed' AND completed_at >= ? AND completed_at < ?", start, end).n;
  const failedToday = q.get("SELECT COUNT(*) n FROM tasks WHERE status='failed' AND completed_at >= ? AND completed_at < ?", start, end).n;
  const pendingNow = q.get("SELECT COUNT(*) n FROM tasks WHERE status IN ('pending','assigned','processing')").n;

  const L = [];
  L.push(b('AI VIRTUAL HOLDING'));
  L.push(b('DAILY REPORT'));
  L.push(`Tanggal: ${displayDate(dateStr)}`);
  L.push('');
  L.push(b('GROUP OVERVIEW:'));
  L.push(`• Total bisnis: ${businesses.length} (${active.length} aktif)`);
  L.push(`• Total tugas hari ini: ${today.total}`);
  L.push(`• Selesai: ${completedToday}`);
  L.push(`• Pending: ${pendingNow}`);
  L.push(`• Failed: ${failedToday}`);
  L.push('');
  L.push(b('BUSINESS REPORTS:'));
  if (!active.length) L.push('• Tidak ada bisnis aktif.');
  for (const biz of active) L.push(renderBusinessBlock(biz, businessDayStats(biz, start, end), { tz }));
  L.push('');
  L.push(b('SHARED SERVICES:'));
  const shared = q.all(
    `SELECT e.name, e.role,
       (SELECT COUNT(*) FROM tasks t WHERE t.employee_id = e.id AND ((t.created_at >= ? AND t.created_at < ?) OR (t.completed_at >= ? AND t.completed_at < ?))) AS today,
       (SELECT COUNT(*) FROM tasks t WHERE t.employee_id = e.id AND t.status IN ('pending','assigned','processing')) AS open
     FROM employees e WHERE e.org_unit = 'shared' AND e.enabled = 1 ORDER BY e.desk_index`,
    start, end, start, end
  );
  L.push(`• Aktivitas tim pusat: ${shared.map((s) => `${escapeHtml(s.role)} ${s.today}`).join(', ') || '-'}`);
  const openShared = q.all(
    `SELECT t.id, t.title, e.role, bz.name AS biz FROM tasks t JOIN employees e ON e.id = t.employee_id LEFT JOIN businesses bz ON bz.id = t.business_id
     WHERE e.org_unit = 'shared' AND t.status IN ('pending','assigned','processing') ORDER BY t.priority DESC, t.id LIMIT 5`
  );
  L.push(`• Pekerjaan belum selesai: ${openShared.length ? '' : 'tidak ada'}`);
  for (const t of openShared) L.push(`  – ${code(t.id)} ${escapeHtml(truncate(t.title, 60))} (${escapeHtml(t.role)}${t.biz ? ` @ ${escapeHtml(t.biz)}` : ''})`);
  L.push('');
  L.push(b('CEO RECOMMENDATIONS:'));
  const holdingReport = q.get("SELECT content FROM business_reports WHERE scope = 'holding' AND created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 1", start, end);
  const priorities = q.all("SELECT id, title FROM tasks WHERE status IN ('pending','assigned') AND kind != 'subtask' ORDER BY priority DESC, id LIMIT 3");
  L.push('• Prioritas besok:');
  const prio = holdingReport ? section(holdingReport.content, 'Prioritas') : '';
  if (!isNone(prio)) L.push(`  – ${escapeHtml(plainSnippet(prio, 300))}`);
  for (const p of priorities) L.push(`  – Selesaikan ${code(p.id)} ${escapeHtml(truncate(p.title, 70))}`);
  if (isNone(prio) && !priorities.length) L.push('  – Tidak ada tugas tertunda.');
  L.push('• Risiko:');
  const risks = [];
  for (const p of q.all("SELECT name, status FROM providers WHERE enabled = 1 AND status IN ('error','auth_error','quota','rate_limited','unsupported')")) risks.push(`Provider ${p.name}: ${p.status}`);
  if (!q.get('SELECT 1 x FROM providers WHERE enabled = 1')) risks.push('Belum ada provider AI aktif');
  for (const biz of active) if (!biz.manager_employee_id) risks.push(`${biz.name} tanpa Business Manager`);
  const postponed = q.get("SELECT COUNT(*) n FROM tasks WHERE status = 'pending' AND attempts > 0").n;
  if (postponed) risks.push(`${postponed} tugas tertunda karena AI tidak tersedia`);
  if (failedToday) risks.push(`${failedToday} tugas gagal hari ini`);
  if (!risks.length) L.push('  – Tidak ada risiko terdeteksi dari data sistem.');
  for (const r of risks.slice(0, 5)) L.push(`  – ${escapeHtml(r)}`);
  const approvals = q.all("SELECT a.id, a.detail, bz.name AS biz FROM approvals a LEFT JOIN businesses bz ON bz.id = a.business_id WHERE a.status = 'pending' ORDER BY a.id LIMIT 5");
  L.push(`• Butuh persetujuan owner: ${approvals.length ? '' : 'tidak ada'}`);
  for (const a of approvals) L.push(`  – #${a.id}${a.biz ? ` [${escapeHtml(a.biz)}]` : ''} ${escapeHtml(truncate(a.detail, 120))}`);
  L.push('');
  L.push(b('PENGGUNAAN AI:'));
  L.push(...usageLines(start, end));
  return { dateStr, text: L.join('\n') };
}

export function buildBusinessReport(biz, tz, ms = Date.now()) {
  const dateStr = localDate(ms, tz);
  const [start, end] = dayRange(dateStr, tz);
  const L = [b('AI VIRTUAL HOLDING'), b(`LAPORAN BISNIS: ${biz.name}`), `Tanggal: ${displayDate(dateStr)}`, ''];
  const mgr = biz.manager_employee_id ? q.get('SELECT name FROM employees WHERE id = ?', biz.manager_employee_id) : null;
  L.push(`Industri: ${escapeHtml(biz.industry || '-')} · Manager: ${escapeHtml(mgr?.name || 'belum ada')} · Status: ${biz.status}`);
  L.push('');
  L.push(renderBusinessBlock(biz, businessDayStats(biz, start, end), { detailed: true, tz }));
  return { dateStr, text: L.join('\n') };
}

export function buildFinanceReport(tz, ms = Date.now()) {
  const [from, to] = monthRange(localDate(ms, tz));
  const L = [b('AI VIRTUAL HOLDING'), b('RINGKASAN KEUANGAN'), `Periode: ${displayDate(from)} s/d ${displayDate(to)}`, ''];
  const totals = {};
  for (const biz of q.all("SELECT * FROM businesses WHERE status = 'active' ORDER BY id")) {
    const s = financeSummary(biz.id, from, to);
    L.push(`▸ ${b(biz.name)}`);
    if (!s) {
      L.push('  Belum ada catatan bulan ini.');
      continue;
    }
    for (const c of s.currencies) {
      L.push(`  ${c.currency}: masuk ${formatMoney(c.income, c.currency)} · keluar ${formatMoney(c.expense, c.currency)} · bersih ${formatMoney(c.net, c.currency)}`);
      const t = (totals[c.currency] ||= { income: 0, expense: 0 });
      t.income += c.income;
      t.expense += c.expense;
    }
  }
  L.push('');
  L.push(b('KONSOLIDASI (per mata uang, tanpa konversi):'));
  const cur = Object.entries(totals);
  if (!cur.length) L.push('Belum ada catatan keuangan bulan ini. Catatan masuk dari dashboard → Bisnis → Keuangan (bisa impor CSV).');
  for (const [c, t] of cur) L.push(`${c}: masuk ${formatMoney(t.income, c)} · keluar ${formatMoney(t.expense, c)} · bersih ${formatMoney(t.income - t.expense, c)}`);
  return L.join('\n');
}

// Backwards-compatible name used by the scheduler (v1 called the daily report this).
export const buildDailyReport = buildHoldingReport;
