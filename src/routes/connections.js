// Connections (dashboard → Koneksi) and the index of files stored outside (dashboard → File).
// Secrets go in, never out: responses only carry status, account, ids and hints. Every change is audited without
// secret values.
import * as google from '../connections/google.js';
import { TOKEN_PROVIDERS, tokenPublic, connectToken, retestToken, disconnectToken } from '../connections/tokens.js';
import { PROVIDERS, ConnectionError } from '../connections/store.js';
import { listArtifacts, retryArtifact, getArtifact, KIND_LABEL } from '../connections/artifacts.js';
import { runApprovedAction } from '../agents/actions.js';
import { q } from '../db/index.js';
import { auditReq } from '../lib/audit.js';
import { idParam, body, str, httpError } from './schemas.js';

// Connection errors are the owner's to fix (wrong client id, not linked, Google refused): show their message.
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectionError) throw httpError(e.message, 400);
    throw e;
  }
}

export default async function connectionRoutes(app) {
  app.get('/api/connections', async () => ({
    google_drive: google.googlePublic(),
    tokens: Object.keys(TOKEN_PROVIDERS).map(tokenPublic),
    next: Object.entries(PROVIDERS).filter(([k]) => k !== 'google_drive' && !TOKEN_PROVIDERS[k]).map(([provider, label]) => ({ provider, label })),
  }));

  // ---------------- services linked with a pasted token (GitHub, Vercel, Netlify, Cloudflare) ----------------
  const tokenParams = { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: Object.keys(TOKEN_PROVIDERS) } } };

  // The token is tested before it is stored; an empty token keeps the stored one (only the other fields change).
  app.put('/api/connections/token/:provider', {
    schema: { params: tokenParams, body: body({ token: str(500), team_id: str(100), account_id: str(100) }) },
  }, async (req) => guarded(async () => {
    const out = await connectToken(req.params.provider, req.body);
    auditReq(req, 'connection_updated', req.params.provider, { token_changed: Boolean(req.body.token), account: out.account });
    return out;
  }));

  app.post('/api/connections/token/:provider/test', { schema: { params: tokenParams } }, async (req) => guarded(async () => {
    const out = await retestToken(req.params.provider);
    auditReq(req, 'connection_tested', req.params.provider);
    return out;
  }));

  app.delete('/api/connections/token/:provider', { schema: { params: tokenParams } }, async (req) => {
    const out = disconnectToken(req.params.provider);
    auditReq(req, 'connection_removed', req.params.provider);
    return out;
  });

  app.put('/api/connections/google_drive', {
    schema: { body: body({ client_id: str(300, 10), client_secret: str(300) }, ['client_id']) },
  }, async (req) => guarded(() => {
    google.setClient(req.body);
    auditReq(req, 'connection_updated', 'google_drive', { client_id: req.body.client_id, client_secret_changed: Boolean(req.body.client_secret) });
    return google.googlePublic();
  }));

  // Device flow: returns the code the owner enters at google.com/device; the server then polls Google in the background.
  app.post('/api/connections/google_drive/connect', async (req) => guarded(async () => {
    const pending = await google.startDeviceFlow();
    auditReq(req, 'connection_link_started', 'google_drive');
    return { ...google.googlePublic(), pending };
  }));

  // Check right away (the background poll follows Google's interval).
  app.post('/api/connections/google_drive/poll', async () => guarded(async () => {
    const state = await google.pollDeviceFlow();
    return { state, ...google.googlePublic() };
  }));

  app.post('/api/connections/google_drive/test', async (req) => guarded(async () => {
    const me = await google.about();
    await google.ensureFolder([]);
    auditReq(req, 'connection_tested', 'google_drive');
    return { ok: true, account: me?.user?.emailAddress || null, ...google.googlePublic() };
  }));

  app.delete('/api/connections/google_drive', async (req) => guarded(async () => {
    await google.disconnect();
    auditReq(req, 'connection_removed', 'google_drive');
    return google.googlePublic();
  }));

  // ---------------- files stored outside ----------------
  app.get('/api/artifacts', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          business: { type: 'string', pattern: '^(hq|\\d+)$' },
          kind: { type: 'string', enum: Object.keys(KIND_LABEL) },
          status: { type: 'string', enum: ['pending', 'synced', 'failed', 'trashed'] },
        },
      },
    },
  }, async (req) => {
    const { business, kind, status } = req.query;
    const businessId = business === undefined ? undefined : business === 'hq' ? null : Number(business);
    return { items: listArtifacts({ businessId, kind: kind || null, status: status || null }), kinds: KIND_LABEL };
  });

  app.post('/api/artifacts/:id/retry', { schema: { params: idParam } }, async (req) => guarded(async () => {
    if (!getArtifact(req.params.id)) throw httpError('File tidak ditemukan', 404);
    const a = await retryArtifact(req.params.id);
    auditReq(req, 'artifact_retry', `F-${req.params.id}`, { status: a?.status }, a?.business_id ?? null);
    return a;
  }));

  // An approved action that failed (e.g. Drive was not connected yet): run it again.
  app.post('/api/approvals/:id/run', { schema: { params: idParam } }, async (req) => {
    const a = q.get('SELECT * FROM approvals WHERE id = ?', req.params.id);
    if (!a) throw httpError('Persetujuan tidak ditemukan', 404);
    if (!a.action || a.status !== 'approved' || a.action_status !== 'failed') throw httpError('Hanya aksi yang sudah disetujui dan gagal yang bisa dijalankan ulang');
    const r = await runApprovedAction(a.id);
    auditReq(req, 'action_rerun', `#${a.id}`, { status: r.action_status }, a.business_id);
    return r;
  });
}
