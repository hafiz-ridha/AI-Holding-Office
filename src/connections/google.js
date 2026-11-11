// Google Drive for a personal Gmail account, connected with the OAuth device flow ("TVs and Limited Input devices"
// client): no domain, HTTPS or redirect URI needed. Scope drive.file: the app only sees files it created itself.
// The refresh token is stored encrypted (connections table); access tokens live in memory only. Errors never contain
// tokens. Files: "AI Office/<HQ or business>/<Dokumen|Laporan>", Markdown uploaded as Google Docs.
import { config } from '../config.js';
import { bus } from '../events.js';
import { markdownToHtml } from '../lib/markdown.js';
import { maskSecret, randomToken } from '../lib/crypto.js';
import { getConnection, connectionConfig, connectionSecret, saveConnection, patchConfig, patchSecret, ConnectionError } from './store.js';

export const PROVIDER = 'google_drive';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const ROOT_FOLDER = 'AI Office';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const TIMEOUT_MS = 20_000;

let access = null; // { token, exp }
let flow = null; // pending device flow { device_code, user_code, verification_url, expires_at, interval, timer }

// ---------------- HTTP ----------------
function signalFor(signal) {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function oauthPost(path, params) {
  let res;
  try {
    res = await fetch(`${config.googleOAuthBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: signalFor(),
    });
  } catch (e) {
    throw new ConnectionError(`Tidak dapat menghubungi Google: ${e.cause?.code || e.name}`);
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Google Drive API call with the stored account. Retries once with a fresh token on 401. */
async function gapi(method, path, { query = null, json = null, body = null, contentType = null, upload = false, text = false, signal } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken();
    const url = `${config.googleApiBase}${upload ? '/upload' : ''}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(json ? { 'content-type': 'application/json' } : contentType ? { 'content-type': contentType } : {}),
        },
        body: json ? JSON.stringify(json) : body,
        signal: signalFor(signal),
      });
    } catch (e) {
      throw new ConnectionError(`Google Drive tidak dapat dihubungi: ${e.name === 'TimeoutError' ? 'waktu habis' : e.cause?.code || e.name}`);
    }
    if (res.status === 401 && attempt === 0) {
      access = null;
      continue;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const msg = data?.error?.message || data?.error_description || `HTTP ${res.status}`;
      throw new ConnectionError(`Google Drive: ${msg}`.slice(0, 300), { status: res.status, code: data?.error?.errors?.[0]?.reason || null });
    }
    if (res.status === 204) return null;
    return text ? res.text() : res.json();
  }
  throw new ConnectionError('Google Drive menolak akses (401)');
}

// ---------------- client & tokens ----------------
export function setClient({ client_id, client_secret }) {
  const id = String(client_id || '').trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new ConnectionError('Client ID tidak valid (harus berakhiran .apps.googleusercontent.com)');
  }
  const cfg = connectionConfig(PROVIDER);
  const sec = connectionSecret(PROVIDER);
  const changed = cfg.client_id && cfg.client_id !== id;
  const secret = { ...sec, ...(client_secret ? { client_secret: String(client_secret).trim() } : {}) };
  if (!secret.client_secret) throw new ConnectionError('Client Secret wajib diisi');
  if (changed) {
    // Another OAuth client: the old account link is not valid for it.
    delete secret.refresh_token;
    access = null;
  }
  saveConnection(PROVIDER, {
    config: changed ? { client_id: id } : { ...cfg, client_id: id },
    secret,
    hint: maskSecret(secret.client_secret),
    status: changed || !secret.refresh_token ? 'disconnected' : getConnection(PROVIDER)?.status,
    ...(changed ? { account: null } : {}),
    error: null,
  });
}

function expire(reason) {
  access = null;
  const sec = connectionSecret(PROVIDER);
  delete sec.refresh_token;
  saveConnection(PROVIDER, { status: 'expired', secret: sec, error: reason });
  bus.emit('system:alert', {
    key: 'google_drive_expired',
    title: 'Google Drive perlu dihubungkan ulang',
    message: `${reason} Buka dashboard → Koneksi → Google Drive → Hubungkan.`,
  });
}

export async function accessToken() {
  if (access && access.exp > Date.now() + 60_000) return access.token;
  const { client_id } = connectionConfig(PROVIDER);
  const { client_secret, refresh_token } = connectionSecret(PROVIDER);
  if (!client_id || !client_secret || !refresh_token || getConnection(PROVIDER)?.status !== 'connected') {
    throw new ConnectionError('Google Drive belum terhubung. Hubungkan di dashboard → Koneksi.');
  }
  const r = await oauthPost('/token', { client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  if (!r.ok || !r.data.access_token) {
    if (r.data?.error === 'invalid_grant' || r.data?.error === 'invalid_client' || r.data?.error === 'unauthorized_client') {
      expire(r.data.error === 'invalid_grant' ? 'Akses Google Drive kedaluwarsa atau dicabut.' : 'Client ID/Secret Google ditolak.');
    }
    throw new ConnectionError(`Token Google gagal diperbarui: ${r.data?.error_description || r.data?.error || `HTTP ${r.status}`}`);
  }
  access = { token: r.data.access_token, exp: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 };
  return access.token;
}

// ---------------- device flow ----------------
/** Starts linking a Google account: returns the code the owner enters at the verification URL. */
export async function startDeviceFlow() {
  const { client_id } = connectionConfig(PROVIDER);
  const { client_secret } = connectionSecret(PROVIDER);
  if (!client_id || !client_secret) throw new ConnectionError('Isi Client ID dan Client Secret Google dulu.');
  stopDeviceFlow();
  const r = await oauthPost('/device/code', { client_id, scope: SCOPE });
  if (!r.ok || !r.data.device_code) {
    throw new ConnectionError(`Google menolak permintaan kode: ${r.data?.error_description || r.data?.error || `HTTP ${r.status}`}. ` +
      'Pastikan tipe OAuth Client "TVs and Limited Input devices" dan Google Drive API sudah diaktifkan.');
  }
  // Linking another account while connected: the current link keeps working until the new one is allowed.
  const wasConnected = getConnection(PROVIDER)?.status === 'connected' && Boolean(connectionSecret(PROVIDER).refresh_token);
  flow = {
    id: randomToken(8),
    wasConnected,
    device_code: r.data.device_code,
    user_code: r.data.user_code,
    verification_url: r.data.verification_url || r.data.verification_uri || 'https://www.google.com/device',
    expires_at: Date.now() + (Number(r.data.expires_in) || 1800) * 1000,
    interval: Math.max(1, Number(r.data.interval) || 5) * 1000,
    timer: null,
  };
  saveConnection(PROVIDER, { status: wasConnected ? 'connected' : 'pending', error: null });
  schedulePoll();
  return pendingFlow();
}

export const pendingFlow = () => (flow ? { user_code: flow.user_code, verification_url: flow.verification_url, expires_at: flow.expires_at } : null);

export function stopDeviceFlow() {
  if (flow?.timer) clearTimeout(flow.timer);
  flow = null;
}

function schedulePoll() {
  if (!flow) return;
  flow.timer = setTimeout(() => pollDeviceFlow().catch(() => {}), flow.interval);
  flow.timer.unref?.();
}

/** One poll of the token endpoint. Returns 'pending' | 'connected' | 'denied' | 'expired' | 'idle'. */
export async function pollDeviceFlow() {
  if (!flow) return 'idle';
  const f = flow;
  if (Date.now() > f.expires_at) {
    stopDeviceFlow();
    saveConnection(PROVIDER, { status: f.wasConnected ? 'connected' : 'disconnected', error: 'Kode kedaluwarsa sebelum dimasukkan. Klik Hubungkan lagi.' });
    return 'expired';
  }
  const { client_id } = connectionConfig(PROVIDER);
  const { client_secret } = connectionSecret(PROVIDER);
  let r;
  try {
    r = await oauthPost('/token', { client_id, client_secret, device_code: f.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  } catch {
    if (flow === f) schedulePoll(); // network hiccup: keep waiting
    return 'pending';
  }
  if (flow !== f) return 'idle'; // restarted or stopped meanwhile
  const err = r.data?.error;
  if (err === 'authorization_pending' || err === 'slow_down') {
    if (err === 'slow_down') f.interval += 5000;
    schedulePoll();
    return 'pending';
  }
  stopDeviceFlow();
  if (!r.ok || !r.data.access_token) {
    const denied = err === 'access_denied';
    saveConnection(PROVIDER, {
      status: f.wasConnected ? 'connected' : 'disconnected',
      error: denied ? 'Akses ditolak di halaman Google.' : `Google: ${r.data?.error_description || err || `HTTP ${r.status}`}`,
    });
    return denied ? 'denied' : 'expired';
  }
  if (!r.data.refresh_token) {
    saveConnection(PROVIDER, { status: f.wasConnected ? 'connected' : 'disconnected', error: 'Google tidak memberi refresh token. Hapus akses aplikasi di akun Google lalu hubungkan lagi.' });
    return 'denied';
  }
  access = { token: r.data.access_token, exp: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 };
  const before = getConnection(PROVIDER)?.account || null;
  patchSecret(PROVIDER, { refresh_token: r.data.refresh_token });
  saveConnection(PROVIDER, { status: 'connected', error: null });
  try {
    const me = await about();
    const account = me?.user?.emailAddress || me?.user?.displayName || null;
    // Another Google account: the folders the app made belong to the old one.
    if (before && account && before !== account) forgetFolders();
    saveConnection(PROVIDER, { account });
  } catch {}
  return 'connected';
}

export async function disconnect() {
  stopDeviceFlow();
  const { refresh_token } = connectionSecret(PROVIDER);
  if (refresh_token) {
    // Best effort: also revoke at Google so the app disappears from the account's third-party access list.
    await oauthPost('/revoke', { token: refresh_token }).catch(() => {});
  }
  access = null;
  const sec = connectionSecret(PROVIDER);
  delete sec.refresh_token;
  saveConnection(PROVIDER, { status: 'disconnected', secret: sec, account: null, error: null });
}

/** For tests: forget cached tokens and any pending flow. */
export function resetGoogleState() {
  stopDeviceFlow();
  access = null;
}

// ---------------- Drive ----------------
export const about = (signal) => gapi('GET', '/drive/v3/about', { query: { fields: 'user(emailAddress,displayName)' }, signal });

const FILE_FIELDS = 'id,name,mimeType,webViewLink,trashed';

async function createFolder(name, parent, signal) {
  return gapi('POST', '/drive/v3/files', {
    query: { fields: 'id,name,webViewLink' },
    json: { name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) },
    signal,
  });
}

/** Folder id for a path under the app's root ("AI Office" / segment / ...), created when missing. */
export async function ensureFolder(segments = [], signal) {
  const path = [ROOT_FOLDER, ...segments.map((s) => String(s).replace(/[\\/]+/g, '-').trim() || '-')];
  const folders = { ...(connectionConfig(PROVIDER).folders || {}) };
  let parent = null;
  for (let i = 0; i < path.length; i++) {
    const key = path.slice(0, i + 1).join('/');
    if (!folders[key]) {
      const f = await createFolder(path[i], parent, signal);
      folders[key] = f.id;
      if (i === 0) patchConfig(PROVIDER, { root_link: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}` });
      patchConfig(PROVIDER, { folders });
    }
    parent = folders[key];
  }
  return parent;
}

/** Forget cached folder ids (e.g. after a folder was deleted in Drive). */
export function forgetFolders() {
  patchConfig(PROVIDER, { folders: {}, root_link: null });
}

function multipart(metadata, html) {
  const boundary = `aioffice${randomToken(12).replace(/[^A-Za-z0-9]/g, '')}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

const viewLink = (f) => f.webViewLink || `https://docs.google.com/document/d/${f.id}/edit`;

/** New Google Doc from Markdown in the given folder. */
export async function createDoc({ title, markdown, folderId, signal }) {
  const { body, contentType } = multipart({ name: title, mimeType: DOC_MIME, parents: [folderId] }, markdownToHtml(markdown, { title }));
  const f = await gapi('POST', '/drive/v3/files', { upload: true, query: { uploadType: 'multipart', fields: FILE_FIELDS }, body, contentType, signal });
  return { id: f.id, url: viewLink(f), name: f.name };
}

/** Replace the content (and title) of a Google Doc made by the app. */
export async function updateDoc({ id, title, markdown, signal }) {
  const { body, contentType } = multipart({ name: title }, markdownToHtml(markdown, { title }));
  const f = await gapi('PATCH', `/drive/v3/files/${encodeURIComponent(id)}`, { upload: true, query: { uploadType: 'multipart', fields: FILE_FIELDS }, body, contentType, signal });
  return { id: f.id, url: viewLink(f), name: f.name };
}

export async function exportText(id, signal) {
  return gapi('GET', `/drive/v3/files/${encodeURIComponent(id)}/export`, { query: { mimeType: 'text/plain' }, text: true, signal });
}

/** Share a file: with one email address, or with anyone who has the link. */
export async function shareFile(id, { email = null, role = 'reader', notify = false } = {}, signal) {
  await gapi('POST', `/drive/v3/files/${encodeURIComponent(id)}/permissions`, {
    query: email ? { sendNotificationEmail: String(Boolean(notify)) } : {},
    json: email ? { role, type: 'user', emailAddress: email } : { role, type: 'anyone' },
    signal,
  });
  const f = await gapi('GET', `/drive/v3/files/${encodeURIComponent(id)}`, { query: { fields: FILE_FIELDS }, signal });
  return { id: f.id, url: viewLink(f) };
}

export async function trashFile(id, signal) {
  await gapi('PATCH', `/drive/v3/files/${encodeURIComponent(id)}`, { query: { fields: 'id,trashed' }, json: { trashed: true }, signal });
}

/** Public view of the connection for the dashboard (no secrets). */
export function googlePublic() {
  const row = getConnection(PROVIDER);
  const cfg = connectionConfig(PROVIDER);
  const sec = connectionSecret(PROVIDER);
  return {
    provider: PROVIDER,
    status: row?.status || 'disconnected',
    account: row?.account || null,
    client_id: cfg.client_id || null,
    has_client_secret: Boolean(sec.client_secret),
    client_secret_hint: row?.secret_hint || null,
    folder_link: cfg.root_link || null,
    error: row?.error || null,
    connected_at: row?.connected_at || null,
    pending: pendingFlow(),
  };
}
