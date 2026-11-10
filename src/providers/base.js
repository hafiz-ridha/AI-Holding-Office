// OpenAI-compatible chat adapter. Shared by OpenRouter, 9Router, Groq, Gemini (OpenAI endpoint) and custom providers.
import { stripThinking } from '../lib/text.js';
import { cleanError } from '../lib/readable.js';

export class ProviderError extends Error {
  // kind: auth | quota | rate_limit | not_found | bad_request | server | timeout | network | empty | unsupported | cancelled
  constructor(message, { status = null, kind = 'server', retryAfterMs = null, daily = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.daily = daily;
  }
}

function classify(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server';
}

function parseRetryAfter(headers) {
  const v = headers.get('retry-after');
  if (!v) return null;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.min(sec * 1000, 24 * 3600 * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export class OpenAICompatibleAdapter {
  constructor(provider) {
    this.provider = provider; // row + decrypted apiKey
    this.baseUrl = String(provider.base_url || '').replace(/\/+$/, '');
    this.apiKey = provider.apiKey || '';
    this.timeoutMs = provider.timeout_ms || 60000;
  }

  get requiresKey() {
    return this.provider.keyRequired !== false;
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async request(path, { method = 'GET', body, timeoutMs = this.timeoutMs, signal } = {}) {
    if (!this.baseUrl) throw new ProviderError('Base URL belum diisi', { kind: 'bad_request' });
    if (this.requiresKey && !this.apiKey) throw new ProviderError('API key belum diisi', { kind: 'auth' });
    // An 'abort' listener never fires for an already-aborted signal, so check first.
    if (signal?.aborted) throw new ProviderError('Dibatalkan', { kind: 'cancelled' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ctrl.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new ProviderError('Dibatalkan', { kind: 'cancelled' });
      if (ctrl.signal.aborted) throw new ProviderError(`Timeout setelah ${Math.round(timeoutMs / 1000)} detik`, { kind: 'timeout' });
      throw new ProviderError(`Tidak dapat terhubung: ${e.cause?.code || e.message}`, { kind: 'network' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = this.errorMessage(data, text) || `HTTP ${res.status}`;
      throw new ProviderError(`HTTP ${res.status}: ${msg}`.slice(0, 500), {
        status: res.status,
        kind: classify(res.status),
        retryAfterMs: parseRetryAfter(res.headers),
        daily: res.status === 429 && /per[- ]?day|daily/i.test(msg),
      });
    }
    // Some gateways return HTTP 200 with an error object.
    if (data && data.error && !data.choices && !data.data) {
      const msg = this.errorMessage(data, text);
      const code = Number(data.error.code) || 500;
      throw new ProviderError(`Provider error: ${msg}`.slice(0, 500), {
        status: code,
        kind: classify(code),
        daily: code === 429 && /per[- ]?day|daily/i.test(msg),
      });
    }
    if (data === null) {
      throw new ProviderError('Respons bukan JSON (endpoint tidak kompatibel OpenAI?)', { status: res.status, kind: 'unsupported' });
    }
    return data;
  }

  errorMessage(data, text) {
    if (data?.error) {
      if (typeof data.error === 'string') return data.error;
      const raw = data.error.metadata?.raw;
      return cleanError([data.error.message, typeof raw === 'string' ? raw.slice(0, 300) : null].filter(Boolean).join(' — '));
    }
    if (data?.message) return cleanError(data.message);
    return cleanError(String(text || '').slice(0, 300)).slice(0, 200);
  }

  chatBody({ model, messages, maxTokens, temperature }) {
    const body = { model, messages, stream: false };
    if (maxTokens) body.max_tokens = maxTokens;
    if (temperature !== undefined && temperature !== null) body.temperature = temperature;
    return body;
  }

  async chat({ model, messages, maxTokens, temperature, signal }) {
    const data = await this.request('/chat/completions', {
      method: 'POST',
      body: this.chatBody({ model, messages, maxTokens, temperature }),
      signal,
    });
    const choice = data.choices?.[0];
    if (!choice) throw new ProviderError('Respons tidak memiliki choices', { kind: 'unsupported' });
    let content = choice.message?.content;
    if (Array.isArray(content)) content = content.map((c) => c.text || '').join('');
    content = stripThinking(content || '');
    if (!content) {
      throw new ProviderError(`Model mengembalikan jawaban kosong (finish_reason: ${choice.finish_reason || '-'})`, { kind: 'empty' });
    }
    const u = data.usage || {};
    return {
      content,
      model: data.model || model,
      finishReason: choice.finish_reason || null,
      tokensIn: Number(u.prompt_tokens) || 0,
      tokensOut: Number(u.completion_tokens) || 0,
      hasUsage: Boolean(u.prompt_tokens || u.completion_tokens),
      costUsd: typeof u.cost === 'number' ? u.cost : null,
    };
  }

  normalizeModel(m) {
    return {
      id: String(m.id),
      name: m.name || m.id,
      isFree: /:free$/.test(m.id),
      contextLength: Number(m.context_length || m.context_window) || null,
      pricingPrompt: null,
      pricingCompletion: null,
    };
  }

  async listModels() {
    const data = await this.request('/models', { timeoutMs: Math.min(this.timeoutMs, 30000) });
    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : null;
    if (!arr || (arr.length && typeof arr[0]?.id !== 'string')) {
      throw new ProviderError('Format daftar model tidak sesuai standar OpenAI (/models)', { kind: 'unsupported' });
    }
    return arr.map((m) => this.normalizeModel(m));
  }

  // Model list with a fallback to the preset's suggested ids for providers without a /models endpoint.
  async listModelsWithSource() {
    try {
      return { models: await this.listModels(), source: 'api' };
    } catch (e) {
      const suggested = this.provider.suggestedModels || [];
      if (e instanceof ProviderError && ['not_found', 'unsupported'].includes(e.kind) && suggested.length) {
        return {
          models: suggested.map((id) => ({ id, name: `${id} (saran preset)`, isFree: false, contextLength: null, pricingPrompt: null, pricingCompletion: null })),
          source: 'preset',
          warning: e.message,
        };
      }
      throw e;
    }
  }

  // Connection test: list models (no completion quota used). If the provider has no /models endpoint,
  // fall back to one tiny chat request against the default/suggested model.
  async testConnection() {
    try {
      const models = await this.listModels();
      return { ok: true, status: 'ok', message: `Terhubung. ${models.length} model tersedia.`, details: { modelCount: models.length } };
    } catch (e) {
      if (!(e instanceof ProviderError) || !['not_found', 'unsupported'].includes(e.kind)) throw e;
      return this.chatPing(e);
    }
  }

  async chatPing(cause) {
    const model = this.provider.default_model || this.provider.suggestedModels?.[0];
    if (!model) {
      throw new ProviderError(`Endpoint /models tidak tersedia (${cause.message}). Isi model default lalu tes lagi.`, { kind: 'unsupported' });
    }
    try {
      await this.chat({ model, messages: [{ role: 'user', content: 'Balas hanya: OK' }], maxTokens: 32, temperature: 0 });
    } catch (e) {
      // An empty answer still proves that the endpoint, key and model work.
      if (!(e instanceof ProviderError && e.kind === 'empty')) throw e;
    }
    return {
      ok: true,
      status: 'ok',
      message: `Terhubung. Endpoint /models tidak tersedia, jadi diuji dengan 1 request chat ke ${model}.`,
      details: { model, pinged: true },
    };
  }
}
