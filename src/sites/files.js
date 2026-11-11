// Files an AI employee writes in its reply: fenced code blocks, each named by the line just before it
// ("File: index.html", "### style.css", "**app.js**") or by the block's info string ("```html index.html").
// Paths are checked strictly: relative, plain characters, no .git / .github (no CI workflows), size limits.

export const LIMITS = { files: 30, fileBytes: 300 * 1024, totalBytes: 1024 * 1024 };

const PATH_RE = /^[A-Za-z0-9._-]+$/;
// A file name with an extension, or a dot-file; folders included. Leading dots are kept (".github/…" must stay
// recognisable so cleanPath can refuse it).
const SEG = '\\.?[A-Za-z0-9_][A-Za-z0-9._-]*';
const FILE_LIKE = new RegExp(`((?:${SEG}\\/)*(?:${SEG}\\.[A-Za-z0-9]{1,10}|\\.[A-Za-z0-9_-]+))`, 'g');

/** Clean, safe relative path, or throws with a message for the AI. */
export function cleanPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s) throw new Error('nama file kosong');
  if (s.length > 200) throw new Error(`nama file terlalu panjang: ${s.slice(0, 60)}…`);
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..' || !PATH_RE.test(seg)) {
      throw new Error(`nama file tidak valid: "${s}" (pakai huruf, angka, titik, - dan _; folder dipisah /; tanpa ..)`);
    }
  }
  if (segs.some((x) => x.toLowerCase() === '.git') || segs[0].toLowerCase() === '.github') {
    throw new Error(`file "${s}" tidak diizinkan (folder .git dan .github dikelola GitHub)`);
  }
  return s;
}

// The name of a file announced by a short line before its code block.
function nameFromLine(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 160) return null;
  const plain = t.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s+/, '').replace(/[*_`]/g, '').replace(/:\s*$/, '').trim();
  const labelled = plain.match(/^(?:file|berkas|nama file|path|lokasi)\s*[:=]?\s*(.+)$/i);
  const candidate = (labelled ? labelled[1] : plain).trim();
  const m = [...candidate.matchAll(FILE_LIKE)];
  if (!m.length) return null;
  // The whole line must be about the file ("File: x", "### x", "x"), not a sentence that mentions one.
  if (!labelled && candidate.split(/\s+/).length > 3) return null;
  return m[m.length - 1][1];
}

function nameFromInfo(info) {
  const parts = String(info || '').trim().split(/\s+/).filter(Boolean);
  for (const p of parts) {
    const kv = p.match(/^(?:title|file|filename|name|path)=["']?([^"']+)["']?$/i);
    if (kv) return kv[1];
  }
  for (const p of parts.slice(parts.length > 1 ? 1 : 0)) {
    if (/\.[A-Za-z0-9]{1,10}$/.test(p) && /^[A-Za-z0-9_./-]+$/.test(p)) return p;
  }
  return null;
}

/**
 * Named code blocks in `text`: { files: [{ path, content }], unnamed: [content], unclosed: [name|null] }.
 * Later blocks with the same name replace earlier ones. Paths are not validated here (see cleanFiles).
 */
export function extractFiles(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const byName = new Map();
  const unnamed = [];
  const unclosed = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!open) continue;
    const fence = open[1];
    const info = open[2];
    let name = nameFromInfo(info);
    if (!name) {
      for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
        if (!lines[k].trim()) continue;
        name = nameFromLine(lines[k]);
        break;
      }
    }
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end < 0) {
      unclosed.push(name);
      break;
    }
    const content = `${lines.slice(i + 1, end).join('\n')}\n`;
    if (name) byName.set(name, content);
    else unnamed.push(content);
    i = end;
  }
  return { files: [...byName].map(([path, content]) => ({ path, content })), unnamed, unclosed };
}

/** Validated files (paths cleaned, limits checked). Throws with a message for the AI. */
export function cleanFiles(files) {
  if (!files.length) throw new Error('tidak ada file');
  if (files.length > LIMITS.files) throw new Error(`terlalu banyak file sekaligus (maks ${LIMITS.files}); simpan bertahap`);
  let total = 0;
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const path = cleanPath(f.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > LIMITS.fileBytes) throw new Error(`file ${path} terlalu besar (${Math.ceil(bytes / 1024)} KB; maks ${LIMITS.fileBytes / 1024} KB): pecah menjadi beberapa file`);
    total += bytes;
    out.push({ path, content: f.content, bytes });
  }
  if (total > LIMITS.totalBytes) throw new Error(`total isi terlalu besar (maks ${LIMITS.totalBytes / 1024} KB per simpan)`);
  return out;
}

export const kb = (bytes) => `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
