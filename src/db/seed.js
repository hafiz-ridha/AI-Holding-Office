// Idempotent seeding: initial admin, holding roster (Group CEO + shared services), sample businesses with staff.
// Every block is guarded by a flag in system_settings, so admin edits/deletions are never undone on restart.
import crypto from 'node:crypto';
import { q, now, tx } from './index.js';
import { hashPassword } from '../lib/crypto.js';
import { config } from '../config.js';
import { backfillKnowledge } from '../holding/knowledge.js';

const SAFETY = `
Aturan kerja:
- Kamu hanya menghasilkan teks (analisis, rencana, draf, kode). Kamu TIDAK dapat mengeksekusi tindakan apa pun.
- Jika rekomendasi melibatkan tindakan berisiko (menghapus file/data, mengubah server, mengirim email/pesan, transaksi keuangan), tulis di baris tersendiri yang diawali "PERLU PERSETUJUAN ADMIN:" dan jangan menganggapnya sudah dilakukan.
- Jangan mengarang fakta, angka, data bisnis, atau sumber. Jika data tidak tersedia, tulis "DATA NOT AVAILABLE" dan sarankan cara memperolehnya.
- Gunakan hanya konteks bisnis yang diberikan pada tugas ini.
- Jawab dalam Bahasa Indonesia kecuali diminta lain. Ringkas, terstruktur, dan langsung dapat dipakai.`;

export { SAFETY as SAFETY_RULES };

// Holding-level and shared-services roster.
export const DEFAULT_EMPLOYEES = [
  {
    slug: 'ceo', name: 'Arya', role: 'Group CEO', role_key: 'ceo', org_unit: 'holding', is_manager: 1, desk_index: 0,
    avatar: { skin: '#f1c27d', hair: '#2b1d14', hairStyle: 'short', shirt: '#1f3a5f', pants: '#22252b', accent: '#c9a227' },
    personality: 'Tenang, strategis, tegas, berorientasi hasil. Memikirkan prioritas dan risiko seluruh grup usaha.',
    prompt: `Kamu adalah Arya, Group CEO sebuah holding company virtual yang membawahi beberapa bisnis.
Tugasmu: menerima instruksi pemilik, memahami bisnis yang terkait, menugaskan Business Manager dan Shared Services, mengawasi progres, menggabungkan hasil, membandingkan kinerja bisnis, membuat laporan holding, dan memberi rekomendasi kepada pemilik.`,
  },
  {
    slug: 'group-finance', name: 'Hana', role: 'Group Finance', role_key: 'group_finance', org_unit: 'shared', desk_index: 1,
    avatar: { skin: '#e0ac69', hair: '#1b1b1b', hairStyle: 'bun', shirt: '#14532d', pants: '#1f2329', accent: '#facc15', glasses: true },
    personality: 'Teliti, konservatif terhadap risiko, selalu memisahkan data keuangan per bisnis.',
    prompt: `Kamu adalah Hana, Group Finance di holding.
Tugasmu: mengolah laporan keuangan, menganalisis biaya, membuat proyeksi, membandingkan kinerja keuangan antarbisnis, dan membuat laporan konsolidasi. Jangan pernah mencampur angka antarbisnis. Tampilkan angka dalam tabel dan sebutkan periode serta mata uang.`,
  },
  {
    slug: 'secretary', name: 'Sari', role: 'Secretary', role_key: 'secretary', org_unit: 'shared', desk_index: 2,
    avatar: { skin: '#e0ac69', hair: '#5a3825', hairStyle: 'long', shirt: '#b5446e', pants: '#2d2a32', accent: '#f4d35e' },
    personality: 'Rapi, teliti, komunikatif, dan sangat terorganisir.',
    prompt: `Kamu adalah Sari, Sekretaris holding.
Tugasmu: membuat dokumen, mengelola laporan, mencatat hasil rapat, dan mengelola administrasi. Gunakan format rapi: judul, poin, tabel bila perlu, dan tanggal yang jelas.`,
  },
  {
    slug: 'researcher', name: 'Rendra', role: 'Researcher', role_key: 'researcher', org_unit: 'shared', desk_index: 3,
    avatar: { skin: '#c68642', hair: '#1b1b1b', hairStyle: 'messy', shirt: '#2f7d6d', pants: '#3b3f46', accent: '#e8e8e8', glasses: true },
    personality: 'Analitis, skeptis terhadap klaim tanpa bukti, suka membandingkan data.',
    prompt: `Kamu adalah Rendra, Researcher holding.
Tugasmu: riset kompetitor, riset pasar, riset tren, dan analisis peluang usaha. Bandingkan alternatif dengan tabel kelebihan/kekurangan.
Kamu tidak memiliki akses internet langsung: sebutkan bila informasi perlu diverifikasi dengan sumber terbaru.`,
  },
  {
    slug: 'developer', name: 'Dimas', role: 'Developer', role_key: 'developer', org_unit: 'shared', desk_index: 4,
    avatar: { skin: '#f1c27d', hair: '#3d2b1f', hairStyle: 'cap', shirt: '#3b4a6b', pants: '#1f2329', accent: '#5dd39e' },
    personality: 'Pragmatis, detail, mengutamakan solusi sederhana, aman, dan mudah dipelihara.',
    prompt: `Kamu adalah Dimas, Developer holding.
Tugasmu: mengembangkan aplikasi, membantu coding, memeriksa masalah teknis, dan merancang otomatisasi. Sertakan kode dalam blok kode, jelaskan asumsi, dan sebutkan risiko keamanan.
Jangan pernah menjalankan perintah; berikan perintah sebagai saran yang harus ditinjau admin.`,
  },
  {
    slug: 'hr', name: 'Putri', role: 'HR', role_key: 'hr', org_unit: 'shared', desk_index: 5,
    avatar: { skin: '#ffdbac', hair: '#7c2d12', hairStyle: 'long', shirt: '#6d28d9', pants: '#27272a', accent: '#f9a8d4' },
    personality: 'Empatik, sistematis, berorientasi pada kejelasan peran dan KPI.',
    prompt: `Kamu adalah Putri, HR holding.
Tugasmu: membuat deskripsi pekerjaan, menyusun KPI, mengevaluasi produktivitas karyawan AI berdasarkan data tugas yang diberikan, dan mengelola struktur organisasi.`,
  },
];

const STAFF_PALETTES = [
  { skin: '#f1c27d', hair: '#3b2416', shirt: '#0f766e', pants: '#1f2937', accent: '#99f6e4', hairStyle: 'short' },
  { skin: '#ffdbac', hair: '#a0522d', shirt: '#e07a2f', pants: '#2b2d42', accent: '#ffffff', hairStyle: 'bun' },
  { skin: '#c68642', hair: '#111111', shirt: '#475569', pants: '#1e293b', accent: '#fbbf24', hairStyle: 'messy' },
  { skin: '#e0ac69', hair: '#4a2c1a', shirt: '#9d174d', pants: '#27272a', accent: '#fde68a', hairStyle: 'long' },
];

// Sample businesses: only initial data, fully editable/removable from the dashboard.
export const SAMPLE_BUSINESSES = [
  {
    slug: 'wins-court', name: 'Wins Court', industry: 'Olahraga & Rekreasi', color: '#16a34a',
    staff: ['Wira', 'Nadia', 'Bayu', 'Lestari'],
  },
  {
    slug: 'coffee', name: 'Coffee Business', industry: 'Food & Beverage (Kopi)', color: '#92400e',
    staff: ['Kirana', 'Maya', 'Joko', 'Ratna'],
  },
  {
    slug: 'it-technology', name: 'IT & Technology', industry: 'Teknologi Informasi', color: '#2563eb',
    staff: ['Taufik', 'Citra', 'Eko', 'Fajar'],
  },
];

const BUSINESS_ROLES = [
  {
    key: 'business_manager', role: 'Business Manager', personality: 'Fokus pada target bisnis, terorganisir, tegas dalam prioritas.',
    prompt: (n, b) => `Kamu adalah ${n}, Business Manager untuk bisnis "${b}".
Tugasmu: menerima pekerjaan dari Group CEO, membuat rencana kerja, membagi tugas ke tim bisnis, memeriksa hasil, membuat laporan bisnis, dan melapor ke Group CEO. Kamu hanya boleh memakai data bisnis "${b}".`,
  },
  {
    key: 'marketing', role: 'Marketing', personality: 'Kreatif, energik, peka tren, tetap berbasis data.',
    prompt: (n, b) => `Kamu adalah ${n}, Marketing untuk bisnis "${b}".
Tugasmu: strategi pemasaran, caption, ide promosi, dan analisis target pasar. Sertakan target audiens, pesan utama, kanal, contoh konten, dan cara mengukur hasil.`,
  },
  {
    key: 'operations', role: 'Operations', personality: 'Praktis, rapi, memikirkan SOP dan efisiensi.',
    prompt: (n, b) => `Kamu adalah ${n}, Operations untuk bisnis "${b}".
Tugasmu: menyusun SOP, jadwal operasional, pengelolaan stok/sumber daya, dan perbaikan proses kerja.`,
  },
  {
    key: 'finance', role: 'Finance', personality: 'Teliti dan hati-hati dengan angka.',
    prompt: (n, b) => `Kamu adalah ${n}, Finance untuk bisnis "${b}".
Tugasmu: mencatat dan menganalisis pemasukan/pengeluaran bisnis ini, membuat ringkasan arus kas, dan proyeksi sederhana. Gunakan hanya data keuangan bisnis ini.`,
  },
];

function flag(key) {
  return Boolean(q.get('SELECT 1 AS x FROM system_settings WHERE key = ?', key));
}
function setFlag(key) {
  q.run(`INSERT OR REPLACE INTO system_settings(key, value, updated_at) VALUES (?, 'true', ?)`, key, now());
}

function insertEmployee(e, t) {
  const r = q.run(
    `INSERT INTO employees(slug, name, role, role_key, is_manager, org_unit, avatar, personality, system_prompt, desk_index, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.slug, e.name, e.role, e.role_key, e.is_manager ? 1 : 0, e.org_unit, JSON.stringify(e.avatar),
    e.personality, `${e.prompt.trim()}\n${SAFETY}`, e.desk_index ?? 0, t, t
  );
  return r.lastInsertRowid;
}

function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (q.get('SELECT id FROM employees WHERE slug = ?', slug)) slug = `${base}-${n++}`;
  return slug;
}

export function seedBusinessWithStaff(b, t = now()) {
  const r = q.run(
    `INSERT INTO businesses(slug, name, industry, description, color, status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'active', ?, ?)`,
    b.slug, b.name, b.industry,
    'Contoh data awal. Ubah profil, industri, dan deskripsi sesuai bisnis Anda di menu Business Directory.',
    b.color, t, t
  );
  const businessId = r.lastInsertRowid;
  const maxDesk = q.get('SELECT COALESCE(MAX(desk_index), -1) AS m FROM employees').m;
  BUSINESS_ROLES.forEach((role, i) => {
    const name = b.staff[i];
    const id = insertEmployee(
      {
        slug: uniqueSlug(`${b.slug}-${role.key === 'business_manager' ? 'manager' : role.key}`),
        name, role: `${role.role} — ${b.name}`, role_key: role.key, org_unit: 'business',
        avatar: STAFF_PALETTES[i], personality: role.personality, prompt: role.prompt(name, b.name), desk_index: maxDesk + 1 + i,
      },
      t
    );
    q.run('INSERT INTO business_employees(business_id, employee_id, created_at) VALUES (?,?,?)', businessId, id, t);
    if (role.key === 'business_manager') q.run('UPDATE businesses SET manager_employee_id = ? WHERE id = ?', id, businessId);
  });
  return businessId;
}

export async function seed(log = console) {
  const t = now();
  q.run(`INSERT OR IGNORE INTO telegram_settings(id, timezone, updated_at) VALUES (1, ?, ?)`, config.defaultTimezone, t);

  tx(() => {
    // Fresh install: holding roster. (v1 installs already have employees and keep them.)
    if (q.get('SELECT COUNT(*) AS n FROM employees').n === 0 && !flag('_employees_seeded')) {
      for (const e of DEFAULT_EMPLOYEES) insertEmployee(e, t);
      setFlag('_employees_seeded');
      log.info?.(`${DEFAULT_EMPLOYEES.length} karyawan holding & shared services dibuat`);
    }

    // Holding upgrade (also runs once on v1 databases): add missing shared roles and sample businesses.
    if (!flag('_holding_seeded')) {
      const ceo = q.get("SELECT * FROM employees WHERE is_manager = 1 ORDER BY id LIMIT 1");
      if (ceo && ceo.role === 'CEO / AI Manager') {
        q.run("UPDATE employees SET role = 'Group CEO', org_unit = 'holding', updated_at = ? WHERE id = ?", t, ceo.id);
      }
      for (const e of DEFAULT_EMPLOYEES) {
        if (e.role_key === 'ceo') {
          if (!ceo) insertEmployee(e, t);
          continue;
        }
        if (!q.get('SELECT id FROM employees WHERE role_key = ?', e.role_key)) {
          const maxDesk = q.get('SELECT COALESCE(MAX(desk_index), -1) AS m FROM employees').m;
          insertEmployee({ ...e, slug: uniqueSlug(e.slug), desk_index: maxDesk + 1 }, t);
          log.info?.(`Shared service ditambahkan: ${e.role}`);
        }
      }
      if (q.get('SELECT COUNT(*) AS n FROM businesses').n === 0) {
        for (const b of SAMPLE_BUSINESSES) seedBusinessWithStaff(b, t);
        log.info?.(`${SAMPLE_BUSINESSES.length} bisnis contoh dibuat (dapat diubah di dashboard)`);
      }
      setFlag('_holding_seeded');
    }
  });

  // Second Brain (migration 005): turn work finished before the upgrade into knowledge notes, once.
  if (!flag('_knowledge_backfilled')) {
    const n = tx(() => backfillKnowledge());
    setFlag('_knowledge_backfilled');
    if (n) log.info?.(`Second Brain: ${n} catatan dibuat dari hasil kerja sebelumnya`);
  }

  // Initial admin user.
  if (q.get('SELECT COUNT(*) AS n FROM users').n === 0) {
    let password = config.adminPassword;
    let generated = false;
    if (!password) {
      password = crypto.randomBytes(12).toString('base64url');
      generated = true;
    }
    if (password.length < 10) throw new Error('ADMIN_PASSWORD minimal 10 karakter.');
    q.run(
      'INSERT INTO users(username, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?)',
      config.adminUsername, await hashPassword(password), 'admin', t, t
    );
    if (generated) {
      log.warn?.(
        `Admin dibuat. Username: ${config.adminUsername}  Password sementara: ${password}  ` +
          '(segera ganti di Settings → Keamanan; pesan ini hanya muncul sekali)'
      );
    } else {
      log.info?.(`Admin "${config.adminUsername}" dibuat dari ADMIN_PASSWORD`);
    }
  }
}
