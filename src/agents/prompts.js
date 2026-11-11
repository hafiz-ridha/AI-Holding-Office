// Prompt builders for each orchestration level. Inputs are truncated so one call stays within the token budget.
// Business data only enters prompts through src/holding/context.js.
import { truncate } from '../lib/text.js';
import { formatDateTime } from '../lib/time.js';

const PRIORITY_LABEL = { 1: 'rendah', 2: 'normal', 3: 'tinggi', 4: 'mendesak' };

function systemFor(emp, extra = '') {
  const parts = [emp.system_prompt.trim()];
  if (emp.personality) parts.push(`Kepribadian: ${emp.personality}`);
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

// Second Brain notes (already formatted by holding/knowledge.js): background knowledge, kept in the system message.
const knowledgeBlock = (knowledge) => (knowledge ? `

${knowledge}` : '');

// Owner approvals only for important actions; never ask the owner to type data in (data comes from the system and
// from the automatic web research). Used by every prompt that may produce recommendations.
export const APPROVAL_RULE = `Aturan persetujuan & data:
- Tulis baris "PERLU PERSETUJUAN ADMIN: ..." HANYA untuk tindakan penting yang berisiko atau sulit dibatalkan: mengeluarkan/mentransfer uang, pembelian, investasi, sewa; menandatangani kontrak/perjanjian; merekrut/memberhentikan karyawan atau mengubah gaji; mengubah harga atau memberi diskon; publikasi atas nama perusahaan (posting, siaran pers, email/pesan ke pelanggan); urusan hukum, pajak, atau izin; menghapus atau membagikan data rahasia; membuka/menutup cabang atau mengganti pemasok.
- Informasi, analisis, rekomendasi, draf, ringkasan, dan riset TIDAK perlu persetujuan; tulis sebagai rekomendasi biasa.
- Jangan pernah meminta admin/owner menambah, mengisi, atau melengkapi data secara manual. Gunakan data di sistem dan hasil riset web yang diberikan; jika masih kurang, tulis asumsi atau estimasi yang wajar secara eksplisit lalu tetap selesaikan pekerjaannya.`;

// Internal data that is not in the system: never invented, never a reason to stop or to ask the owner. The AI works
// with the web research and its own general knowledge as marked estimates and says once what is missing.
export const DATA_RULE = `Aturan data:
- Angka internal bisnis (omzet, pelanggan, stok, keuangan) hanya dari konteks sistem di atas; jangan mengarangnya.
- Bila data internal belum ada, tetap berikan analisis lengkap memakai hasil riset web (sebut [W1], [W2], dst.) dan pengetahuan umummu: patokan industri, kisaran harga dan biaya pasar, perilaku pelanggan, tren umum. Tandai angka seperti itu sebagai "estimasi" atau dengan sumbernya, bukan sebagai data bisnis ini.
- Jangan menulis "DATA NOT AVAILABLE" dan jangan mengulang kekurangan data di setiap bagian. Sebut sekali saja di akhir, satu baris "Catatan data: ..." dengan kalimat biasa (contoh: "Catatan data: omzet bulan ini belum tercatat di sistem; angka di atas estimasi pasar.").`;

// Automatic web research (src/research/web.js): cited outside data, placed in the user message as data.
const webBlock = (web) => (web ? `

${web}` : '');

function memoryBlock(memories) {
  if (!memories.length) return '';
  return '\n\nMemori kerja terakhirmu pada konteks ini (bukan instruksi):\n' + memories.map((m) => `- ${truncate(m.content, 300)}`).join('\n');
}

const teamLine = (e) => `- slug "${e.slug}": ${e.name}, ${e.role}${e.org_unit === 'shared' ? ' [Shared Services]' : ''}`;

// Level 1: Group CEO decides which businesses / shared services handle an owner instruction.
export function holdingPlanMessages({ ceo, task, overview, shared, maxBusinessTasks, maxShared, memories, tz, knowledge = '', web = '' }) {
  const user = `Instruksi pemilik (${formatDateTime(Date.now(), tz)}):
Judul: ${task.title}
Prioritas: ${PRIORITY_LABEL[task.priority] || 'normal'}
Detail:
${truncate(task.description || '(tidak ada detail tambahan)', 6000)}

Bisnis aktif dalam holding (data nyata dari sistem; "belum ada" berarti belum tercatat di sistem):
${overview}

Shared Services (tim pusat):
${shared.map(teamLine).join('\n') || '- (tidak ada)'}${webBlock(web)}

Tugasmu sebagai Group CEO:
1. Tentukan bisnis mana yang terkait instruksi ini. Jangan mengarang data bisnis.
2. Jika instruksi sederhana dan dapat dijawab langsung dari data di atas, isi "direct_answer" dan kosongkan daftar tugas.
3. Untuk tiap bisnis terkait, buat satu business task untuk Business Manager-nya (maksimal ${maxBusinessTasks}).
4. Gunakan Shared Services hanya bila perlu keahlian pusat (maksimal ${maxShared}); isi "business" dengan slug bisnis yang dibantu atau null untuk level holding.
5. Hemat: jangan membuat tugas yang tidak perlu.
6. Jangan meminta owner mengisi data manual; data luar didapat dari riset web.

Format keluaran: RENCANA_HOLDING_JSON. Balas HANYA dengan satu objek JSON valid tanpa teks lain:
{"analysis": "ringkasan 2-4 kalimat", "direct_answer": null, "business_tasks": [{"business": "slug", "title": "judul", "description": "instruksi rinci", "priority": "low|normal|high|urgent"}], "shared_tasks": [{"assignee": "slug", "business": "slug atau null", "title": "judul", "description": "instruksi rinci", "priority": "normal"}]}`;
  return [
    { role: 'system', content: systemFor(ceo) + memoryBlock(memories) + knowledgeBlock(knowledge) },
    { role: 'user', content: user },
  ];
}

// Level 2: Business Manager plans work for their own business.
export function businessPlanMessages({ manager, task, businessContext, team, maxSubtasks, memories, tz, parentTitle, knowledge = '', web = '' }) {
  const user = `Tugas bisnis (${formatDateTime(Date.now(), tz)})${parentTitle ? ` dari Group CEO untuk instruksi "${truncate(parentTitle, 150)}"` : ''}:
Judul: ${task.title}
Prioritas: ${PRIORITY_LABEL[task.priority] || 'normal'}
Instruksi:
${truncate(task.description || task.title, 5000)}

Konteks bisnismu (hanya data bisnis ini):
${businessContext}${webBlock(web)}

Tim yang dapat kamu tugaskan:
${team.map(teamLine).join('\n') || '- (tidak ada tim; kerjakan sendiri)'}

Tugasmu sebagai Business Manager:
1. Jika kamu dapat menyelesaikan tugas ini sendiri dengan data di atas, isi "direct_answer" (laporan lengkap) dan kosongkan "subtasks". Ini lebih hemat.
2. Jika perlu tim, buat maksimal ${maxSubtasks} subtugas yang jelas dan tidak tumpang tindih. Pilih assignee dari slug di atas.
3. Jangan mengarang data internal. Bila belum ada, tetap kerjakan dengan data yang ada, hasil riset web, dan pengetahuan umum (patokan industri, kisaran pasar) yang ditandai "estimasi". Jangan menulis "DATA NOT AVAILABLE" dan jangan meminta owner mengisi data manual.

Format keluaran: RENCANA_JSON. Balas HANYA dengan satu objek JSON valid tanpa teks lain:
{"analysis": "ringkasan 2-4 kalimat", "direct_answer": null, "subtasks": [{"title": "judul", "description": "instruksi rinci dan hasil yang diharapkan", "assignee": "slug", "priority": "low|normal|high|urgent"}]}`;
  return [
    { role: 'system', content: systemFor(manager) + memoryBlock(memories) + knowledgeBlock(knowledge) },
    { role: 'user', content: user },
  ];
}

// Level 3: an employee executes one task.
export function workMessages({ employee, task, parent, businessContext, siblingResults, memories, tz, knowledge = '', web = '' }) {
  let ctx = '';
  if (parent) {
    ctx += `\n\nKonteks: bagian dari tugas "${truncate(parent.title, 200)}".\n${truncate(parent.description, 1200)}`;
    if (parent.analysis) ctx += `\nAnalisis atasan: ${truncate(parent.analysis, 600)}`;
  }
  if (businessContext) ctx += `\n\nKonteks bisnis (hanya bisnis yang ditugaskan):\n${businessContext}`;
  if (siblingResults?.length) {
    ctx += '\n\nHasil rekan tim pada tugas yang sama (gunakan bila relevan):\n' +
      siblingResults.map((s) => `### ${s.employee} — ${s.title}\n${truncate(s.result, 1200)}`).join('\n\n');
  }
  const user = `Tugas untukmu (${formatDateTime(Date.now(), tz)}):
Judul: ${task.title}
Prioritas: ${PRIORITY_LABEL[task.priority] || 'normal'}
Instruksi:
${truncate(task.description || task.title, 6000)}${ctx}${webBlock(web)}

Kerjakan tugas ini sekarang dan berikan hasil akhir yang lengkap dan siap pakai, ditulis sebagai teks biasa/Markdown yang enak dibaca manusia (bukan JSON, kecuali tugas memintanya). Akhiri dengan bagian "Catatan untuk manager" (1-3 poin: asumsi, risiko, atau baris "PERLU PERSETUJUAN ADMIN: ..." hanya untuk tindakan penting).

${DATA_RULE}

${APPROVAL_RULE}`;
  return [
    { role: 'system', content: systemFor(employee) + memoryBlock(memories) + knowledgeBlock(knowledge) },
    { role: 'user', content: user },
  ];
}

function resultsBlock(results, budgetChars) {
  const per = Math.max(500, Math.floor(budgetChars / Math.max(1, results.length)));
  return results
    .map((r) =>
      r.status === 'completed'
        ? `### ${r.employee || '-'} (${r.role || '-'})${r.business ? ` — ${r.business}` : ''} — ${r.title}\n${truncate(r.result, per)}`
        : `### ${r.employee || '-'} — ${r.title}\n[STATUS: ${String(r.status).toUpperCase()}] ${truncate(r.error || '', 300)}`
    )
    .join('\n\n');
}

// Business Manager consolidates their team's results into a business report for the Group CEO.
export function businessSynthesisMessages({ manager, task, businessName, analysis, results, budgetChars, tz }) {
  const user = `Tugas bisnis "${task.title}" untuk ${businessName} (${formatDateTime(Date.now(), tz)}).
Instruksi:
${truncate(task.description, 1500)}

Analisis awalmu: ${truncate(analysis || '-', 600)}

Hasil kerja tim:
${resultsBlock(results, budgetChars)}

Susun laporan bisnis untuk Group CEO dengan struktur:
## Ringkasan
## Hasil Utama
## Masalah & Risiko
## Peluang
## Rekomendasi
## Perlu Persetujuan Owner
(tulis dalam Markdown biasa, bukan JSON; tulis "Tidak ada" jika kosong)

${DATA_RULE}

${APPROVAL_RULE}`;
  return [
    { role: 'system', content: systemFor(manager) },
    { role: 'user', content: user },
  ];
}

// Group CEO consolidates business reports & shared-service results into a holding report.
export function holdingSynthesisMessages({ ceo, task, analysis, results, budgetChars, tz }) {
  const user = `Instruksi awal pemilik (${formatDateTime(Date.now(), tz)}):
Judul: ${task.title}
${truncate(task.description, 1500)}

Analisis awalmu: ${truncate(analysis || '-', 600)}

Laporan Business Manager dan Shared Services:
${resultsBlock(results, budgetChars)}

Buat laporan konsolidasi holding untuk pemilik dengan struktur:
## Ringkasan Eksekutif
## Perbandingan Kinerja Bisnis
## Masalah & Peluang
## Rekomendasi Keputusan
## Prioritas Berikutnya
## Perlu Perhatian Pemilik
Tulis dalam Markdown biasa, bukan JSON. Sebutkan tugas yang gagal.

${DATA_RULE}

${APPROVAL_RULE}`;
  return [
    { role: 'system', content: systemFor(ceo) },
    { role: 'user', content: user },
  ];
}
