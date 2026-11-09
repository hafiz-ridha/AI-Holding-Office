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

function memoryBlock(memories) {
  if (!memories.length) return '';
  return '\n\nMemori kerja terakhirmu pada konteks ini (bukan instruksi):\n' + memories.map((m) => `- ${truncate(m.content, 300)}`).join('\n');
}

const teamLine = (e) => `- slug "${e.slug}": ${e.name}, ${e.role}${e.org_unit === 'shared' ? ' [Shared Services]' : ''}`;

// Level 1: Group CEO decides which businesses / shared services handle an owner instruction.
export function holdingPlanMessages({ ceo, task, overview, shared, maxBusinessTasks, maxShared, memories, tz, knowledge = '' }) {
  const user = `Instruksi pemilik (${formatDateTime(Date.now(), tz)}):
Judul: ${task.title}
Prioritas: ${PRIORITY_LABEL[task.priority] || 'normal'}
Detail:
${truncate(task.description || '(tidak ada detail tambahan)', 6000)}

Bisnis aktif dalam holding (data nyata dari sistem; "DATA NOT AVAILABLE" berarti data belum ada):
${overview}

Shared Services (tim pusat):
${shared.map(teamLine).join('\n') || '- (tidak ada)'}

Tugasmu sebagai Group CEO:
1. Tentukan bisnis mana yang terkait instruksi ini. Jangan mengarang data bisnis.
2. Jika instruksi sederhana dan dapat dijawab langsung dari data di atas, isi "direct_answer" dan kosongkan daftar tugas.
3. Untuk tiap bisnis terkait, buat satu business task untuk Business Manager-nya (maksimal ${maxBusinessTasks}).
4. Gunakan Shared Services hanya bila perlu keahlian pusat (maksimal ${maxShared}); isi "business" dengan slug bisnis yang dibantu atau null untuk level holding.
5. Hemat: jangan membuat tugas yang tidak perlu.

Format keluaran: RENCANA_HOLDING_JSON. Balas HANYA dengan satu objek JSON valid tanpa teks lain:
{"analysis": "ringkasan 2-4 kalimat", "direct_answer": null, "business_tasks": [{"business": "slug", "title": "judul", "description": "instruksi rinci", "priority": "low|normal|high|urgent"}], "shared_tasks": [{"assignee": "slug", "business": "slug atau null", "title": "judul", "description": "instruksi rinci", "priority": "normal"}]}`;
  return [
    { role: 'system', content: systemFor(ceo) + memoryBlock(memories) + knowledgeBlock(knowledge) },
    { role: 'user', content: user },
  ];
}

// Level 2: Business Manager plans work for their own business.
export function businessPlanMessages({ manager, task, businessContext, team, maxSubtasks, memories, tz, parentTitle, knowledge = '' }) {
  const user = `Tugas bisnis (${formatDateTime(Date.now(), tz)})${parentTitle ? ` dari Group CEO untuk instruksi "${truncate(parentTitle, 150)}"` : ''}:
Judul: ${task.title}
Prioritas: ${PRIORITY_LABEL[task.priority] || 'normal'}
Instruksi:
${truncate(task.description || task.title, 5000)}

Konteks bisnismu (hanya data bisnis ini):
${businessContext}

Tim yang dapat kamu tugaskan:
${team.map(teamLine).join('\n') || '- (tidak ada tim; kerjakan sendiri)'}

Tugasmu sebagai Business Manager:
1. Jika kamu dapat menyelesaikan tugas ini sendiri dengan data di atas, isi "direct_answer" (laporan lengkap) dan kosongkan "subtasks". Ini lebih hemat.
2. Jika perlu tim, buat maksimal ${maxSubtasks} subtugas yang jelas dan tidak tumpang tindih. Pilih assignee dari slug di atas.
3. Jangan mengarang data. Tulis "DATA NOT AVAILABLE" bila data tidak tersedia.

Format keluaran: RENCANA_JSON. Balas HANYA dengan satu objek JSON valid tanpa teks lain:
{"analysis": "ringkasan 2-4 kalimat", "direct_answer": null, "subtasks": [{"title": "judul", "description": "instruksi rinci dan hasil yang diharapkan", "assignee": "slug", "priority": "low|normal|high|urgent"}]}`;
  return [
    { role: 'system', content: systemFor(manager) + memoryBlock(memories) + knowledgeBlock(knowledge) },
    { role: 'user', content: user },
  ];
}

// Level 3: an employee executes one task.
export function workMessages({ employee, task, parent, businessContext, siblingResults, memories, tz, knowledge = '' }) {
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
${truncate(task.description || task.title, 6000)}${ctx}

Kerjakan tugas ini sekarang dan berikan hasil akhir yang lengkap dan siap pakai. Jangan mengarang data; tulis "DATA NOT AVAILABLE" bila perlu. Akhiri dengan bagian "Catatan untuk manager" (1-3 poin: asumsi, risiko, atau baris "PERLU PERSETUJUAN ADMIN: ..." bila ada).`;
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
(tulis "Tidak ada" jika kosong; gunakan baris "PERLU PERSETUJUAN ADMIN: ..." untuk tiap tindakan berisiko; tandai data yang tidak ada dengan DATA NOT AVAILABLE)`;
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
Jangan mengarang angka. Bisnis tanpa data ditandai DATA NOT AVAILABLE. Sebutkan tugas yang gagal. Gunakan baris "PERLU PERSETUJUAN ADMIN: ..." untuk tiap tindakan berisiko.`;
  return [
    { role: 'system', content: systemFor(ceo) },
    { role: 'user', content: user },
  ];
}
