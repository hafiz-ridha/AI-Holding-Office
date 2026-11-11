// Code and website tools (Developer only). Repositories are created private on the owner's GitHub and indexed per
// business; the tools only touch repos of the task's own business. Files come from the code blocks the AI writes before
// the tool call. Publishing a site is an important action: it runs after the owner approves it, on the commit the owner
// could preview.
import { truncate } from '../../lib/text.js';
import { getSetting } from '../../lib/settings.js';
import { findBusinessArtifact } from '../../connections/artifacts.js';
import * as github from '../../connections/github.js';
import {
  registerRepo, setHead, previewUrl, siteMeta, listSites, publishSite, publishText, connectedHosts, HOST_LABEL,
} from '../../sites/index.js';
import { extractFiles, cleanFiles, cleanPath, kb } from '../../sites/files.js';
import { slug } from '../../sites/hosts.js';

const isDeveloper = (employee) => employee?.role_key === 'developer';
const repoArg = { type: 'string', required: true, max: 300, desc: 'nama repo, nomor dari github_daftar, atau tautannya' };
const HOSTS = Object.keys(HOST_LABEL);

export const SITE_GUIDE = `## Membuat website & kode
- Website = situs statis: HTML, CSS, dan JavaScript biasa yang langsung jalan di browser (tanpa npm, build, atau framework yang perlu dikompilasi; library lewat CDN boleh).
- Wajib ada index.html di folder utama. Pakai tautan relatif (style.css, tentang.html, img/logo.svg), jangan diawali "/": GitHub Pages menaruh situs di subfolder.
- Rapi di HP (responsif), bahasa sesuai audiens bisnis. Gambar: URL gambar publik atau SVG buatanmu sendiri.
- Alur: github_buat_repo (sekali per proyek) → tulis file lalu github_simpan_file → ulangi untuk file berikutnya → laporkan tautan repo dan pratinjau.
- Cara menulis file: tulis setiap file lengkap sebagai blok kode dengan nama file di baris tepat di atasnya, lalu akhiri balasan yang sama dengan github_simpan_file:
File: index.html
\`\`\`html
<!doctype html>
...isi lengkap...
\`\`\`
<tool_call>{"name": "github_simpan_file", "args": {"repo": "nama-repo", "pesan": "Halaman utama"}}</tool_call>
- Satu atau dua file per balasan (maksimal ±300 baris); pecah halaman besar (CSS dan JavaScript di file terpisah). File yang sudah tersimpan tidak perlu ditulis ulang; untuk mengubahnya, baca dengan github_baca lalu tulis ulang file itu lengkap.
- Panggil situs_terbitkan hanya bila tugas meminta website online/diterbitkan (tanpa "layanan" = layanan utama pilihan owner). Selain itu cukup laporkan tautan repo dan pratinjau.`;

function findRepo(ctx, ref) {
  const a = findBusinessArtifact(ctx.businessId, 'github', ref);
  if (!a) throw new Error(`Repo "${truncate(String(ref || ''), 80)}" tidak ditemukan di repo bisnis ini. Pakai github_daftar, atau buat dengan github_buat_repo.`);
  return a;
}

const fail = (message, compact) => Object.assign(new Error(message), { compact });

/** Files to commit: the `isi` argument, or the code blocks written before the tool call. */
function filesFrom(ctx, { path, isi }) {
  if (isi) {
    if (!path) throw new Error('argumen "path" wajib bila "isi" diisi');
    return { files: [{ path, content: isi.endsWith('\n') ? isi : `${isi}\n` }], fromDraft: false };
  }
  const ex = extractFiles(ctx.draft);
  if (ex.unclosed.length) {
    throw fail(
      `blok kode${ex.unclosed[0] ? ` ${ex.unclosed[0]}` : ''} tidak ditutup (balasan terpotong). Tulis ulang file itu lebih pendek atau pecah menjadi beberapa file, satu file per balasan.`,
      '[balasan berisi file yang terpotong; tidak disimpan]'
    );
  }
  let files = ex.files;
  if (!files.length && path && ex.unnamed.length === 1) files = [{ path, content: ex.unnamed[0] }];
  if (!files.length) {
    throw new Error('tidak ada file untuk disimpan: tulis setiap file sebagai blok kode dengan baris "File: nama.ext" tepat di atasnya, sebelum blok <tool_call>');
  }
  return { files, fromDraft: true };
}

export const githubTools = [
  {
    name: 'github_buat_repo',
    risk: 'safe',
    connector: 'github',
    code: true,
    guide: SITE_GUIDE,
    allowed: (employee) => isDeveloper(employee),
    description: 'Buat repo GitHub privat baru untuk website atau kode bisnis ini (sekali per proyek).',
    args: {
      nama: { type: 'string', required: true, max: 90, desc: 'nama pendek, mis. toko-kopi-web' },
      jenis: { type: 'string', enum: ['website', 'kode'], default: 'website' },
      deskripsi: { type: 'string', max: 300 },
    },
    async run(ctx, { nama, jenis, deskripsi }) {
      const name = slug(nama, 90);
      const repo = await github.createRepo({ name, description: deskripsi || `Dibuat oleh AI Office${ctx.employee?.name ? ` (${ctx.employee.name})` : ''}`, signal: ctx.signal });
      let a = registerRepo({ repo, kind: jenis === 'kode' ? 'code' : 'site', businessId: ctx.businessId, taskId: ctx.task?.id ?? null, employeeId: ctx.employee?.id ?? null });
      if (jenis !== 'kode') {
        // GitHub Pages would otherwise run Jekyll over the site.
        const c = await github.commitFiles(repo.full_name, siteMeta(a).branch, [{ path: '.nojekyll', content: '' }], 'Siapkan website (AI Office)', ctx.signal);
        a = setHead(a, c.sha);
      }
      return {
        text: `Repo privat dibuat: ${repo.html_url} (repo #${a.id}, nama "${repo.name}").${jenis !== 'kode' ? ` Pratinjau (aktif setelah index.html disimpan): ${previewUrl(a)}` : ''}`,
        summary: `repo ${repo.full_name} dibuat`,
        links: [{ title: repo.name, url: repo.html_url }],
      };
    },
  },
  {
    name: 'github_simpan_file',
    risk: 'safe',
    connector: 'github',
    code: true,
    guide: SITE_GUIDE,
    allowed: (employee) => isDeveloper(employee),
    description: 'Simpan file ke repo (satu commit). Isi file diambil dari blok kode bernama yang kamu tulis sebelum blok <tool_call>; untuk satu file pendek boleh lewat "path" + "isi".',
    args: {
      repo: repoArg,
      pesan: { type: 'string', max: 200, desc: 'pesan commit singkat' },
      path: { type: 'string', max: 200, desc: 'hanya bila memakai "isi"' },
      isi: { type: 'string', max: 300000 },
    },
    async run(ctx, args) {
      const a = findRepo(ctx, args.repo);
      const { files, fromDraft } = filesFrom(ctx, args);
      const clean = cleanFiles(files);
      const meta = siteMeta(a);
      const list = clean.map((f) => `${f.path} (${kb(f.bytes)})`).join(', ');
      const message = `${truncate(args.pesan || `Perbarui ${clean.map((f) => f.path).join(', ')}`, 180)} (AI Office)`;
      const c = await github.commitFiles(meta.full_name, meta.branch || 'main', clean.map(({ path, content }) => ({ path, content })), message, ctx.signal);
      const fresh = setHead(a, c.sha);
      const preview = a.kind === 'site' ? ` Pratinjau: ${previewUrl(fresh)}` : '';
      return {
        text: `Tersimpan di GitHub ${meta.full_name}, commit ${c.sha.slice(0, 7)}: ${list}.${preview}`,
        summary: `${clean.length} file → ${a.title} (${c.sha.slice(0, 7)})`,
        links: [{ title: `${a.title} · commit ${c.sha.slice(0, 7)}`, url: c.url }],
        // The code is in GitHub now: keep only a note of it in the conversation (saves tokens on the next steps).
        compact: fromDraft ? `[isi ${clean.length} file disimpan ke GitHub: ${list}]` : null,
      };
    },
  },
  {
    name: 'github_baca',
    risk: 'safe',
    connector: 'github',
    code: true,
    allowed: (employee) => isDeveloper(employee),
    description: 'Daftar file sebuah repo (tanpa "path"), atau isi satu file untuk direvisi.',
    args: { repo: repoArg, path: { type: 'string', max: 200 } },
    async run(ctx, { repo, path }) {
      const a = findRepo(ctx, repo);
      const meta = siteMeta(a);
      const ref = meta.branch || 'main';
      if (!path) {
        const tree = await github.listTree(meta.full_name, ref, ctx.signal);
        const lines = tree.slice(0, 200).map((f) => `${f.path} (${kb(f.size)})`);
        return { text: `File di ${meta.full_name}${tree.length > 200 ? ` (200 dari ${tree.length})` : ''}:\n${lines.join('\n') || '(kosong)'}`, summary: `${tree.length} file di ${a.title}` };
      }
      const p = cleanPath(path);
      const f = await github.readFile(meta.full_name, p, ref, ctx.signal);
      if (!f) throw new Error(`file ${p} tidak ada di ${meta.full_name}`);
      return { text: `Isi ${p} (${meta.full_name}):\n${truncate(f.buf.toString('utf8'), 8000)}`, summary: `membaca ${p}` };
    },
  },
  {
    name: 'github_daftar',
    risk: 'safe',
    connector: 'github',
    code: true,
    allowed: (employee) => isDeveloper(employee),
    description: 'Daftar repo website/kode bisnis ini beserta pratinjau dan alamat terbitnya.',
    args: {},
    async run(ctx) {
      const sites = listSites({ businessId: ctx.businessId ?? null });
      if (!sites.length) return { text: 'Belum ada repo untuk bisnis ini.', summary: '0 repo' };
      const lines = sites.slice(0, 30).map((s) => {
        const live = s.deployments.filter((d) => d.url).map((d) => `${d.label}: ${d.url}${d.status === 'error' ? ' (gagal terakhir)' : ''}`).join('; ');
        return `#${s.id} · ${s.title} · ${s.kind === 'site' ? 'website' : 'kode'} · ${s.url}${s.kind === 'site' && s.preview_url ? ` · pratinjau ${s.preview_url}` : ''}${live ? ` · terbit: ${live}` : ''}`;
      });
      return { text: lines.join('\n'), summary: `${sites.length} repo` };
    },
  },
  {
    name: 'situs_terbitkan',
    risk: 'important',
    connector: 'github',
    code: true,
    allowed: (employee) => isDeveloper(employee),
    description: 'Terbitkan website dari repo ke internet (vercel, netlify, cloudflare, atau github_pages). Tanpa "layanan" = layanan utama owner.',
    args: {
      repo: repoArg,
      layanan: { type: 'string', enum: HOSTS },
      commit: { type: 'string', pattern: /^[0-9a-f]{40}$/, hidden: true, hint: 'SHA commit' },
    },
    // When the AI asks: resolve the service, lock the commit the owner can preview, describe the action.
    async prepare(ctx, args) {
      const a = findRepo(ctx, args.repo);
      const connected = connectedHosts();
      if (!connected.length) throw new Error('Belum ada layanan hosting yang terhubung. Laporkan ke owner: hubungkan Vercel, Netlify, Cloudflare, atau GitHub Pages di dashboard → Koneksi.');
      let host = args.layanan || getSetting('site_default_host');
      if (!connected.includes(host)) {
        if (args.layanan) throw new Error(`${HOST_LABEL[host]} belum terhubung. Yang terhubung: ${connected.map((h) => `${h} (${HOST_LABEL[h]})`).join(', ')}`);
        host = connected[0]; // the main service is not linked (yet): use one that is
      }
      const meta = siteMeta(a);
      const commit = await github.headSha(meta.full_name, meta.branch || 'main', ctx.signal);
      const detail = `Terbitkan website "${a.title}" (commit ${commit.slice(0, 7)}) ke ${HOST_LABEL[host]}. Pratinjau: ${previewUrl(a, commit)}`
        + (host === 'github_pages' ? '. Repo akan dijadikan publik (syarat GitHub Pages gratis)' : '');
      return { detail, args: { repo: `#${a.id}`, layanan: host, commit } };
    },
    async run(ctx, { repo, layanan, commit }) {
      const a = findRepo(ctx, repo);
      const host = layanan || getSetting('site_default_host');
      const out = await publishSite(a, host, commit || null, { signal: ctx.signal, approvalId: ctx.approvalId ?? null });
      return {
        text: publishText(a, host, out),
        summary: `${a.title} → ${HOST_LABEL[host]}${out.url ? ` ${out.url}` : ''}`,
        links: out.url ? [{ title: `${a.title} (${HOST_LABEL[host]})`, url: out.url }] : [],
      };
    },
  },
];
