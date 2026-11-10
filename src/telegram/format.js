// How the bot speaks in Telegram: who is talking (a person emoji for the job in the character's skin tone, the name
// and the role), topic icon colours, and AI Markdown/JSON turned into natural Telegram HTML.
import { json } from '../db/index.js';
import { escapeHtml, truncate } from '../lib/text.js';
import { readable } from '../lib/readable.js';

// ---------------- colours ----------------
const rgb = (hex) => {
  const n = parseInt(String(hex || '').replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
function nearest(hex, palette) {
  const [r, g, b] = rgb(hex);
  let best = palette[0];
  let bd = Infinity;
  for (const p of palette) {
    const [r2, g2, b2] = rgb(p[0]);
    const d = 2 * (r - r2) ** 2 + 4 * (g - g2) ** 2 + 3 * (b - b2) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best[1];
}
// The only icon colours Telegram accepts for forum topics.
const TOPIC_COLORS = [['#6fb9f0', 0x6fb9f0], ['#ffd67e', 0xffd67e], ['#cb86db', 0xcb86db], ['#8eee98', 0x8eee98], ['#ff93b2', 0xff93b2], ['#fb6f5f', 0xfb6f5f]];
const avatarOf = (e) => json(e?.avatar, {}) || {};
const shirtOf = (e) => avatarOf(e).shirt || '#3b82f6'; // same defaults as the office sprites
const skinOf = (e) => avatarOf(e).skin || '#f1c27d';
export const topicColor = (e) => nearest(shirtOf(e), TOPIC_COLORS);
export const roleShort = (e) => String(e.role || '').split(' — ')[0].trim() || e.role_key || '';

// Person emoji for an employee: the job (gender-neutral emoji) with the character's skin tone from the virtual office.
// [base, rest]: the skin-tone modifier goes right after the base person.
const JOBS = [
  [(e) => e.is_manager || e.role_key === 'ceo', ['🤵', '']],
  [(e) => e.role_key === 'business_manager', ['🧑', '‍💼']],
  [(e, r) => /develop|program|engineer|\bit\b|teknologi|devops|data/.test(r), ['🧑', '‍💻']],
  [(e, r) => /research|riset|peneliti|analis|analyst/.test(r), ['🧑', '‍🔬']],
  [(e, r) => /marketing|pemasaran|konten|content|sosial|social|desain|design|kreatif|creative|brand/.test(r), ['🧑', '‍🎨']],
  [(e, r) => /barista|chef|koki|dapur|kitchen|cook|masak/.test(r), ['🧑', '‍🍳']],
  [(e, r) => /secretar|sekretaris|resepsionis|reception|customer|layanan|\bcs\b|support/.test(r), ['💁', '']],
  [(e, r) => /legal|hukum|lawyer/.test(r), ['🧑', '‍⚖️']],
  [(e, r) => /operasi|operation|gudang|logistik|warehouse|teknisi|technician|maintenance/.test(r), ['🧑', '‍🔧']],
  [(e, r) => /trainer|pelatih|guru|teacher|edukasi|education/.test(r), ['🧑', '‍🏫']],
  [() => true, ['🧑', '‍💼']], // finance, HR, sales, managers, everyone else: office worker
];
const TONES = [[0.8, '\u{1F3FB}'], [0.68, '\u{1F3FC}'], [0.55, '\u{1F3FD}'], [0.4, '\u{1F3FE}'], [-1, '\u{1F3FF}']];
export function personEmoji(e) {
  const r = `${e.role_key || ''} ${e.role || ''}`.toLowerCase();
  const [base, rest] = JOBS.find(([test]) => test(e, r))[1];
  const [R, G, B] = rgb(skinOf(e));
  const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
  return `${base}${TONES.find(([min]) => lum > min)[1]}${rest}`;
}
export const speaker = (e) => `${personEmoji(e)} <b>${escapeHtml(e.name)}</b> · <i>${escapeHtml(roleShort(e))}</i>`;

// AI answers are Markdown: show the basics as Telegram HTML (bold, italic, code, headings, bullets).
export function mdToTelegram(text) {
  return escapeHtml(String(text || ''))
    .replace(/```[\s\S]*?```/g, (m) => `<pre>${m.slice(3, -3).replace(/^\w*\n/, '')}</pre>`)
    .replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

/**
 * AI text for a Telegram chat message: JSON becomes natural text, Markdown becomes Telegram HTML.
 * opts.max: shorten first (on the text, so no HTML tag is cut); opts.code: what to do with code blocks
 * ('keep' = <pre>, otherwise the replacement text, e.g. '[kode]').
 */
export function chatHtml(text, { max = 0, code = 'keep' } = {}) {
  let t = readable(text, { fences: true });
  if (code !== 'keep') t = t.replace(/```[\s\S]*?```/g, code);
  if (max) t = truncate(t, max);
  return mdToTelegram(t);
}
