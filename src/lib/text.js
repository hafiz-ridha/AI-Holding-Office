// Text utilities: token estimation, truncation, JSON extraction from LLM output, HTML escaping.

// Rough token estimate (≈4 chars per token). Used only when the provider does not report usage.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Remove reasoning blocks some models emit inline.
export function stripThinking(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim();
}

// Find the first balanced JSON object in a string (handles ```json fences and surrounding prose).
export function extractJsonObject(text) {
  const s = String(text ?? '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1], s] : [s];
  for (const c of candidates) {
    let start = c.indexOf('{');
    while (start !== -1) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < c.length; i++) {
        const ch = c[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const chunk = c.slice(start, i + 1);
            try {
              return JSON.parse(chunk);
            } catch {
              break;
            }
          }
        }
      }
      start = c.indexOf('{', start + 1);
    }
  }
  return null;
}

// Split long messages for Telegram (4096 char limit) on line boundaries.
export function splitMessage(text, max = 3900) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split a long report into natural chat messages, like a person sending several messages instead of one wall of
 * text:
 *  - every section (separated by blank lines) is one message; the report title/date joins the first section;
 *  - a list of "▸ " entries (one per business) gives one message per entry, the section heading stays with the
 *    first entry;
 *  - only very short sections (< 120 characters, e.g. "no AI requests today") join the previous message, never a
 *    business entry.
 * Short texts stay one message; parts longer than Telegram's limit are still split.
 */
export function naturalParts(text, { max = 1100, minSplit = 600 } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  if (t.length <= minSplit) return [t];
  const blocks = t.split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean).flatMap((b) => {
    const lines = b.split('\n');
    const starts = lines.map((l, i) => (/^▸ /.test(l) ? i : -1)).filter((i) => i >= 0);
    if (starts.length < 2) return [b];
    return starts.map((s, k) => lines.slice(k === 0 ? 0 : s, starts[k + 1] ?? lines.length).join('\n'));
  });
  const entry = (b) => /^(<b>[^<\n]*<\/b>\n)?▸ /.test(b);
  const heading = (b) => /^<b>[^<\n]*:<\/b>/.test(b);
  const out = [];
  let carry = '';
  blocks.forEach((b, i) => {
    // Title lines (no section heading) at the very top: send them together with the first section.
    if (i === 0 && blocks.length > 1 && !heading(b) && !entry(b) && b.length < 220) {
      carry = b;
      return;
    }
    const block = carry ? `${carry}\n\n${b}` : b;
    carry = '';
    const prev = out[out.length - 1];
    if (prev !== undefined && block.length < 120 && !entry(block) && !entry(prev) && prev.length + block.length + 2 <= max) out[out.length - 1] = `${prev}\n\n${block}`;
    else out.push(block);
  });
  if (carry) out.push(carry);
  return out.flatMap((p) => splitMessage(p));
}

export function slugify(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'employee'
  );
}
