// Automatic model selection ("pilih model terbaik sesuai kebutuhan").
// 1. detectNeed(): what a call needs (coding, analysis, writing, quick reply, general), read from the real task text,
//    the call purpose (plan / synthesis / work) and the employee's role. No extra AI call is made for this.
// 2. profileModel(): what a model is good at, from its id (known families + parameter size) and the synced catalogue
//    (context length, free/paid). Unknown models get a neutral profile, so they keep the admin's order.
// 3. rankCandidates(): orders the models the admin configured (default + fallback models of every enabled provider)
//    by fit for the need, recent success rate and context size. Models pinned by the admin (employee / tier) stay first.
// 4. describeChoice(): the human explanation stored with every answer ("dijawab oleh … karena …").
import { q, now } from '../db/index.js';

export const NEEDS = {
  coding: 'Pemrograman & teknis',
  reasoning: 'Analisis & perencanaan',
  writing: 'Penulisan & konten',
  quick: 'Balasan cepat',
  general: 'Umum',
};
const NEED_ORDER = ['coding', 'reasoning', 'writing', 'quick', 'general'];

// Marker added by the chat module to quick-reply tasks (see holding/chat.js); stripped before keyword matching.
const CHAT_REPLY = /\(Pesan obrolan dari owner\.[^)]*\)/;

// [global regex, weight per distinct word (max 2 words counted per regex)]
const KEYWORDS = {
  coding: [
    [/```/g, 3],
    [/\b(python|javascript|typescript|php|golang|kotlin|swift|sql|mysql|postgres(?:ql)?|sqlite|regex|laravel|react|vue|node\.?js|docker|nginx|kubernetes|bash|powershell|css|html)\b/g, 2],
    [/\b(bug|debug|error|eror|stack ?trace|exception|traceback|compile|syntax)\b/g, 2],
    [/\b(kode|koding|coding|code|script|skrip|pemrograman|programming|fungsi|function|endpoint|api|database|query|deploy|server|repository|github|frontend|backend|json|website|aplikasi)\b/g, 1],
  ],
  reasoning: [
    [/\b(analisis|analisa|analyze|analysis|strategi|strategy|evaluasi|evaluate|proyeksi|projection|forecast|prediksi|valuasi|swot|kpi|roi)\b/g, 2],
    [/\b(rencana|perencanaan|plan|bandingkan|perbandingan|compare|hitung|perhitungan|kalkulasi|keuangan|finansial|anggaran|budget|laba|rugi|profit|margin|arus kas|cash ?flow|risiko|risk|keputusan|rekomendasi|prioritas|investasi|pajak|kontrak|hukum|legal|audit|riset|research|statistik|tren|trend)\b/g, 1],
  ],
  writing: [
    [/\b(artikel|blog|caption|copywriting|newsletter|press release|siaran pers|naskah|slogan|tagline|headline|deskripsi produk|konten|content|postingan|iklan)\b/g, 2],
    [/\b(tulis|tuliskan|menulis|email|surel|surat|deskripsi|posting|ads|judul|terjemah\w*|translate|proposal|pengumuman|ringkas\w*|rangkum\w*|parafrase|paraphrase|undangan|pidato|sambutan)\b/g, 1],
  ],
  quick: [[/^(halo|hai|hi|hello|selamat (pagi|siang|sore|malam)|pagi|terima kasih|makasih|thanks|oke?|siap)\b/g, 2]],
};

const ROLE_BIAS = {
  developer: ['coding', 1.5],
  ceo: ['reasoning', 1],
  business_manager: ['reasoning', 1],
  group_finance: ['reasoning', 1.5],
  finance: ['reasoning', 1.5],
  researcher: ['reasoning', 1],
  marketing: ['writing', 1.5],
  secretary: ['writing', 1],
  hr: ['writing', 1],
};

/**
 * @param {{purpose?: string, task?: object, employee?: object, inputTokens?: number}} ctx
 * @returns {{key: string, label: string, signals: string[], long: boolean, inputTokens: number}}
 */
export function detectNeed({ purpose = 'work', task = null, employee = null, inputTokens = 0 } = {}) {
  const raw = `${task?.title || ''}\n${task?.description || ''}`;
  const isChatReply = CHAT_REPLY.test(raw);
  const text = raw.replace(CHAT_REPLY, '').toLowerCase().slice(0, 6000);
  const score = Object.fromEntries(NEED_ORDER.map((k) => [k, 0]));
  const signals = Object.fromEntries(NEED_ORDER.map((k) => [k, []]));
  const add = (need, w, why) => {
    score[need] += w;
    if (why && !signals[need].includes(why)) signals[need].push(why);
  };

  for (const [need, rules] of Object.entries(KEYWORDS)) {
    const src = need === 'quick' ? String(task?.description || '').replace(CHAT_REPLY, '').trim().toLowerCase() : text;
    for (const [re, w] of rules) {
      const words = [...new Set([...src.matchAll(re)].map((m) => m[0].trim()))];
      for (const word of words.slice(0, 2)) add(need, w, word === '```' ? 'blok kode' : `"${word}"`);
    }
  }
  if (purpose === 'plan') add('reasoning', 3, 'tahap perencanaan & pembagian tugas');
  if (purpose === 'synthesis') {
    add('writing', 2, 'tahap merangkum laporan');
    add('reasoning', 1);
  }
  const bias = employee && ROLE_BIAS[employee.role_key];
  if (bias) add(bias[0], bias[1], `peran ${String(employee.role || employee.role_key).split(' — ')[0]}`);
  if (isChatReply) {
    add('quick', 1.5, 'balasan obrolan');
    const body = String(task?.description || '').replace(CHAT_REPLY, '').trim();
    if (body.length < 160) add('quick', 1, 'pesan pendek');
  }

  // Highest score wins (at least 1 point); ties go to the earlier, more specific need.
  let best = 0;
  let key = 'general';
  for (const k of NEED_ORDER) {
    if (k === 'general') continue;
    if (score[k] >= 1 && score[k] > best) {
      best = score[k];
      key = k;
    }
  }
  const long = inputTokens > 6000;
  const sig = key === 'general' ? [] : signals[key].slice(0, 3);
  if (long) sig.push(`input panjang ±${inputTokens} token`);
  return { key, label: NEEDS[key], signals: sig, long, inputTokens };
}

// ---------------- model profiles ----------------
// Known families: [regex on the lower-cased id, { size, tags }]. First match with a size wins; tags are merged.
const FAMILY = [
  [/opus/, { size: 'large', tags: ['reason', 'code', 'slow'] }],
  [/sonnet/, { size: 'large', tags: ['reason', 'code'] }],
  [/haiku/, { size: 'small', tags: ['fast'] }],
  [/gpt-5[^/]*?(mini|nano)|gpt-4o-mini|gpt-4\.1-(mini|nano)/, { size: 'small', tags: ['fast'] }],
  [/gpt-5/, { size: 'large', tags: ['reason', 'code'] }],
  [/gpt-4\.1|gpt-4o/, { size: 'large', tags: ['code'] }],
  [/(^|[/:_-])o[34]-mini/, { size: 'medium', tags: ['reason'] }],
  [/(^|[/:_-])o[134](-pro)?([/:_-]|$)/, { size: 'large', tags: ['reason', 'slow'] }],
  [/gemini-[\d.]+-pro/, { size: 'large', tags: ['reason', 'code'] }],
  [/gemini-[\d.]+-flash-lite/, { size: 'small', tags: ['fast'] }],
  [/gemini-(2\.5|[3-9][\d.]*)-flash(?!-lite)/, { size: 'medium', tags: ['reason', 'fast'] }],
  [/gemini-[\d.]+-flash/, { size: 'medium', tags: ['fast'] }],
  [/deepseek-r1|qwq|thinking|magistral/, { size: 'large', tags: ['reason', 'slow'] }],
  [/deepseek-(v3|chat)/, { size: 'large', tags: ['reason', 'code'] }],
  [/kimi-k2/, { size: 'large', tags: ['reason', 'code'] }],
  [/qwen[\d.]*-coder-(plus|480b)|qwen3-coder$/, { size: 'large', tags: ['code'] }],
  [/qwen[\d.]*-coder/, { size: 'medium', tags: ['code'] }],
  [/qwen[\d.]*-(max|plus)/, { size: 'large', tags: ['reason'] }],
  [/qwen[\d.]*-(turbo|flash)/, { size: 'small', tags: ['fast'] }],
  [/glm-[\d.]+-?(flash|air)/, { size: 'medium', tags: ['reason', 'fast'] }],
  [/glm-(4\.[5-9]|[5-9])(?![\d.]*-?(flash|air))/, { size: 'large', tags: ['reason', 'code'] }],
  [/grok-code/, { size: 'medium', tags: ['code', 'fast'] }],
  [/grok-[3-9]/, { size: 'large', tags: ['reason'] }],
  [/minimax-m/, { size: 'large', tags: ['reason', 'code'] }],
  [/command-a/, { size: 'large', tags: ['reason'] }],
  [/command-r-plus|command-r\+/, { size: 'large', tags: [] }],
  [/command-r7b|command-light/, { size: 'small', tags: ['fast'] }],
  [/command-r/, { size: 'medium', tags: [] }],
  [/mistral-large|magistral-medium/, { size: 'large', tags: [] }],
  [/mistral-medium/, { size: 'medium', tags: [] }],
  [/codestral|devstral/, { size: 'medium', tags: ['code', 'fast'] }],
  [/mistral-small|ministral|mistral-nemo|open-mistral/, { size: 'small', tags: ['fast'] }],
  [/gpt-oss|qwen3(?!-coder)/, { tags: ['reason'] }],
  [/llama-?4[^a-z]*maverick/, { size: 'large', tags: [] }],
  [/llama-?4[^a-z]*scout/, { size: 'medium', tags: ['fast'] }],
  [/nemotron/, { tags: ['reason'] }],
  [/phi-?\d|gemma|smollm|tinyllama/, { size: 'small', tags: [] }],
  // Generic hints for ids that are not in a known family.
  [/coder|starcoder|codellama|codegemma/, { tags: ['code'] }],
  [/reason|think|(^|[/:_-])r1([/:_-]|$)/, { tags: ['reason'] }],
  [/instant|turbo|lite|flash|fast|mini|nano|tiny/, { tags: ['fast'] }],
];
const FAST_PRESETS = new Set(['groq', 'cerebras', 'sambanova']);

function paramsOf(id) {
  let max = 0;
  for (const m of id.matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/g)) max = Math.max(max, Number(m[1]));
  return max || null;
}

/**
 * @param {string} modelId
 * @param {{context_length?: number|null, is_free?: number|boolean, pricing_prompt?: number|null}|null} meta synced catalogue row
 * @param {object|null} provider provider row (preset decides fast hardware)
 */
export function profileModel(modelId, meta = null, provider = null) {
  const id = String(modelId || '').toLowerCase();
  const tags = new Set();
  let size = null;
  for (const [re, info] of FAMILY) {
    if (!re.test(id)) continue;
    if (!size && info.size) size = info.size;
    for (const t of info.tags || []) tags.add(t);
  }
  const params = paramsOf(id);
  if (params) size = params >= 65 ? 'large' : params >= 25 ? 'medium' : 'small';
  if (size === 'small') tags.add('fast');
  if (provider && FAST_PRESETS.has(provider.preset)) tags.add('fast');
  if (tags.has('slow')) tags.delete('fast');
  let context = meta?.context_length || null;
  if (!context && /gemini-/.test(id)) context = 1_000_000;
  const free = Boolean(meta?.is_free) || /:free$/.test(id);
  const paid = !free && typeof meta?.pricing_prompt === 'number' && meta.pricing_prompt > 0;
  return { size, params, tags: [...tags], context, free, paid };
}

const fmtCtx = (n) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10} jt` : `${Math.round(n / 1000)}K`);

export function strengthsOf(p) {
  const out = [];
  if (p.tags.includes('code')) out.push('spesialis kode');
  if (p.tags.includes('reason')) out.push('kuat penalaran');
  if (p.size === 'large') out.push('model besar');
  else if (p.size === 'medium') out.push('model menengah');
  else if (p.size === 'small') out.push('model ringan');
  if (p.tags.includes('fast')) out.push('cepat');
  if (p.tags.includes('slow')) out.push('berpikir panjang (lebih lambat)');
  if (p.context >= 100_000) out.push(`konteks ${fmtCtx(p.context)} token`);
  if (p.free) out.push('gratis');
  return out;
}

// ---------------- ranking ----------------
const WEIGHTS = {
  coding: { code: 40, reason: 12, fast: 0, slow: -5, small: -10, medium: 5, large: 15 },
  reasoning: { code: 0, reason: 35, fast: 0, slow: 0, small: -15, medium: 5, large: 25 },
  writing: { code: -15, reason: 0, fast: 0, slow: -8, small: -5, medium: 10, large: 20 },
  quick: { code: -5, reason: -3, fast: 25, slow: -25, small: 12, medium: 8, large: -5 },
  general: { code: -8, reason: 8, fast: 5, slow: -5, small: -3, medium: 10, large: 15 },
};
const TAG_REASON = { code: 'spesialis kode', reason: 'kuat penalaran', fast: 'cepat', slow: 'lebih lambat' };
const SIZE_REASON = { large: 'model besar', medium: 'model menengah', small: 'model ringan' };
const SOURCE_BONUS = { default: [6, 'model default provider utama'], fallback: [2, null], backup: [3, null], 'backup-fallback': [0, null] };
export const PINNED = new Set(['employee', 'employee-provider', 'employee-fallback', 'tier']);

function usageStats() {
  const rows = q.all(
    `SELECT provider_id, model, COUNT(*) n, SUM(ok) ok, AVG(CASE WHEN ok = 1 THEN latency_ms END) latency
     FROM usage_logs WHERE created_at >= ? GROUP BY provider_id, model`,
    now() - 24 * 3600_000
  );
  return new Map(rows.map((r) => [`${r.provider_id}:${r.model}`, r]));
}

function catalogueRow(providerId, model) {
  return q.get('SELECT context_length, is_free, pricing_prompt FROM models WHERE provider_id = ? AND model_id = ?', providerId, model) || null;
}

/** Score one candidate for a need. Returns { score, pros: string[], cons: string[], profile }. */
export function scoreCandidate(c, need, { stats = null } = {}) {
  const profile = profileModel(c.model, catalogueRow(c.provider.id, c.model), c.provider);
  const w = WEIGHTS[need.key] || WEIGHTS.general;
  let score = 0;
  const pros = [];
  const cons = [];
  const take = (pts, label) => {
    score += pts;
    if (!label || !pts) return;
    (pts > 0 ? pros : cons).push({ pts, label });
  };
  for (const t of profile.tags) take(w[t] || 0, TAG_REASON[t]);
  if (profile.size) take(w[profile.size] || 0, SIZE_REASON[profile.size]);
  const [bonus, label] = SOURCE_BONUS[c.source] || [0, null];
  take(bonus, label);
  if (need.long && profile.context) {
    const required = (need.inputTokens || 0) + 1500;
    if (profile.context < required) take(-60, `konteks ${fmtCtx(profile.context)} terlalu kecil`);
    else if (profile.context >= 100_000) take(8, `konteks ${fmtCtx(profile.context)} token`);
  }
  if (profile.paid) take(-3, 'berbayar');
  const s = (stats || usageStats()).get(`${c.provider.id}:${c.model}`);
  if (s && s.n >= 2) {
    // Failures push a model down; success only breaks ties, so a model that happens to be used often does not
    // snowball ahead of better-fitting ones.
    const rate = (s.ok || 0) / s.n;
    if (rate < 0.8) take(Math.round((rate - 0.8) * 50), `sering gagal (${s.ok}/${s.n} berhasil dalam 24 jam)`);
    else if (s.n >= 3) take(2, `andal (${s.ok}/${s.n} berhasil dalam 24 jam)`);
    if (need.key === 'quick' && s.latency) {
      if (s.latency < 4000) take(5, `respons rata-rata ${(s.latency / 1000).toFixed(1)} dtk`);
      else if (s.latency > 20000) take(-8, `respons rata-rata ${Math.round(s.latency / 1000)} dtk`);
    }
  }
  if (c.provider.status === 'error') take(-8, 'provider sedang bermasalah');
  pros.sort((a, b) => b.pts - a.pts);
  cons.sort((a, b) => a.pts - b.pts);
  return { score, pros: pros.map((x) => x.label), cons: cons.map((x) => x.label), profile };
}

/**
 * Order candidates for a need. Pinned candidates (set by the admin on the employee or tier) stay first, in order.
 * @returns {{list: object[], scored: Map<object, {score, pros, cons, profile}>}}
 */
export function rankCandidates(candidates, need) {
  const stats = usageStats();
  const scored = new Map(candidates.map((c) => [c, scoreCandidate(c, need, { stats })]));
  const pinned = candidates.filter((c) => PINNED.has(c.source));
  const free = candidates.filter((c) => !PINNED.has(c.source)).sort((a, b) => scored.get(b).score - scored.get(a).score);
  return { list: [...pinned, ...free], scored };
}

// ---------------- explanation ----------------
const ERR_KIND = {
  rate_limit: 'batas request', quota: 'kuota habis', auth: 'API key ditolak', not_found: 'model tidak ditemukan',
  server: 'server provider error', timeout: 'timeout', network: 'gangguan jaringan', empty: 'jawaban kosong',
  bad_request: 'request ditolak', unsupported: 'tidak didukung',
};
const TIER_LABEL = { group_ceo: 'Group CEO', business_manager: 'Business Manager', shared_services: 'Shared Services', business_staff: 'staf bisnis' };

function skippedOf(attempts, chosen) {
  const out = [];
  const seen = new Set();
  for (const a of attempts || []) {
    if (a.ok) continue;
    const key = `${a.provider}:${a.model}`;
    if (seen.has(key) || (chosen && a.provider === chosen.provider.name && a.model === chosen.model)) continue;
    seen.add(key);
    out.push({ provider: a.provider, model: a.model, why: a.skipped || ERR_KIND[a.kind] || String(a.error || 'gagal').slice(0, 80) });
  }
  return out;
}

/**
 * Build the explanation stored with an answer.
 * @param {{mode: 'auto'|'manual', need: object|null, chosen: object, list: object[], scored: Map|null, attempts: object[], tier?: string}} p
 */
export function describeChoice({ mode, need, chosen, list, scored, attempts, tier = null }) {
  const rank = list.indexOf(chosen) + 1;
  const info = scored?.get(chosen) || null;
  const skipped = skippedOf(attempts, chosen);
  const pinned = PINNED.has(chosen.source);
  let why;
  if (chosen.source === 'employee') why = 'Model khusus karyawan ini (diatur admin di menu Karyawan).';
  else if (chosen.source === 'employee-provider' || chosen.source === 'employee-fallback') why = 'Provider khusus karyawan ini (diatur admin di menu Karyawan).';
  else if (chosen.source === 'tier') why = `Model default tingkatan ${TIER_LABEL[tier] || 'karyawan'} (diatur admin di AI Providers).`;
  else if (mode === 'auto' && need && info) {
    const sig = need.signals?.length ? ` (${need.signals.join(', ')})` : '';
    const pros = info.pros.slice(0, 3);
    why = `Dipilih otomatis untuk kebutuhan ${need.label}${sig}: ${pros.length ? pros.join(', ') : 'paling sesuai di antara model yang tersedia'}. Peringkat ${rank} dari ${list.length} model.`;
  } else {
    const label = { default: 'model default provider utama', fallback: 'model cadangan provider utama', backup: 'model default provider cadangan', 'backup-fallback': 'model cadangan provider cadangan' }[chosen.source] || 'urutan tetap';
    why = `Mode manual: ${label}.`;
  }
  if (pinned && mode === 'auto' && need) why += ` Kebutuhan terdeteksi: ${need.label}; pilihan admin tetap diutamakan.`;
  if (skipped.length) why += ` Sebelumnya dilewati: ${skipped.slice(0, 4).map((s) => `${s.model} (${s.why})`).join('; ')}.`;
  return {
    v: 1,
    mode,
    need: need?.key || null,
    need_label: need?.label || null,
    signals: need?.signals || [],
    provider: chosen.provider.name,
    model: chosen.model,
    source: chosen.source,
    rank,
    of: list.length,
    strengths: info ? strengthsOf(info.profile) : [],
    skipped,
    text: why,
  };
}
