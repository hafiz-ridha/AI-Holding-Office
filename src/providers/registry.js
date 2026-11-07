// Provider types and the catalogue of cloud AI APIs that can be configured from the dashboard.
// Adding another OpenAI-compatible provider = adding one preset entry here (no other code changes).
//
// Free-tier facts below come from the providers' docs and two public directories
// (github.com/xyzs996/free-llm-api, verified 2026-08-22; github.com/mnfst/awesome-free-llm-apis, updated 2026-10-25).
// Limits change often: the app enforces the configured rpm/daily caps and the admin can edit them per provider.
import { OpenAICompatibleAdapter, ProviderError } from './base.js';
import { OpenRouterAdapter } from './openrouter.js';
import { NineRouterAdapter } from './ninerouter.js';

class GeminiOpenAIAdapter extends OpenAICompatibleAdapter {
  // Gemini's OpenAI-compatible /models returns ids like "models/gemini-2.5-flash".
  normalizeModel(m) {
    const base = super.normalizeModel(m);
    base.id = base.id.replace(/^models\//, '');
    return base;
  }
}

// Cloudflare Workers AI: chat via the OpenAI-compatible /ai/v1 path; the docs do not document /ai/v1/models,
// so the model list comes from Cloudflare's model search API (text-generation task).
class CloudflareAdapter extends OpenAICompatibleAdapter {
  async listModels() {
    const accountBase = this.baseUrl.replace(/\/ai\/v1$/, '');
    const url = `${accountBase}/ai/models/search?task=Text%20Generation&per_page=100`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { headers: this.headers(), signal: ctrl.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !Array.isArray(data.result)) {
        const msg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
        throw new ProviderError(`Cloudflare models: ${msg}`, { status: res.status, kind: res.status === 401 || res.status === 403 ? 'auth' : 'unsupported' });
      }
      return data.result.map((m) => ({ id: m.name, name: m.description ? `${m.name} — ${m.description.slice(0, 60)}` : m.name, isFree: true, contextLength: null, pricingPrompt: null, pricingCompletion: null }));
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(`Tidak dapat terhubung: ${e.cause?.code || e.message}`, { kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }
}

export const PROVIDER_TYPES = {
  openrouter: { label: 'OpenRouter', Adapter: OpenRouterAdapter },
  ninerouter: { label: '9Router (self-hosted)', Adapter: NineRouterAdapter },
  openai_compatible: { label: 'OpenAI-compatible', Adapter: OpenAICompatibleAdapter },
};

export const CATEGORIES = {
  free: 'Gratis permanen (tanpa kartu kredit)',
  trial: 'Kredit / trial gratis',
  self_hosted: 'Self-hosted gateway',
  custom: 'Lainnya',
};

// Fields: type, category, label, base_url, keyRequired, rpm_limit, daily_request_limit (0 = none), free (summary),
// docs, key_url, note, models (suggested ids; used when the provider has no /models endpoint), placeholders.
export const PRESETS = {
  openrouter: {
    type: 'openrouter', category: 'free', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', keyRequired: true,
    rpm_limit: 20, daily_request_limit: 50,
    free: 'Model berakhiran ":free": 20 request/menit, 50 request/hari (1.000/hari setelah membeli ≥10 kredit).',
    docs: 'https://openrouter.ai/docs', key_url: 'https://openrouter.ai/keys',
    note: 'Agregator ratusan model. Penyedia model gratis dapat mencatat prompt.',
  },
  gemini: {
    type: 'openai_compatible', category: 'free', label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true,
    rpm_limit: 10, daily_request_limit: 0,
    free: 'Free tier di Google AI Studio; batas bergantung model (lihat halaman rate limits).',
    docs: 'https://ai.google.dev/gemini-api/docs/openai', key_url: 'https://aistudio.google.com/apikey',
    note: 'Prompt free tier dapat dipakai untuk peningkatan produk Google (kecuali EEA/UK/CH).',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  },
  groq: {
    type: 'openai_compatible', category: 'free', label: 'Groq', base_url: 'https://api.groq.com/openai/v1', keyRequired: true,
    rpm_limit: 30, daily_request_limit: 1000,
    free: 'Free plan: ±30 request/menit, ±1.000 request/hari (berbeda per model).',
    docs: 'https://console.groq.com/docs/openai', key_url: 'https://console.groq.com/keys',
    note: 'Sangat cepat. Daftar model gratis berubah; gunakan "Ambil daftar model".',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  mistral: {
    type: 'openai_compatible', category: 'free', label: 'Mistral AI', base_url: 'https://api.mistral.ai/v1', keyRequired: true,
    rpm_limit: 50, daily_request_limit: 0,
    free: 'Paket gratis (Experiment): ±1 request/detik dengan kuota token bulanan.',
    docs: 'https://docs.mistral.ai/api/', key_url: 'https://console.mistral.ai/api-keys',
    note: 'Pada paket gratis, prompt dapat dipakai untuk melatih model kecuali Anda opt-out.',
    models: ['mistral-small-latest', 'open-mistral-nemo', 'codestral-latest'],
  },
  sambanova: {
    type: 'openai_compatible', category: 'free', label: 'SambaNova Cloud', base_url: 'https://api.sambanova.ai/v1', keyRequired: true,
    rpm_limit: 20, daily_request_limit: 20,
    free: 'Free tier: ±20 request/menit, ±20 request/hari.',
    docs: 'https://docs.sambanova.ai/cloud/docs/get-started/overview', key_url: 'https://cloud.sambanova.ai/apis',
    note: 'Kuota harian kecil: cocok sebagai provider cadangan.',
    models: ['Meta-Llama-3.3-70B-Instruct', 'DeepSeek-V3.1', 'gpt-oss-120b'],
  },
  cohere: {
    type: 'openai_compatible', category: 'free', label: 'Cohere (Compatibility API)', base_url: 'https://api.cohere.ai/compatibility/v1', keyRequired: true,
    rpm_limit: 20, daily_request_limit: 30,
    free: 'Trial key gratis: 20 request/menit, 1.000 panggilan/bulan, hanya untuk penggunaan non-komersial.',
    docs: 'https://docs.cohere.com/docs/compatibility-api', key_url: 'https://dashboard.cohere.com/api-keys',
    note: 'Batas harian default 30 agar kuota bulanan tidak habis.',
    models: ['command-a-03-2025', 'command-r-plus'],
  },
  cloudflare: {
    type: 'openai_compatible', category: 'free', label: 'Cloudflare Workers AI', base_url: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1', keyRequired: true,
    rpm_limit: 0, daily_request_limit: 0,
    free: '10.000 Neurons/hari gratis (reset 00:00 UTC); request di atas batas gagal, tidak ditagih.',
    docs: 'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/', key_url: 'https://dash.cloudflare.com/profile/api-tokens',
    note: 'Butuh Account ID dan API Token dengan izin Workers AI.',
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b'],
    placeholders: [{ key: 'ACCOUNT_ID', label: 'Cloudflare Account ID', pattern: '^[a-f0-9]{32}$' }],
  },
  zai: {
    type: 'openai_compatible', category: 'free', label: 'Z.AI (GLM)', base_url: 'https://api.z.ai/api/paas/v4', keyRequired: true,
    rpm_limit: 10, daily_request_limit: 0,
    free: 'Model GLM "Flash" gratis (1 request bersamaan).',
    docs: 'https://docs.z.ai/', key_url: 'https://z.ai/manage-apikey/apikey-list',
    note: 'GLM-4.5-Flash diumumkan akan pensiun; utamakan glm-4.7-flash.',
    models: ['glm-4.7-flash', 'glm-4.5-flash'],
  },
  fireworks: {
    type: 'openai_compatible', category: 'free', label: 'Fireworks AI', base_url: 'https://api.fireworks.ai/inference/v1', keyRequired: true,
    rpm_limit: 10, daily_request_limit: 0,
    free: 'Akses gratis terbatas (±10 request/menit) tanpa kartu kredit.',
    docs: 'https://docs.fireworks.ai/', key_url: 'https://fireworks.ai/account/api-keys',
    models: ['accounts/fireworks/models/gpt-oss-120b', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
  },
  alibaba: {
    type: 'openai_compatible', category: 'free', label: 'Alibaba Cloud Model Studio (Qwen)', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', keyRequired: true,
    rpm_limit: 30, daily_request_limit: 0,
    free: 'Kuota token gratis untuk model Qwen (region internasional).',
    docs: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope', key_url: 'https://modelstudio.console.alibabacloud.com/',
    models: ['qwen-plus', 'qwen-turbo', 'qwen3-coder-plus'],
  },
  llm7: {
    type: 'openai_compatible', category: 'free', label: 'LLM7.io', base_url: 'https://api.llm7.io/v1', keyRequired: false,
    rpm_limit: 30, daily_request_limit: 0,
    free: 'Akses anonim tanpa key; token gratis menaikkan batas (±60 request/menit).',
    docs: 'https://llm7.io/', key_url: 'https://token.llm7.io/',
    note: 'Kuota dapat turun tanpa pemberitahuan: pakai sebagai cadangan.',
    models: ['gpt-oss:20b', 'codestral-latest'],
  },
  ovhcloud: {
    type: 'openai_compatible', category: 'free', label: 'OVHcloud AI Endpoints', base_url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', keyRequired: false,
    rpm_limit: 2, daily_request_limit: 0,
    free: 'Tanpa key: 2 request/menit per IP per model. Dengan key: bayar sesuai pemakaian.',
    docs: 'https://endpoints.ai.cloud.ovh.net/', key_url: 'https://www.ovh.com/manager/',
    note: 'Server di Uni Eropa.',
    models: ['gpt-oss-120b'],
  },
  nvidia: {
    type: 'openai_compatible', category: 'trial', label: 'NVIDIA NIM (build.nvidia.com)', base_url: 'https://integrate.api.nvidia.com/v1', keyRequired: true,
    rpm_limit: 40, daily_request_limit: 0,
    free: 'Akses uji coba gratis melalui NVIDIA Developer Program (±40 request/menit).',
    docs: 'https://docs.api.nvidia.com/nim/reference/llm-apis', key_url: 'https://build.nvidia.com/',
    note: 'Untuk uji coba/pengembangan; pemakaian dicatat NVIDIA.',
    models: ['openai/gpt-oss-20b', 'meta/llama-3.3-70b-instruct'],
  },
  cerebras: {
    type: 'openai_compatible', category: 'trial', label: 'Cerebras Inference', base_url: 'https://api.cerebras.ai/v1', keyRequired: true,
    rpm_limit: 5, daily_request_limit: 0,
    free: 'Kredit trial gratis (±5 request/menit); sumber lain menyebut kartu kredit diperlukan.',
    docs: 'https://inference-docs.cerebras.ai/', key_url: 'https://cloud.cerebras.ai/',
    models: ['gpt-oss-120b'],
  },
  huggingface: {
    type: 'openai_compatible', category: 'trial', label: 'Hugging Face Inference Providers', base_url: 'https://router.huggingface.co/v1', keyRequired: true,
    rpm_limit: 0, daily_request_limit: 0,
    free: 'Kredit bulanan termasuk (terutama akun PRO/Team); selebihnya bayar sesuai pemakaian.',
    docs: 'https://huggingface.co/docs/inference-providers/index', key_url: 'https://huggingface.co/settings/tokens',
    note: 'Token fine-grained dengan izin "Make calls to Inference Providers". Akhiran :fastest / :cheapest pada model memilih penyedia.',
    models: ['openai/gpt-oss-120b:cheapest', 'deepseek-ai/DeepSeek-V3-0324'],
  },
  vercel: {
    type: 'openai_compatible', category: 'trial', label: 'Vercel AI Gateway', base_url: 'https://ai-gateway.vercel.sh/v1', keyRequired: true,
    rpm_limit: 0, daily_request_limit: 0,
    free: 'Kredit gratis bulanan untuk sebagian model.',
    docs: 'https://vercel.com/docs/ai-gateway', key_url: 'https://vercel.com/dashboard',
    models: ['openai/gpt-oss-120b'],
  },
  ninerouter: {
    type: 'ninerouter', category: 'self_hosted', label: '9Router (self-hosted)', base_url: 'http://host.docker.internal:20128/v1', keyRequired: false,
    rpm_limit: 0, daily_request_limit: 0,
    free: 'Gateway yang Anda jalankan sendiri; biaya mengikuti provider di belakangnya.',
    docs: 'https://github.com/decolua/9router', key_url: '',
    note: 'API key dari dashboard 9Router (wajib jika REQUIRE_API_KEY=true). Model memakai prefix seperti kr/, cc/, gh/ atau nama combo.',
  },
  custom: {
    type: 'openai_compatible', category: 'custom', label: 'Custom OpenAI-compatible', base_url: '', keyRequired: false,
    rpm_limit: 0, daily_request_limit: 0,
    free: '-', docs: '', key_url: '',
    note: 'Server apa pun yang menyediakan /chat/completions (dan sebaiknya /models) berformat OpenAI.',
  },
};

// Listed for transparency in the dashboard: researched but not offered as presets.
export const EXCLUDED = [
  { name: 'GitHub Models', reason: 'Free tier dihentikan 30-07-2026 dan ditutup untuk pengguna baru.' },
  { name: 'Together AI, Novita, DeepInfra, Chutes, Nebius, Perplexity', reason: 'Sekarang berbayar per pemakaian (tidak ada free tier tetap). Tetap dapat ditambah via "Custom".' },
  { name: 'SiliconFlow, ModelScope', reason: 'Memerlukan verifikasi identitas/real-name Tiongkok.' },
  { name: 'Ollama Cloud', reason: 'Dikecualikan sesuai spesifikasi proyek (hindari Ollama).' },
  { name: 'IBM watsonx.ai', reason: 'Tidak kompatibel dengan format OpenAI.' },
  { name: 'Pollinations, Kilo Code, Gonka, Aion Labs', reason: 'Endpoint/keandalan belum dapat diverifikasi; dapat ditambah via "Custom" bila diperlukan.' },
];

export function createAdapter(row) {
  const preset = PRESETS[row.preset];
  const providerRow = { ...row, keyRequired: preset?.keyRequired ?? true, suggestedModels: preset?.models || [] };
  if (row.preset === 'gemini') return new GeminiOpenAIAdapter(providerRow);
  if (row.preset === 'cloudflare') return new CloudflareAdapter(providerRow);
  const t = PROVIDER_TYPES[providerRow.type];
  if (!t) throw new Error(`Tipe provider tidak dikenal: ${providerRow.type}`);
  return new t.Adapter(providerRow);
}
