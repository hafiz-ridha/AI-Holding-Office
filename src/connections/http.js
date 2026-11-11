// Small JSON client for the REST APIs of outside services (GitHub, Vercel, Netlify, Cloudflare). Plain fetch with a
// timeout; failures become ConnectionError with the service's own message (never the token).
import { ConnectionError } from './store.js';

const TIMEOUT_MS = 30_000;

function signalFor(signal, timeout) {
  const t = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** The readable message in an error body of any of the supported services. */
export function serviceMessage(data, status) {
  if (!data || typeof data !== 'object') return `HTTP ${status}`;
  // Cloudflare: { success: false, errors: [{ code, message }] }
  if (Array.isArray(data.errors) && data.errors.length && data.errors[0]?.message && !data.message) {
    return data.errors.map((e) => e.message).filter(Boolean).slice(0, 3).join('; ');
  }
  // Vercel: { error: { code, message } }
  if (data.error && typeof data.error === 'object' && data.error.message) return data.error.message;
  // GitHub: { message, errors: [{ message } | { code, field }] }; Netlify: { message } / { errors: "..." }
  if (data.message) {
    const extra = Array.isArray(data.errors)
      ? data.errors.map((e) => (typeof e === 'string' ? e : e?.message || (e?.code && e?.field ? `${e.field} ${e.code}` : ''))).filter(Boolean).slice(0, 3).join('; ')
      : '';
    return extra ? `${data.message}: ${extra}` : data.message;
  }
  if (typeof data.error === 'string') return data.error_description || data.error;
  if (typeof data.errors === 'string') return data.errors;
  return `HTTP ${status}`;
}

/**
 * Request to `${base}${path}`. `json` sends a JSON body; `body` sends raw bytes (Buffer / FormData).
 * Returns the parsed JSON (null for empty bodies), or { data, headers, status } with `full: true`.
 * Errors: ConnectionError(`${service}: message`, { status, code }).
 */
export async function apiFetch(base, path, {
  service, token, method = 'GET', query = null, json, body, headers = {}, signal, timeout = TIMEOUT_MS, full = false,
} = {}) {
  const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
  const url = `${base}${path}${qs.length ? `${path.includes('?') ? '&' : '?'}${new URLSearchParams(qs)}` : ''}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'AI-Office',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: signalFor(signal, timeout),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ConnectionError(`${service} tidak dapat dihubungi: ${e.name === 'TimeoutError' ? 'waktu habis' : e.cause?.code || e.name}`);
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = typeof data === 'string' ? data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || `HTTP ${res.status}` : serviceMessage(data, res.status);
    const code = (data && typeof data === 'object' && (data.error?.code || data.errors?.[0]?.code || data.code)) || null;
    throw new ConnectionError(`${service}: ${msg}`.slice(0, 400), { status: res.status, code });
  }
  return full ? { data, headers: res.headers, status: res.status } : data;
}
