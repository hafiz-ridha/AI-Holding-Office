// OpenRouter adapter (https://openrouter.ai/docs). OpenAI-compatible with extra headers, pricing, and key info.
import { OpenAICompatibleAdapter } from './base.js';
import { config } from '../config.js';

export class OpenRouterAdapter extends OpenAICompatibleAdapter {
  headers() {
    const h = super.headers();
    // Optional attribution headers documented by OpenRouter.
    if (config.appUrl) h['HTTP-Referer'] = config.appUrl;
    h['X-Title'] = config.appName;
    return h;
  }

  normalizeModel(m) {
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    const zeroPrice = m.pricing && prompt === 0 && completion === 0;
    return {
      id: String(m.id),
      name: m.name || m.id,
      isFree: /:free$/.test(m.id) || Boolean(zeroPrice && !/^openrouter\/auto$/.test(m.id)),
      contextLength: Number(m.context_length) || null,
      pricingPrompt: Number.isFinite(prompt) && prompt >= 0 ? prompt : null,
      pricingCompletion: Number.isFinite(completion) && completion >= 0 ? completion : null,
    };
  }

  chatBody(args) {
    const body = super.chatBody(args);
    body.usage = { include: true }; // ask OpenRouter to return token usage + cost
    return body;
  }

  // GET /key returns credit/limit info for the API key (validates the key without using quota).
  async keyInfo() {
    const data = await this.request('/key', { timeoutMs: 15000 });
    return data?.data || {};
  }

  async testConnection() {
    const info = await this.keyInfo();
    const models = await this.listModels();
    const free = models.filter((m) => m.isFree).length;
    const daily = info.free_model_daily_requests;
    const parts = [`Key valid. ${models.length} model (${free} gratis).`];
    if (info.is_free_tier !== undefined) parts.push(info.is_free_tier ? 'Akun free tier.' : 'Akun berbayar.');
    if (daily && daily.limit !== undefined) parts.push(`Kuota model gratis hari ini: ${daily.remaining ?? '?'} / ${daily.limit}.`);
    if (info.limit_remaining !== undefined && info.limit_remaining !== null) parts.push(`Sisa kredit key: ${info.limit_remaining}.`);
    return {
      ok: true,
      status: 'ok',
      message: parts.join(' '),
      details: {
        modelCount: models.length,
        freeModelCount: free,
        isFreeTier: info.is_free_tier ?? null,
        freeModelDailyRequests: daily ?? null,
        limitRemaining: info.limit_remaining ?? null,
        usageDaily: info.usage_daily ?? null,
      },
    };
  }
}
