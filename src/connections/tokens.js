// Connections linked with a token the owner pastes: GitHub, Vercel, Netlify, Cloudflare (Pages). The token is tested
// against the service before it is stored (encrypted); the dashboard only sees status, account and a hint. A token the
// service later rejects (401) marks the connection "expired" and alerts the owner.
import { config } from '../config.js';
import { bus } from '../events.js';
import { maskSecret } from '../lib/crypto.js';
import { apiFetch } from './http.js';
import { PROVIDERS, ConnectionError, getConnection, connectionConfig, connectionSecret, saveConnection } from './store.js';

const ghHeaders = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

/** Per service: extra non-secret fields and the test (returns { account, config }). */
export const TOKEN_PROVIDERS = {
  github: {
    fields: {},
    async test(token) {
      const { data, headers } = await apiFetch(config.githubApiBase, '/user', { service: 'GitHub', token, headers: ghHeaders, full: true });
      // Classic tokens list their scopes; fine-grained tokens do not (their permissions are checked when used).
      const scopes = headers.get('x-oauth-scopes');
      if (scopes !== null && !scopes.split(',').map((s) => s.trim()).includes('repo')) {
        throw new ConnectionError('Token GitHub klasik ini tidak punya scope "repo". Buat token dengan scope repo, atau token fine-grained (lihat panduan).');
      }
      return { account: data.login, config: { login: data.login, token_type: scopes === null ? 'fine-grained' : 'classic' } };
    },
  },
  vercel: {
    fields: { team_id: { label: 'Team ID', pattern: /^team_[A-Za-z0-9]+$/, hint: 'diawali team_' } },
    async test(token, { team_id }) {
      const u = await apiFetch(config.vercelApiBase, '/v2/user', { service: 'Vercel', token });
      let account = u?.user?.username || u?.user?.email || 'akun Vercel';
      if (team_id) {
        const t = await apiFetch(config.vercelApiBase, `/v2/teams/${encodeURIComponent(team_id)}`, { service: 'Vercel', token });
        account = `${account} · tim ${t?.name || t?.slug || team_id}`;
      }
      return { account, config: { team_id: team_id || null } };
    },
  },
  netlify: {
    fields: {},
    async test(token) {
      const u = await apiFetch(config.netlifyApiBase, '/api/v1/user', { service: 'Netlify', token });
      return { account: u?.email || u?.full_name || u?.slug || 'akun Netlify', config: {} };
    },
  },
  cloudflare: {
    fields: { account_id: { label: 'Account ID', required: true, pattern: /^[a-f0-9]{32}$/, hint: '32 karakter heksadesimal' } },
    async test(token, { account_id }) {
      await apiFetch(config.cloudflareApiBase, `/accounts/${account_id}/pages/projects`, { service: 'Cloudflare', token });
      return { account: `Akun ${account_id.slice(0, 8)}…`, config: { account_id } };
    },
  },
};

export const isTokenProvider = (p) => Object.hasOwn(TOKEN_PROVIDERS, p);

/** Public view of a token connection: never the token. */
export function tokenPublic(provider) {
  const row = getConnection(provider);
  const cfg = connectionConfig(provider);
  const fields = Object.fromEntries(Object.keys(TOKEN_PROVIDERS[provider].fields).map((k) => [k, cfg[k] ?? null]));
  return {
    provider,
    label: PROVIDERS[provider],
    status: row?.status || 'disconnected',
    account: row?.account || null,
    token_hint: row?.secret_hint || null,
    has_token: Boolean(row?.secret_enc),
    ...fields,
    ...(provider === 'github' ? { token_type: cfg.token_type || null } : {}),
    error: row?.error || null,
    connected_at: row?.connected_at || null,
  };
}

function cleanFields(provider, input) {
  const out = {};
  for (const [k, spec] of Object.entries(TOKEN_PROVIDERS[provider].fields)) {
    const v = String(input?.[k] ?? '').trim();
    if (!v) {
      if (spec.required) throw new ConnectionError(`${spec.label} wajib diisi`);
      out[k] = null;
      continue;
    }
    if (spec.pattern && !spec.pattern.test(v)) throw new ConnectionError(`${spec.label} tidak valid (${spec.hint})`);
    out[k] = v;
  }
  return out;
}

/**
 * Save (and first test) a token. An empty token keeps the stored one (to change only the other fields).
 * Nothing is stored when the test fails.
 */
export async function connectToken(provider, input = {}) {
  if (!isTokenProvider(provider)) throw new ConnectionError('Layanan tidak dikenal');
  const fields = cleanFields(provider, input);
  const token = String(input.token || '').trim() || connectionSecret(provider).token;
  if (!token) throw new ConnectionError('Token wajib diisi');
  if (/\s/.test(token) || token.length > 500) throw new ConnectionError('Token tidak valid (tanpa spasi, maks 500 karakter)');
  const { account, config: cfg } = await TOKEN_PROVIDERS[provider].test(token, fields);
  saveConnection(provider, { status: 'connected', account, config: { ...fields, ...cfg }, secret: { token }, hint: maskSecret(token), error: null });
  return tokenPublic(provider);
}

/** Test the stored token again (button "Tes koneksi"). Updates the status. */
export async function retestToken(provider) {
  const { token } = connectionSecret(provider);
  if (!token) throw new ConnectionError(`${PROVIDERS[provider]} belum terhubung`);
  try {
    const { account } = await TOKEN_PROVIDERS[provider].test(token, connectionConfig(provider));
    saveConnection(provider, { status: 'connected', account, error: null });
  } catch (e) {
    saveConnection(provider, { status: e.status === 401 || e.status === 403 ? 'expired' : 'error', error: e.message });
    throw e;
  }
  return tokenPublic(provider);
}

export function disconnectToken(provider) {
  saveConnection(provider, { status: 'disconnected', account: null, secret: null, hint: null, error: null, config: {} });
  return tokenPublic(provider);
}

/** The stored token for server-side calls. */
export function tokenFor(provider) {
  const row = getConnection(provider);
  const { token } = connectionSecret(provider);
  if (!token || row?.status !== 'connected') throw new ConnectionError(`${PROVIDERS[provider]} belum terhubung. Hubungkan di dashboard → Koneksi.`);
  return token;
}

/** The service rejected the stored token (401): the owner must paste a new one. */
export function tokenRejected(provider, message) {
  if (getConnection(provider)?.status !== 'connected') return;
  saveConnection(provider, { status: 'expired', error: message });
  bus.emit('system:alert', {
    key: `${provider}_expired`,
    title: `${PROVIDERS[provider]} perlu dihubungkan ulang`,
    message: `Token ${PROVIDERS[provider]} ditolak (kedaluwarsa atau dicabut). Buat token baru lalu tempel di dashboard → Koneksi.`,
  });
}

/** apiFetch with the stored token of `provider`; a 401 marks the connection expired. */
export async function withToken(provider, base, path, opts = {}) {
  const token = tokenFor(provider);
  try {
    return await apiFetch(base, path, { service: PROVIDERS[provider].replace(' Pages', ''), ...opts, token });
  } catch (e) {
    if (e.status === 401) tokenRejected(provider, e.message);
    throw e;
  }
}
