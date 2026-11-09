import {
  listProviders, createProvider, updateProvider, deleteProvider, setDefaultProvider, testProvider, syncModels,
  listModels, getProviderRow, toPublic,
} from '../providers/service.js';
import { PRESETS, CATEGORIES, EXCLUDED } from '../providers/registry.js';
import { routeChat, routingOverview } from '../router/modelRouter.js';
import { auditReq } from '../lib/audit.js';
import { idParam, body, str, bool, intRange, httpError } from './schemas.js';

const fields = {
  name: str(80, 1),
  preset: { type: 'string', enum: Object.keys(PRESETS) },
  base_url: str(300, 8),
  api_key: str(400),
  clear_api_key: bool,
  enabled: bool,
  priority: intRange(0, 1000),
  default_model: { type: ['string', 'null'], maxLength: 200 },
  fallback_models: { type: 'array', maxItems: 10, items: str(200) },
  timeout_ms: intRange(5000, 300000),
  max_retries: intRange(0, 3),
  rpm_limit: intRange(0, 10000),
  daily_request_limit: intRange(0, 1000000),
};

export default async function providerRoutes(app) {
  app.get('/api/providers', async () => listProviders());

  app.get('/api/providers/presets', async () =>
    Object.entries(PRESETS).map(([key, p]) => ({ key, ...p }))
  );

  app.get('/api/providers/catalog', async () => ({ categories: CATEGORIES, excluded: EXCLUDED }));

  // Automatic model selection overview: best model per need + detected strengths of each configured model.
  app.get('/api/providers/routing', async () => routingOverview());

  app.post('/api/providers', { schema: { body: body(fields, ['preset']) } }, async (req, reply) => {
    const p = createProvider(req.body);
    auditReq(req, 'provider_created', p.name, { preset: p.preset });
    return reply.code(201).send(p);
  });

  app.put('/api/providers/:id', { schema: { params: idParam, body: body(fields) } }, async (req) => {
    const p = updateProvider(req.params.id, req.body);
    const changed = Object.keys(req.body).filter((k) => k !== 'api_key');
    auditReq(req, 'provider_updated', p.name, { fields: changed, api_key_changed: Boolean(req.body.api_key) });
    return p;
  });

  app.delete('/api/providers/:id', { schema: { params: idParam } }, async (req) => {
    const row = getProviderRow(req.params.id);
    deleteProvider(req.params.id);
    auditReq(req, 'provider_deleted', row?.name);
    return { ok: true };
  });

  app.post('/api/providers/:id/default', { schema: { params: idParam } }, async (req) => {
    const p = setDefaultProvider(req.params.id);
    auditReq(req, 'provider_default', p.name);
    return p;
  });

  app.post('/api/providers/:id/test', { schema: { params: idParam } }, async (req) => {
    const r = await testProvider(req.params.id);
    auditReq(req, 'provider_tested', r.provider?.name, { ok: r.ok, status: r.status });
    return r;
  });

  app.post('/api/providers/:id/models/sync', { schema: { params: idParam } }, async (req) => {
    const r = await syncModels(req.params.id);
    auditReq(req, 'provider_models_synced', `provider:${req.params.id}`, r);
    return { ...r, provider: toPublic(getProviderRow(req.params.id)) };
  });

  app.get('/api/providers/:id/models', {
    schema: {
      params: idParam,
      querystring: { type: 'object', properties: { free: { type: 'boolean' }, q: str(100) } },
    },
  }, async (req) => listModels(req.params.id, { free: req.query.free, search: req.query.q || '' }));

  // Sends one tiny real completion (uses 1 request of quota).
  app.post('/api/providers/:id/test-model', {
    schema: { params: idParam, body: body({ model: str(200, 1) }, ['model']) },
  }, async (req) => {
    const p = getProviderRow(req.params.id);
    if (!p) throw httpError('Provider tidak ditemukan', 404);
    const started = Date.now();
    try {
      const r = await routeChat({
        messages: [{ role: 'user', content: 'Balas hanya dengan kata: OK' }],
        purpose: 'test',
        maxTokens: 16,
        temperature: 0,
        candidates: [{ provider: p, model: req.body.model, source: 'test' }],
      });
      return { ok: true, reply: r.content.slice(0, 200), model: r.model, latency_ms: Date.now() - started, tokens: r.tokensIn + r.tokensOut };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
