// Google Drive tools. The app's Drive access is limited to files it created itself (scope drive.file), and the tools
// only touch files in the index (artifacts) of the task's own business (HQ = no business): no cross-business access.
import { q } from '../../db/index.js';
import { truncate } from '../../lib/text.js';
import { saveDocument, markTrashed, findBusinessArtifact } from '../../connections/artifacts.js';
import * as google from '../../connections/google.js';

const ROLE = { pembaca: 'reader', komentator: 'commenter', editor: 'writer' };

/** A Drive file of this business by index id ("12" / "#12"), link, or exact title. */
function findFile(ctx, ref) {
  const a = findBusinessArtifact(ctx.businessId, 'google_drive', ref);
  if (!a) throw new Error(`File "${truncate(String(ref || ''), 80)}" tidak ditemukan di file bisnis ini. Pakai drive_daftar untuk melihat nomornya.`);
  if (!a.external_id) throw new Error(`File #${a.id} belum tersimpan di Drive (status ${a.status}).`);
  return a;
}

const fileArg = { type: 'string', required: true, max: 500, desc: 'nomor file dari drive_daftar, tautan, atau judul persis' };

export const driveTools = [
  {
    name: 'drive_simpan_dokumen',
    risk: 'safe',
    connector: 'google_drive',
    description: 'Simpan dokumen (SOP, proposal, laporan, rencana, notulen, dll.) sebagai Google Docs di folder bisnis ini. ' +
      'Judul yang sama pada tugas yang sama memperbarui dokumen itu. Jika "isi" dikosongkan, teks yang kamu tulis sebelum blok <tool_call> dipakai sebagai isi.',
    args: {
      judul: { type: 'string', required: true, max: 200 },
      isi: { type: 'string', max: 60000, desc: 'Markdown' },
      jenis: { type: 'string', enum: ['dokumen', 'laporan'], default: 'dokumen' },
    },
    async run(ctx, { judul, isi, jenis }) {
      const markdown = isi || (String(ctx.draft || '').trim().length >= 50 ? ctx.draft : '');
      if (!markdown) throw new Error('isi dokumen kosong: isi argumen "isi" atau tulis dokumennya sebelum blok <tool_call>');
      const a = await saveDocument({
        title: judul, markdown, businessId: ctx.businessId, taskId: ctx.task.id, employeeId: ctx.employee?.id ?? null,
        kind: jenis === 'laporan' ? 'report' : 'document', source: 'agent', signal: ctx.signal,
      });
      if (a.status !== 'synced') {
        return { text: `Dokumen belum tersimpan di Drive (${a.error || a.status}); server akan mencoba lagi otomatis. Nomor file: #${a.id}.`, summary: `gagal sementara: ${truncate(a.error || '', 80)}` };
      }
      return { text: `Tersimpan di Google Drive sebagai "${a.title}" (file #${a.id}): ${a.url}`, summary: `"${truncate(a.title, 60)}" tersimpan`, links: [{ title: a.title, url: a.url }] };
    },
  },
  {
    name: 'drive_daftar',
    risk: 'safe',
    connector: 'google_drive',
    description: 'Daftar file AI Office di Google Drive untuk bisnis ini (nomor, judul, jenis, tautan).',
    args: { cari: { type: 'string', max: 100, desc: 'kata dalam judul (opsional)' } },
    async run(ctx, { cari }) {
      const rows = q.all(
        `SELECT id, title, kind, url, status FROM artifacts WHERE provider = 'google_drive' AND business_id IS ? AND status != 'trashed'
           ${cari ? 'AND title LIKE ?' : ''} ORDER BY id DESC LIMIT 30`,
        ctx.businessId ?? null, ...(cari ? [`%${cari}%`] : [])
      );
      return {
        text: rows.length ? rows.map((r) => `#${r.id} · ${r.title} · ${r.kind}${r.url ? ` · ${r.url}` : ` · ${r.status}`}`).join('\n') : 'Belum ada file untuk bisnis ini.',
        summary: `${rows.length} file`,
      };
    },
  },
  {
    name: 'drive_baca',
    risk: 'safe',
    connector: 'google_drive',
    description: 'Baca isi teks satu dokumen AI Office di Google Drive (bisnis ini), misalnya untuk merevisinya.',
    args: { file: fileArg },
    async run(ctx, { file }) {
      const a = findFile(ctx, file);
      const text = await google.exportText(a.external_id, ctx.signal);
      return { text: `Isi "${a.title}" (file #${a.id}):\n${truncate(text, 6000)}`, summary: `membaca "${truncate(a.title, 60)}"` };
    },
  },
  {
    name: 'drive_bagikan',
    risk: 'important',
    connector: 'google_drive',
    description: 'Bagikan file Drive bisnis ini ke satu email, atau ke siapa saja yang punya tautan (bila email kosong).',
    args: {
      file: fileArg,
      email: { type: 'string', max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, hint: 'alamat email' },
      peran: { type: 'string', enum: ['pembaca', 'komentator', 'editor'], default: 'pembaca' },
    },
    // Checked when the AI asks (before the approval exists): the file must be one of this business's files.
    describe(ctx, { file, email, peran }) {
      const a = findFile(ctx, file);
      return `Bagikan "${a.title}" (Google Drive) ${email ? `ke ${email}` : 'ke siapa saja yang punya tautan'} sebagai ${peran}`;
    },
    async run(ctx, { file, email, peran }) {
      const a = findFile(ctx, file);
      const f = await google.shareFile(a.external_id, { email: email || null, role: ROLE[peran] || 'reader' }, ctx.signal);
      return { text: `"${a.title}" dibagikan ${email ? `ke ${email}` : 'ke siapa saja yang punya tautan'} (${peran}): ${f.url}`, summary: `dibagikan: ${truncate(a.title, 60)}`, links: [{ title: a.title, url: f.url }] };
    },
  },
  {
    name: 'drive_hapus',
    risk: 'important',
    connector: 'google_drive',
    description: 'Pindahkan file Drive bisnis ini ke Sampah (bisa dipulihkan dari Sampah Google Drive selama 30 hari).',
    args: { file: fileArg },
    describe(ctx, { file }) {
      const a = findFile(ctx, file);
      return `Pindahkan "${a.title}" (Google Drive) ke Sampah`;
    },
    async run(ctx, { file }) {
      const a = findFile(ctx, file);
      await google.trashFile(a.external_id, ctx.signal);
      markTrashed(a.id);
      return { text: `"${a.title}" dipindahkan ke Sampah Google Drive.`, summary: `ke Sampah: ${truncate(a.title, 60)}` };
    },
  },
];

