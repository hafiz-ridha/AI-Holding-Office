// Recurring tasks: rules that create a normal owner task on a schedule (daily news digest, weekly trend research,
// social media ideas, competitor watch, weekly report, ...). Times are in the holding timezone (setting `timezone`).
//
// Reliability (same approach as the daily Telegram report):
//  - a rule is "claimed" by moving next_run_at forward with a conditional UPDATE, so one due run creates exactly
//    one task, also with two ticks racing or after a restart;
//  - runs missed while the server was down are caught up once (not once per missed slot);
//  - by default a run is skipped while the task of the previous run is still active (no pile-up of work).
import { q, now } from '../db/index.js';
import { getSetting } from '../lib/settings.js';
import { zonedParts, dayRange, localDate, displayDate, localTime } from '../lib/time.js';
import { truncate } from '../lib/text.js';
import { bus } from '../events.js';
import { createOwnerTask, resolveOwnerTask } from './taskFactory.js';

export const FREQUENCIES = ['daily', 'weekdays', 'weekly', 'monthly', 'hours'];
const MODES = ['holding', 'business', 'direct'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ACTIVE = new Set(['pending', 'assigned', 'processing']);
const DAY = ['', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

// Ready-made rules. The instructions ask for fresh data from the internet with sources, never for manual input.
const WEB = 'Gunakan informasi terbaru dari internet (cari dan baca sumbernya; sebutkan judul, tanggal, dan tautan sumber). ' +
  'Jangan meminta admin mengisi data manual; jika ada data yang tidak bisa ditemukan, tulis asumsi yang dipakai.';
export const TEMPLATES = [
  {
    key: 'news', label: 'Ringkasan berita', title: 'Ringkasan berita industri', mode: 'holding', frequency: 'weekdays', time_of_day: '07:30',
    description: `Kumpulkan 5–8 berita terpenting hari ini yang relevan dengan industri bisnis holding (ekonomi, regulasi, pasar, teknologi). Untuk tiap berita: ringkasan 2 kalimat, dampaknya bagi bisnis kita, dan apakah perlu tindakan. ${WEB}`,
  },
  {
    key: 'trend', label: 'Riset tren', title: 'Riset tren pasar mingguan', mode: 'business', frequency: 'weekly', weekdays: [1], time_of_day: '08:00',
    description: `Riset tren pasar dan perilaku konsumen terbaru untuk bisnis ini: apa yang sedang naik, apa yang menurun, dan peluangnya. Bandingkan dengan hasil riset minggu lalu bila ada. Hasil: 5 tren utama dengan bukti, dampak, dan 3 rekomendasi tindakan minggu ini. ${WEB}`,
  },
  {
    key: 'social', label: 'Media sosial', title: 'Tren & ide konten media sosial', mode: 'business', frequency: 'weekly', weekdays: [1, 4], time_of_day: '09:00',
    description: `Pantau tren media sosial (Instagram, TikTok, X) yang relevan: topik, format, audio/hashtag yang sedang ramai, dan konten kompetitor. Buat 5 ide konten siap pakai (hook, caption, hashtag, waktu posting terbaik). ${WEB}`,
  },
  {
    key: 'competitor', label: 'Pantau kompetitor', title: 'Pantauan kompetitor', mode: 'business', frequency: 'weekly', weekdays: [3], time_of_day: '10:00',
    description: `Pantau kompetitor utama: harga, promo, produk baru, ulasan pelanggan, dan aktivitas media sosial mereka sejak pemantauan terakhir. Hasil: tabel perubahan, ancaman/peluang, dan respons yang disarankan. ${WEB}`,
  },
  {
    key: 'report', label: 'Laporan mingguan', title: 'Laporan kinerja mingguan', mode: 'holding', frequency: 'weekly', weekdays: [5], time_of_day: '16:00',
    description: 'Susun laporan kinerja minggu ini untuk semua bisnis: pencapaian, tugas selesai/gagal, keuangan yang tercatat, risiko, dan prioritas minggu depan. Gunakan data yang sudah ada di sistem; jangan meminta admin mengisi data manual.',
  },
  {
    key: 'promo', label: 'Ide promo bulanan', title: 'Rencana promo bulan ini', mode: 'business', frequency: 'monthly', day_of_month: 1, time_of_day: '09:00',
    description: `Buat rencana promo bulan ini: momen/hari besar bulan ini, tren musiman, ide promo dengan perkiraan biaya dan target, serta jadwal eksekusi. ${WEB}`,
  },
];

const parseDays = (v) => {
  try {
    const a = Array.isArray(v) ? v : JSON.parse(v || '[]');
    return [...new Set(a.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort();
  } catch {
    return [];
  }
};

/** Next run strictly after `from` (ms) for a rule, in timezone tz. */
export function nextRunAt(r, from = Date.now(), tz = getSetting('timezone')) {
  const [hh, mm] = String(r.time_of_day || '08:00').split(':').map(Number);
  const at = (dateStr) => dayRange(dateStr, tz)[0] + (hh * 60 + mm) * 60_000;
  if (r.frequency === 'hours') {
    const step = Math.max(1, Math.min(24, Number(r.every_hours) || 1)) * 3_600_000;
    const anchor = at(localDate(from, tz));
    return anchor + (Math.floor((from - anchor) / step) + 1) * step;
  }
  const days = r.frequency === 'weekdays' ? [1, 2, 3, 4, 5] : r.frequency === 'weekly' ? parseDays(r.weekdays) : [1, 2, 3, 4, 5, 6, 7];
  const p = zonedParts(from, tz);
  for (let i = 0; i < 400; i++) {
    const u = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const iso = ((u.getUTCDay() + 6) % 7) + 1;
    if (r.frequency === 'monthly' ? u.getUTCDate() !== Number(r.day_of_month || 1) : !days.includes(iso)) continue;
    const t = at(u.toISOString().slice(0, 10));
    if (t > from) return t;
  }
  return null;
}

/** Human-readable schedule (Indonesian). */
export function describeSchedule(r) {
  const t = r.time_of_day || '08:00';
  switch (r.frequency) {
    case 'daily': return `Setiap hari pukul ${t}`;
    case 'weekdays': return `Senin–Jumat pukul ${t}`;
    case 'weekly': {
      const d = parseDays(r.weekdays).map((x) => DAY[x]);
      return `Setiap ${d.length > 1 ? `${d.slice(0, -1).join(', ')} & ${d.at(-1)}` : d[0] || 'Senin'} pukul ${t}`;
    }
    case 'monthly': return `Tanggal ${r.day_of_month || 1} setiap bulan pukul ${t}`;
    case 'hours': return `Setiap ${r.every_hours || 1} jam mulai pukul ${t}`;
    default: return r.frequency;
  }
}

// Validate and normalise input (create: all fields; update: merged onto the existing rule).
function normalize(input, base = {}) {
  const r = { ...base, ...input };
  r.title = String(r.title || '').trim();
  if (r.title.length < 3 || r.title.length > 200) throw httpError('Judul 3–200 karakter');
  r.description = String(r.description || '');
  if (r.description.length > 20000) throw httpError('Instruksi maksimal 20.000 karakter');
  if (!MODES.includes(r.mode)) throw httpError('Jenis tugas tidak dikenal');
  if (!PRIORITIES.includes(r.priority || 'normal')) throw httpError('Prioritas tidak dikenal');
  r.priority = r.priority || 'normal';
  if (!FREQUENCIES.includes(r.frequency)) throw httpError('Frekuensi tidak dikenal');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time_of_day || '')) throw httpError('Jam harus format HH:MM');
  r.weekdays = r.frequency === 'weekly' ? parseDays(r.weekdays) : [];
  if (r.frequency === 'weekly' && !r.weekdays.length) throw httpError('Pilih minimal satu hari');
  r.day_of_month = r.frequency === 'monthly' ? Number(r.day_of_month) : null;
  if (r.frequency === 'monthly' && !(Number.isInteger(r.day_of_month) && r.day_of_month >= 1 && r.day_of_month <= 28)) throw httpError('Tanggal 1–28');
  r.every_hours = r.frequency === 'hours' ? Number(r.every_hours) : null;
  if (r.frequency === 'hours' && !(Number.isInteger(r.every_hours) && r.every_hours >= 1 && r.every_hours <= 24)) throw httpError('Interval 1–24 jam');
  r.business_id = r.business_id ? Number(r.business_id) : null;
  r.employee_id = r.mode === 'direct' && r.employee_id ? Number(r.employee_id) : null;
  // Same hierarchy rules as a manual task (business active, employee may work for that business, ...).
  resolveOwnerTask({ mode: r.mode, title: r.title, businessId: r.business_id, employeeId: r.employee_id });
  return r;
}

export function getRecurring(id) {
  return q.get('SELECT * FROM recurring_tasks WHERE id = ?', id) || null;
}

export function toPublic(r) {
  return {
    ...r,
    weekdays: parseDays(r.weekdays),
    enabled: Boolean(r.enabled),
    skip_if_running: Boolean(r.skip_if_running),
    schedule: describeSchedule(r),
  };
}

export function listRecurring() {
  return q.all(
    `SELECT r.*, b.name AS business_name, b.color AS business_color, e.name AS employee_name,
       t.status AS last_task_status, t.title AS last_task_title
     FROM recurring_tasks r
     LEFT JOIN businesses b ON b.id = r.business_id
     LEFT JOIN employees e ON e.id = r.employee_id
     LEFT JOIN tasks t ON t.id = r.last_task_id
     ORDER BY r.enabled DESC, r.next_run_at IS NULL, r.next_run_at, r.id`
  ).map(toPublic);
}

export function createRecurring(input, by = 'owner') {
  const r = normalize({ skip_if_running: true, enabled: true, ...input });
  const t = now();
  const next = r.enabled ? nextRunAt(r, Date.now()) : null;
  const res = q.run(
    `INSERT INTO recurring_tasks(title, description, mode, business_id, employee_id, priority, frequency, time_of_day, weekdays,
       day_of_month, every_hours, template, skip_if_running, enabled, next_run_at, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    r.title, r.description, r.mode, r.business_id, r.employee_id, r.priority, r.frequency, r.time_of_day, JSON.stringify(r.weekdays),
    r.day_of_month, r.every_hours, r.template || null, r.skip_if_running ? 1 : 0, r.enabled ? 1 : 0, next, by, t, t
  );
  return getRecurring(res.lastInsertRowid);
}

export function updateRecurring(id, input) {
  const cur = getRecurring(id);
  if (!cur) throw httpError('Tugas berulang tidak ditemukan', 404);
  const base = { ...cur, weekdays: parseDays(cur.weekdays), enabled: Boolean(cur.enabled), skip_if_running: Boolean(cur.skip_if_running) };
  const r = normalize(input, base);
  // The schedule changed or the rule was switched on: plan the next run from now.
  const scheduleChanged = ['frequency', 'time_of_day', 'weekdays', 'day_of_month', 'every_hours'].some((k) => k in input) || (r.enabled && !cur.enabled);
  const next = !r.enabled ? null : scheduleChanged || !cur.next_run_at ? nextRunAt(r, Date.now()) : cur.next_run_at;
  q.run(
    `UPDATE recurring_tasks SET title = ?, description = ?, mode = ?, business_id = ?, employee_id = ?, priority = ?, frequency = ?,
       time_of_day = ?, weekdays = ?, day_of_month = ?, every_hours = ?, skip_if_running = ?, enabled = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
    r.title, r.description, r.mode, r.business_id, r.employee_id, r.priority, r.frequency, r.time_of_day, JSON.stringify(r.weekdays),
    r.day_of_month, r.every_hours, r.skip_if_running ? 1 : 0, r.enabled ? 1 : 0, next, now(), id
  );
  return getRecurring(id);
}

export function deleteRecurring(id) {
  const cur = getRecurring(id);
  if (!cur) throw httpError('Tugas berulang tidak ditemukan', 404);
  q.run('DELETE FROM recurring_tasks WHERE id = ?', id); // tasks it created stay (recurring_id -> NULL)
  return cur;
}

// Create the task for one run. manual: "Jalankan sekarang" (never skipped, schedule unchanged).
function fire(r, at, { manual = false } = {}) {
  const tz = getSetting('timezone');
  if (!manual && r.skip_if_running && r.last_task_id) {
    const last = q.get('SELECT status FROM tasks WHERE id = ?', r.last_task_id);
    if (last && ACTIVE.has(last.status)) {
      q.run("UPDATE recurring_tasks SET last_status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?", 'Dilewati: tugas sebelumnya masih berjalan', now(), r.id);
      return { id: r.id, skipped: true };
    }
  }
  const stamp = r.frequency === 'hours' ? `${displayDate(localDate(at, tz))} ${localTime(at, tz)}` : displayDate(localDate(at, tz));
  const note = `\n\n---\nTugas berulang (${describeSchedule(r)}). Lanjutkan dari hasil sebelumnya bila ada; fokus pada hal yang baru atau berubah.`;
  try {
    const t = createOwnerTask({
      mode: r.mode, title: truncate(`${r.title} · ${stamp}`, 200), description: `${r.description}${note}`, priority: r.priority,
      businessId: r.business_id, employeeId: r.employee_id, createdBy: `recurring:${r.id}`,
    });
    q.run('UPDATE tasks SET recurring_id = ? WHERE id = ?', r.id, t.id);
    q.run(
      "UPDATE recurring_tasks SET last_run_at = ?, last_task_id = ?, last_status = 'created', last_error = NULL, run_count = run_count + 1, updated_at = ? WHERE id = ?",
      at, t.id, now(), r.id
    );
    return { id: r.id, task_id: t.id };
  } catch (e) {
    q.run("UPDATE recurring_tasks SET last_status = 'error', last_error = ?, updated_at = ? WHERE id = ?", truncate(e.message, 300), now(), r.id);
    bus.emit('system:alert', { key: `recurring-${r.id}`, title: `Tugas berulang "${r.title}" gagal dibuat`, message: e.message });
    return { id: r.id, error: e.message };
  }
}

/** Scheduler hook: create the tasks of every due rule (each due run exactly once). */
export function runDueRecurring(at = Date.now()) {
  const tz = getSetting('timezone');
  const out = [];
  for (const r of q.all('SELECT * FROM recurring_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20', at)) {
    const next = nextRunAt(r, Math.max(at, r.next_run_at), tz);
    const claimed = q.run('UPDATE recurring_tasks SET next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?', next, now(), r.id, r.next_run_at).changes;
    if (claimed) out.push(fire(r, at));
  }
  return out;
}

export function runRecurringNow(id) {
  const r = getRecurring(id);
  if (!r) throw httpError('Tugas berulang tidak ditemukan', 404);
  const res = fire(r, Date.now(), { manual: true });
  if (res.error) throw httpError(res.error);
  return res;
}
