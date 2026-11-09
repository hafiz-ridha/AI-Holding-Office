// DOM helpers. All user/AI data is inserted as text nodes (never innerHTML) to prevent XSS.

export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'required') el[k] = Boolean(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}
export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// ---------- formatting ----------
const dtf = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (ms) => (ms ? dtf.format(new Date(ms)) : '-');
export function fmtRel(ms) {
  if (!ms) return '-';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 0) return `dalam ${fmtDur(-s)}`;
  if (s < 60) return 'baru saja';
  return `${fmtDur(s)} lalu`;
}
function fmtDur(s) {
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  if (s < 86400) return `${Math.round(s / 3600)} jam`;
  return `${Math.round(s / 86400)} hari`;
}
export const fmtNum = (n) => (Number(n) || 0).toLocaleString('id-ID');
export function fmtMoney(n, cur = 'IDR') {
  try {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: cur, maximumFractionDigits: cur === 'IDR' ? 0 : 2 }).format(n || 0);
  } catch {
    return `${cur} ${n}`;
  }
}
export const taskCode = (id) => `T-${String(id).padStart(5, '0')}`;
export const PRIORITY = { 1: 'Rendah', 2: 'Normal', 3: 'Tinggi', 4: 'Mendesak' };
export const PRIORITY_KEY = { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' };
export const STATUS_LABEL = {
  pending: 'Pending', assigned: 'Assigned', processing: 'Processing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  ok: 'OK', unknown: 'Belum diuji', error: 'Error', auth_error: 'Key salah', quota: 'Kuota habis', rate_limited: 'Rate limited',
  unsupported: 'Tidak didukung', active: 'Aktif', inactive: 'Nonaktif', approved: 'Disetujui', rejected: 'Ditolak', sent: 'Terkirim', sending: 'Mengirim',
  running: 'Berjalan', stopped: 'Berhenti', skipped: 'Dilewati',
};
export const KIND_LABEL = { instruction: 'Holding', business: 'Business', subtask: 'Subtask', direct: 'Langsung' };
export const ORG_LABEL = { holding: 'Holding Management', business: 'Unit Bisnis', shared: 'Shared Services' };

export function badge(status, label) {
  return h('span', { class: `badge b-${status}` }, label || STATUS_LABEL[status] || status);
}

export function bizLogo(b, size = '') {
  const cls = `biz-logo ${size}`;
  if (b?.logo_url) return h('img', { class: cls, src: b.logo_url, alt: '', loading: 'lazy' });
  const initials = String(b?.name || '?').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  return h('span', { class: cls, style: { '--biz': b?.color || '#3b82f6' }, 'aria-hidden': 'true' }, initials);
}

// ---------- feedback ----------
export function toast(msg, type = '') {
  const el = h('div', { class: `toast ${type ? `toast-${type}` : ''}`, role: 'status' }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

export function errToast(e) {
  toast(e?.message || String(e), 'error');
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = h('div', { class: 'modal-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const foot = h('div', { class: 'modal-foot' });
  for (const a of actions) {
    const btn = h('button', { class: `btn ${a.kind ? `btn-${a.kind}` : ''}`, type: 'button' }, a.label);
    btn.addEventListener('click', async () => {
      if (!a.onClick) return close();
      btn.disabled = true;
      try {
        const keep = await a.onClick(close);
        if (keep !== false && a.close !== false) close();
      } catch (e) {
        errToast(e);
      } finally {
        btn.disabled = false;
      }
    });
    foot.append(btn);
  }
  const m = h(
    'div',
    { class: `modal ${wide ? 'modal-wide' : ''}` },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Tutup', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null
  );
  back.append(m);
  back.addEventListener('mousedown', (e) => e.target === back && close());
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  m.querySelector('input, textarea, select')?.focus();
  return close;
}

export function confirmDialog(message, { okLabel = 'Ya', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title: 'Konfirmasi',
      body: h('p', null, message),
      onClose: () => !done && resolve(false),
      actions: [
        { label: 'Batal', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
    });
  });
}

// ---------- forms ----------
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}
export function checkbox(label, checked, attrs = {}) {
  const input = h('input', { type: 'checkbox', checked, ...attrs });
  return { el: h('label', { class: 'check' }, input, label), input };
}
export function select(options, value, attrs = {}) {
  const s = h('select', attrs);
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o.value, o.label];
    s.append(h('option', { value: v ?? '', selected: String(v ?? '') === String(value ?? '') }, l));
  }
  return s;
}
export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', null, text), action || null);
}

// ---------- safe markdown ----------
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) frag.append(h('code', null, t.slice(1, -1)));
    else if (t.startsWith('**')) frag.append(h('strong', null, t.slice(2, -2)));
    else if (t.startsWith('[')) {
      const label = t.slice(1, t.indexOf(']'));
      frag.append(h('a', { href: m[2], target: '_blank', rel: 'noopener noreferrer nofollow' }, label));
    } else frag.append(h('em', null, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

export function md(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      const p = h('p');
      para.forEach((l, idx) => {
        if (idx) p.append(h('br'));
        p.append(inline(l));
      });
      root.append(p);
      para = [];
    }
  };
  const flushList = () => {
    list = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      root.append(h('pre', null, h('code', null, buf.join('\n'))));
      i++;
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      flushPara();
      flushList();
      root.append(h(`h${Math.min(4, hm[1].length + 1)}`, null, inline(hm[2])));
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara();
      flushList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const table = h('table');
      table.append(h('thead', null, h('tr', null, cells(line).map((c) => h('th', null, inline(c))))));
      const tb = h('tbody');
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) tb.append(h('tr', null, cells(lines[i++]).map((c) => h('td', null, inline(c)))));
      table.append(tb);
      root.append(h('div', { class: 'table-wrap' }, table));
      continue;
    }
    const lm = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (lm) {
      flushPara();
      const ordered = /\d/.test(lm[1]);
      if (!list || list.ordered !== ordered) {
        list = { el: h(ordered ? 'ol' : 'ul'), ordered };
        root.append(list.el);
      }
      list.el.append(h('li', null, inline(lm[2])));
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      root.append(h('blockquote', null, inline(line.replace(/^>\s?/, ''))));
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      i++;
      continue;
    }
    flushList();
    para.push(line);
    i++;
  }
  flushPara();
  return root;
}

export function readFileAs(file, how = 'text') {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Gagal membaca file'));
    if (how === 'dataurl') r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

// "Dijawab oleh …" line under an AI answer: which model wrote it and for which need; the AI router's explanation
// (why that model was picked, what was skipped) opens on click.
// info: { provider, model, need, text } — need/text come from the task's model_choice.
export function modelNote(info, { open = false } = {}) {
  if (!info || !info.model) return null;
  const head = `🤖 ${info.provider ? `${info.provider} / ` : ''}${info.model}${info.need ? ` · ${info.need}` : ''}`;
  if (!info.text) return h('div', { class: 'model-note' }, head);
  return h('details', { class: 'model-note', open }, h('summary', { title: 'Kenapa model ini?' }, head), h('div', { class: 'model-why' }, info.text));
}

// model info from a task row (provider_name, model_used, model_choice).
export const taskModelInfo = (t) => (t?.model_used ? { provider: t.provider_name, model: t.model_used, need: t.model_choice?.need_label || null, text: t.model_choice?.text || null } : null);
