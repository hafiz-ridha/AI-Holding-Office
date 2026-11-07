// 9Router adapter. 9Router (github.com/decolua/9router) is a self-hosted gateway that exposes an
// OpenAI-compatible API: POST /v1/chat/completions and GET /v1/models (default http://localhost:20128/v1).
// Bearer auth is only enforced when the 9Router instance runs with REQUIRE_API_KEY=true, so the key is optional.
// Model ids use provider prefixes (e.g. "kr/claude-sonnet-4.5") or combo names.
import { OpenAICompatibleAdapter, ProviderError } from './base.js';

export class NineRouterAdapter extends OpenAICompatibleAdapter {
  get requiresKey() {
    return false;
  }

  normalizeModel(m) {
    const base = super.normalizeModel(m);
    // 9Router does not publish pricing; free tiers are identified by its own prefixes only in docs, so leave isFree false
    // unless the id carries an explicit :free suffix.
    base.name = m.name || m.id;
    return base;
  }

  async testConnection() {
    try {
      const models = await this.listModels();
      return {
        ok: true,
        status: 'ok',
        message: `9Router terhubung. ${models.length} model/combo tersedia.`,
        details: { modelCount: models.length },
      };
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === 'not_found' || e.kind === 'unsupported')) {
        const hint = /\/v1$/.test(this.baseUrl) ? '' : ' Coba Base URL yang diakhiri /v1 (contoh: http://host:20128/v1).';
        throw new ProviderError(`Endpoint /models tidak kompatibel: ${e.message}.${hint}`, { kind: 'unsupported', status: e.status });
      }
      throw e;
    }
  }
}
