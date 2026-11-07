// Timezone helpers based on Intl (Node ships full-ICU). No external date library.

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of `ms` in timezone `tz`.
export function zonedParts(ms, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out; // { year, month, day, hour, minute, second }
}

// Offset (ms) of tz relative to UTC at instant `ms`.
export function tzOffset(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' of instant in tz.
export function localDate(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// 'HH:MM' of instant in tz.
export function localTime(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

// 'DD-MM-YYYY' for reports.
export function displayDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

// UTC ms of local midnight for 'YYYY-MM-DD' in tz -> [start, end).
export function dayRange(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const start = guess - tzOffset(guess, tz);
  // Recompute with the offset at the actual start (handles DST edges).
  const start2 = guess - tzOffset(start, tz);
  const nextGuess = Date.UTC(y, m - 1, d + 1);
  const end = nextGuess - tzOffset(nextGuess, tz);
  return [start2, end];
}

export function todayRange(tz, ms = Date.now()) {
  return dayRange(localDate(ms, tz), tz);
}

// Next UTC midnight (OpenRouter free-model counters reset at UTC 00:00).
export function nextUtcMidnight(ms = Date.now()) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function formatDateTime(ms, tz) {
  if (!ms) return '-';
  const p = zonedParts(ms, tz);
  return `${pad(p.day)}-${pad(p.month)}-${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}
