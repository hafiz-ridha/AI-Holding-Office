// system_settings key/value store with typed defaults and an in-memory cache.
import { q, now } from '../db/index.js';
import { isValidTimezone } from './time.js';
import { config } from '../config.js';

// Each setting: default value + validator. Validators return the cleaned value or throw.
const int = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`harus bilangan bulat ${min}–${max}`);
  return n;
};
const boolean = (v) => {
  if (typeof v !== 'boolean') throw new Error('harus true/false');
  return v;
};
const hhmm = (v) => {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error('format HH:MM');
  return v;
};
const tz = (v) => {
  if (typeof v !== 'string' || !isValidTimezone(v)) throw new Error('zona waktu tidak valid');
  return v;
};

export const TIERS = ['group_ceo', 'business_manager', 'shared_services', 'business_staff'];
const tierModels = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('harus objek');
  const out = {};
  for (const t of TIERS) {
    const e = v[t] || {};
    const pid = e.provider_id === null || e.provider_id === undefined || e.provider_id === '' ? null : Number(e.provider_id);
    if (pid !== null && !Number.isInteger(pid)) throw new Error(`${t}.provider_id tidak valid`);
    const model = e.model ? String(e.model).trim().slice(0, 200) : null;
    out[t] = { provider_id: pid, model };
  }
  return out;
};

const oneOf = (...values) => (v) => {
  if (!values.includes(v)) throw new Error(`harus salah satu dari: ${values.join(', ')}`);
  return v;
};

export const SETTINGS = {
  model_routing: {
    def: 'auto',
    validate: oneOf('auto', 'manual'),
    label: 'Pemilihan model AI: auto = pilih model terbaik sesuai kebutuhan tugas, manual = urutan default lalu cadangan',
  },
  tier_models: {
    def: Object.fromEntries(TIERS.map((t) => [t, { provider_id: null, model: null }])),
    validate: tierModels,
    label: 'Model default per tingkatan (Group CEO, Business Manager, Shared Services, staf bisnis)',
  },
  group_ceo_cross_business: { def: true, validate: boolean, label: 'Izinkan Group CEO membaca ringkasan lintas bisnis' },
  max_business_tasks: { def: 5, validate: int(1, 20), label: 'Maksimum business task per instruksi holding' },
  max_shared_tasks: { def: 2, validate: int(0, 10), label: 'Maksimum tugas Shared Services per instruksi holding' },
  bm_max_subtasks: { def: 2, validate: int(0, 10), label: 'Maksimum subtugas yang dibuat Business Manager' },
  max_concurrency: { def: 1, validate: int(1, 8), label: 'Jumlah pekerjaan AI bersamaan' },
  max_daily_requests: { def: 200, validate: int(0, 100000), label: 'Maksimum request AI per hari (0 = tanpa batas)' },
  max_tokens_per_task: { def: 12000, validate: int(500, 500000), label: 'Batas token per pekerjaan' },
  max_output_tokens: { def: 1500, validate: int(64, 32000), label: 'Maksimum token output per panggilan' },
  max_subtasks: { def: 4, validate: int(1, 10), label: 'Maksimum subtugas yang dibuat CEO' },
  max_task_attempts: { def: 3, validate: int(1, 10), label: 'Maksimum percobaan ulang per tugas' },
  max_model_attempts: { def: 4, validate: int(1, 10), label: 'Maksimum kandidat model per panggilan' },
  retry_delay_minutes: { def: 10, validate: int(1, 1440), label: 'Jeda sebelum tugas pending dicoba lagi (menit)' },
  memory_items: { def: 5, validate: int(0, 20), label: 'Jumlah memori kerja yang disertakan dalam prompt' },
  knowledge_enabled: { def: true, validate: boolean, label: 'Second Brain: simpan hasil kerja sebagai catatan dan berikan catatan relevan ke AI' },
  knowledge_items: { def: 4, validate: int(0, 10), label: 'Jumlah catatan Second Brain per panggilan AI' },
  web_research_enabled: { def: true, validate: boolean, label: 'Riset web otomatis: untuk tugas yang butuh data terbaru (tren, berita, media sosial, kompetitor, harga), server mencari dan membaca sumber di internet lalu memberikannya ke AI (tanpa API key)' },
  web_research_pages: { def: 2, validate: int(0, 5), label: 'Jumlah halaman web yang dibaca per riset (0 = hanya judul berita & hasil pencarian)' },
  approval_important_only: { def: true, validate: boolean, label: 'Persetujuan owner hanya untuk tindakan penting (uang, kontrak, SDM, harga, publikasi, hukum, data rahasia); informasi biasa dan permintaan data tidak perlu persetujuan' },
  queue_paused: { def: false, validate: boolean, label: 'Antrean dijeda' },
  timezone: { def: config.defaultTimezone, validate: tz, label: 'Zona waktu' },
  backup_enabled: { def: true, validate: boolean, label: 'Backup otomatis harian' },
  backup_time: { def: '02:00', validate: hhmm, label: 'Jam backup' },
  backup_retention: { def: 7, validate: int(1, 90), label: 'Jumlah file backup yang disimpan' },
  log_retention_days: { def: 90, validate: int(7, 3650), label: 'Simpan log selama (hari)' },
  session_ttl_hours: { def: 12, validate: int(1, 720), label: 'Durasi sesi login (jam)' },
};

const cache = new Map();

export function getSetting(key) {
  if (!(key in SETTINGS)) throw new Error(`Setting tidak dikenal: ${key}`);
  if (cache.has(key)) return cache.get(key);
  const row = q.get('SELECT value FROM system_settings WHERE key = ?', key);
  let val = SETTINGS[key].def;
  if (row) {
    try {
      val = JSON.parse(row.value);
    } catch {}
  }
  cache.set(key, val);
  return val;
}

export function getAllSettings() {
  const out = {};
  for (const k of Object.keys(SETTINGS)) out[k] = getSetting(k);
  return out;
}

export function setSetting(key, value) {
  const def = SETTINGS[key];
  if (!def) throw new Error(`Setting tidak dikenal: ${key}`);
  let clean;
  try {
    clean = def.validate(value);
  } catch (e) {
    const err = new Error(`${key}: ${e.message}`);
    err.statusCode = 400;
    throw err;
  }
  q.run(
    `INSERT INTO system_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(clean),
    now()
  );
  cache.set(key, clean);
  return clean;
}

export function clearSettingsCache() {
  cache.clear();
}
