// AI answers and provider errors sometimes come back as JSON (a planning object that did not fit, a model that
// answered a chat in JSON, an answer cut off by the token limit, an error body). People see natural text instead:
//  - readable(): JSON objects/arrays become short Markdown (paragraphs, "Label: value", bullet lists);
//    cut-off JSON is salvaged from its text values; prose and code inside prose are left alone.
//  - cleanError(): JSON inside an error message is reduced to its message.

const BODY = ['direct_answer', 'answer', 'jawaban', 'reply', 'balasan', 'response', 'respons', 'message', 'pesan', 'content', 'konten', 'text', 'teks', 'report', 'laporan', 'result', 'hasil', 'output'];
const SUMMARY = ['analysis', 'analisis', 'summary', 'ringkasan'];
const LABELS = {
  analysis: 'Analisis', analisis: 'Analisis', summary: 'Ringkasan', ringkasan: 'Ringkasan', executive_summary: 'Ringkasan eksekutif',
  recommendations: 'Rekomendasi', recommendation: 'Rekomendasi', rekomendasi: 'Rekomendasi',
  risks: 'Risiko', risiko: 'Risiko', issues: 'Masalah', problems: 'Masalah', masalah: 'Masalah',
  opportunities: 'Peluang', peluang: 'Peluang', next_steps: 'Langkah berikutnya', action_items: 'Tindak lanjut',
  priorities: 'Prioritas', prioritas: 'Prioritas', priority: 'Prioritas',
  business_tasks: 'Tugas untuk bisnis', shared_tasks: 'Tugas untuk tim pusat', subtasks: 'Pembagian tugas', tasks: 'Tugas',
  notes: 'Catatan', catatan: 'Catatan', sources: 'Sumber', sumber: 'Sumber', references: 'Sumber',
  findings: 'Temuan', temuan: 'Temuan', key_points: 'Poin penting', highlights: 'Hasil penting', insights: 'Insight',
  trends: 'Tren', tren: 'Tren', title: 'Judul', description: 'Deskripsi', assignee: 'Dikerjakan oleh', business: 'Bisnis',
  status: 'Status', reason: 'Alasan', direct_answer: 'Jawaban', alasan: 'Alasan', approval: 'Perlu persetujuan', approvals: 'Perlu persetujuan',
};
const PRIORITY = { low: 'rendah', normal: 'normal', high: 'tinggi', urgent: 'mendesak' };
const HEAD = ['title', 'judul', 'name', 'nama', 'task', 'tugas', 'topic', 'topik', 'headline'];
const DESC = ['description', 'deskripsi', 'detail', 'details', 'summary', 'ringkasan', 'isi', 'content', 'text'];
const WHO = ['assignee', 'business', 'pic'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const empty = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.some((x) => !empty(x))) || (isObj(v) && !Object.values(v).some((x) => !empty(x)));
const keyOf = (o, names) => Object.keys(o).find((k) => names.includes(k.toLowerCase()));

export function humanKey(k) {
  const s = String(k);
  return LABELS[s.toLowerCase()] || s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
}

function scalar(v, key = '') {
  if (typeof v === 'boolean') return v ? 'ya' : 'tidak';
  const s = String(v).trim();
  return /^priorit/i.test(key) ? PRIORITY[s.toLowerCase()] || s : s;
}

// One-line version of any value (inside a bullet).
function inline(v, depth = 0) {
  if (!isObj(v) && !Array.isArray(v)) return scalar(v).replace(/\s*\n+\s*/g, ' ');
  if (depth > 2) return '';
  if (Array.isArray(v)) return v.filter((x) => !empty(x)).map((x) => inline(x, depth + 1)).join(', ');
  const head = keyOf(v, HEAD);
  if (head && typeof v[head] === 'string') return v[head].trim();
  return Object.entries(v).filter(([, x]) => !empty(x)).map(([k, x]) => `${humanKey(k)}: ${inline(x, depth + 1)}`).join('; ');
}

// A list item: objects become "**title** (who): description — other: value".
function itemLine(v) {
  if (!isObj(v)) return `- ${inline(v)}`;
  const used = new Set();
  const take = (names) => {
    const k = Object.keys(v).find((x) => names.includes(x.toLowerCase()) && !used.has(x) && !empty(v[x]) && !isObj(v[x]) && !Array.isArray(v[x]));
    if (k) used.add(k);
    return k ? inline(v[k]) : '';
  };
  const head = take(HEAD);
  const desc = take(DESC);
  const who = WHO.map(() => take(WHO)).filter(Boolean);
  const rest = Object.entries(v).filter(([k, x]) => !used.has(k) && !empty(x)).map(([k, x]) => `${humanKey(k)}: ${/^priorit/i.test(k) ? scalar(x, k) : inline(x)}`);
  let line = head ? `**${head}**` : '';
  if (who.length) line += `${line ? ' ' : ''}(${who.join(' · ')})`;
  if (desc) line += `${line ? ': ' : ''}${desc}`;
  if (rest.length) line += `${line ? ' — ' : ''}${rest.join('; ')}`;
  return `- ${line}`;
}

function renderObject(o, depth) {
  const out = [];
  const used = new Set();
  // The answer itself (or, without one, the summary) leads without a label, like a person would write it.
  const lead = Object.keys(o).find((k) => BODY.includes(k.toLowerCase()) && !empty(o[k])) ||
    Object.keys(o).find((k) => SUMMARY.includes(k.toLowerCase()) && typeof o[k] === 'string' && o[k].trim());
  if (lead) {
    out.push(render(o[lead], depth + 1));
    used.add(lead);
  }
  for (const [k, v] of Object.entries(o)) {
    if (used.has(k) || empty(v)) continue;
    const label = humanKey(k);
    if (Array.isArray(v)) out.push(`**${label}**\n${v.filter((x) => !empty(x)).map(itemLine).join('\n')}`);
    else if (isObj(v)) out.push(`**${label}**\n${Object.entries(v).filter(([, x]) => !empty(x)).map(([k2, x]) => `- ${humanKey(k2)}: ${inline(x)}`).join('\n')}`);
    else {
      const s = typeof v === 'string' ? readable(v, { depth: depth + 1 }) : scalar(v, k);
      out.push(s.includes('\n') || s.length > 90 ? `**${label}**\n${s}` : `**${label}:** ${s}`);
    }
  }
  return out.join('\n\n');
}

function render(v, depth = 0) {
  if (typeof v === 'string') return readable(v, { depth: depth + 1 });
  if (Array.isArray(v)) return v.filter((x) => !empty(x)).map(itemLine).join('\n');
  if (isObj(v)) return renderObject(v, depth);
  return v === null || v === undefined ? '' : scalar(v);
}

/**
 * JSON at the start of s: { value, end } when it parses, { broken: true } when it looks like a JSON object that is
 * cut off or invalid, null when s is not JSON (prose, a Markdown link, ...).
 */
function leading(s) {
  if (!/^[{[]/.test(s)) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const chunk = s.slice(0, i + 1);
        for (const c of [chunk, chunk.replace(/,\s*([}\]])/g, '$1')]) {
          try {
            return { value: JSON.parse(c), end: i + 1 };
          } catch {}
        }
        break;
      }
    }
  }
  return /^\{\s*"/.test(s) ? { broken: true } : null;
}

const unescape = (raw) => {
  try {
    return JSON.parse(`"${raw.replace(/\\+$/, (m) => (m.length % 2 ? m.slice(1) : m))}"`);
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
};

// Text values of JSON that is cut off (token limit) or invalid: the answer if there is one, else its parts.
function salvage(s) {
  const pairs = [...s.matchAll(/"([A-Za-z_][\w ]{0,40})"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g)]
    .map((m) => ({ key: m[1], val: unescape(m[2]).trim(), closed: m[3] === '"' }))
    .filter((p) => p.val);
  if (!pairs.length) return '';
  const pick = pairs.find((p) => BODY.includes(p.key.toLowerCase()) && p.val.length >= 10) || pairs.find((p) => SUMMARY.includes(p.key.toLowerCase()));
  if (pick) return pick.closed ? pick.val : `${pick.val} …`;
  return pairs.map((p) => `- ${humanKey(p.key)}: ${p.val.replace(/\s*\n+\s*/g, ' ')}`).join('\n');
}

/**
 * Natural text for people. Text that is JSON (optionally in one ```json fence, optionally followed by prose)
 * becomes Markdown; anything else is returned unchanged. opts.fences: also turn ```json blocks inside prose into
 * text (for chat/Telegram, where code blocks of data are not useful).
 */
export function readable(text, { fences = false, depth = 0 } = {}) {
  const s = String(text ?? '').trim();
  if (!s || depth > 3) return s;
  const whole = s.match(/^```(?:json)?[ \t]*\n?([\s\S]*?)\n?```$/i);
  const body = whole && !whole[1].includes('```') ? whole[1].trim() : s;
  const lead = leading(body);
  if (lead?.value !== undefined) {
    const out = render(lead.value, depth);
    const rest = body.slice(lead.end).replace(/^\s*```\s*/, '').trim();
    if (out) return [out, rest && readable(rest, { fences, depth: depth + 1 })].filter(Boolean).join('\n\n');
  } else if (lead?.broken) {
    const out = salvage(body);
    if (out) return out;
  }
  // Prose followed by a bare JSON object ("Berikut jawabannya:\n{...}"): the object becomes text too.
  const at = s.search(/\n\s*\{\s*"/);
  if (at > 0) {
    const tail = s.slice(at).trim();
    const l = leading(tail);
    if (l?.value !== undefined && !tail.slice(l.end).trim()) {
      const out = render(l.value, depth);
      if (out) return `${s.slice(0, at).trim()}\n\n${out}`;
    }
  }
  if (!fences) return s;
  return s
    .replace(/```(?:json)?[ \t]*\n([\s\S]*?)```\n?/gi, (m, inner) => {
      const l = leading(inner.trim());
      const out = l?.value !== undefined && !inner.trim().slice(l.end).trim() ? render(l.value, depth) : '';
      return out ? `${out}\n\n` : m;
    })
    .trim();
}

/** The answer of a planning object that created no tasks (direct answer, else the analysis), as natural text. */
export function planAnswer(plan, raw) {
  const d = plan?.direct_answer;
  if (typeof d === 'string' && d.trim()) return readable(d);
  if (d && typeof d === 'object' && !empty(d)) return render(d);
  if (typeof plan?.analysis === 'string' && plan.analysis.trim()) return plan.analysis.trim();
  return readable(raw);
}

const MESSAGE_KEYS = ['message', 'detail', 'error_description', 'msg', 'description', 'reason'];
function errorText(v) {
  if (typeof v === 'string') return cleanError(v);
  if (Array.isArray(v)) return v.map(errorText).filter(Boolean).join('; ');
  if (!isObj(v)) return v === null || v === undefined ? '' : String(v);
  if (typeof v.error === 'string' && v.error.trim()) return cleanError(v.error);
  if (isObj(v.error)) {
    const m = errorText(v.error);
    if (m) return m;
  }
  const k = Object.keys(v).find((x) => MESSAGE_KEYS.includes(x.toLowerCase()) && typeof v[x] === 'string' && v[x].trim());
  if (k) return cleanError(v[k]);
  return Object.entries(v).filter(([, x]) => ['string', 'number'].includes(typeof x)).slice(0, 3).map(([x, y]) => `${x}: ${y}`).join(', ');
}

/** An error message without JSON: embedded JSON bodies are replaced by their message ("HTTP 429: Rate limit ..."). */
export function cleanError(message) {
  let s = String(message ?? '');
  for (let n = 0; n < 5; n++) {
    const i = s.search(/[{[]\s*"/);
    if (i < 0) break;
    const lead = leading(s.slice(i));
    if (lead?.value !== undefined) {
      s = s.slice(0, i) + errorText(lead.value) + s.slice(i + lead.end);
      continue;
    }
    // Cut-off JSON (messages are length-limited): keep its message if it has one.
    const m = s.slice(i).match(/"(?:message|error|detail)"\s*:\s*"((?:[^"\\]|\\.)*)/);
    s = s.slice(0, i) + (m ? unescape(m[1]) : '');
    break;
  }
  const parts = s.split(/\s+—\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.filter((p, i) => parts.indexOf(p) === i).join(' — ').replace(/\s*[:—–-]\s*$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}
