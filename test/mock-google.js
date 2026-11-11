// Local stand-in for Google OAuth (device flow, tokens, revoke) and the Drive v3 API (folders, multipart Google Docs
// upload/update, export, permissions, trash, about). Tests point config.googleOAuthBase / googleApiBase here.
import http from 'node:http';

export const CLIENT_ID = '1234567890-testclient.apps.googleusercontent.com';
export const CLIENT_SECRET = 'GOCSPX-test-secret-value';

export async function startMockGoogle() {
  const state = {
    approved: false, // the owner entered the code at google.com/device
    denied: false,
    invalidGrant: false, // refresh token revoked / expired
    failUpload: 0, // number of upload requests that fail with 500
    interval: 3600, // device flow poll interval (s): large, so tests poll by hand
  };
  const files = new Map(); // id -> { id, name, mimeType, parents, html, trashed }
  const permissions = [];
  const calls = [];
  const revoked = [];
  let seq = 0;
  let tokenSeq = 0;
  const valid = new Set();

  const send = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const link = (f) => (f.mimeType === 'application/vnd.google-apps.folder' ? `https://drive.google.com/drive/folders/${f.id}` : `https://docs.google.com/document/d/${f.id}/edit`);
  const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: link(f), trashed: Boolean(f.trashed) });
  const issue = () => {
    const t = `at-${++tokenSeq}`;
    valid.add(t);
    return t;
  };

  function parseMultipart(body, contentType) {
    const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
    const parts = body.split(`--${boundary}`).filter((p) => p.trim() && !p.startsWith('--'));
    const pick = (p) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
    return { metadata: JSON.parse(pick(parts[0])), media: pick(parts[1] || '') };
  }

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || null });

    // ---------------- OAuth ----------------
    if (req.method === 'POST' && ['/device/code', '/token', '/revoke'].includes(path)) {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (path === '/revoke') {
        revoked.push(f.token);
        return send(res, 200, {});
      }
      if (f.client_id !== CLIENT_ID) return send(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
      if (path === '/device/code') {
        if (f.scope !== 'https://www.googleapis.com/auth/drive.file') return send(res, 400, { error: 'invalid_scope' });
        return send(res, 200, { device_code: 'DEV-CODE-1', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: state.interval });
      }
      if (f.client_secret !== CLIENT_SECRET) return send(res, 401, { error: 'invalid_client', error_description: 'Unauthorized' });
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (f.device_code !== 'DEV-CODE-1') return send(res, 400, { error: 'invalid_grant' });
        if (state.denied) return send(res, 403, { error: 'access_denied', error_description: 'Forbidden' });
        if (!state.approved) return send(res, 428, { error: 'authorization_pending', error_description: 'Precondition Required' });
        return send(res, 200, { access_token: issue(), expires_in: 3599, refresh_token: 'RT-SECRET-1', token_type: 'Bearer', scope: f.scope });
      }
      if (f.grant_type === 'refresh_token') {
        if (state.invalidGrant || f.refresh_token !== 'RT-SECRET-1') return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return send(res, 200, { access_token: issue(), expires_in: 3599, token_type: 'Bearer' });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---------------- Drive ----------------
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!valid.has(token)) return send(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });

    if (req.method === 'GET' && path === '/drive/v3/about') return send(res, 200, { user: { emailAddress: 'owner@gmail.com', displayName: 'Owner' } });

    if (req.method === 'POST' && path === '/drive/v3/files') {
      const m = JSON.parse(body || '{}');
      const f = { id: `fo-${++seq}`, name: m.name, mimeType: m.mimeType, parents: m.parents || [], html: null };
      files.set(f.id, f);
      return send(res, 200, meta(f));
    }

    if (path === '/upload/drive/v3/files' && req.method === 'POST') {
      if (state.failUpload > 0) {
        state.failUpload--;
        return send(res, 500, { error: { code: 500, message: 'Backend Error' } });
      }
      const { metadata, media } = parseMultipart(body, req.headers['content-type']);
      if (metadata.parents?.some((p) => !files.has(p))) return send(res, 404, { error: { code: 404, message: 'File not found: parent' } });
      const f = { id: `doc-${++seq}`, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents || [], html: media };
      files.set(f.id, f);
      return send(res, 200, meta(f));
    }

    const up = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (up && req.method === 'PATCH') {
      const f = files.get(decodeURIComponent(up[1]));
      if (!f || f.trashed) return send(res, 404, { error: { code: 404, message: 'File not found' } });
      const { metadata, media } = parseMultipart(body, req.headers['content-type']);
      if (metadata.name) f.name = metadata.name;
      f.html = media;
      return send(res, 200, meta(f));
    }

    const one = path.match(/^\/drive\/v3\/files\/([^/]+)(\/export|\/permissions)?$/);
    if (one) {
      const f = files.get(decodeURIComponent(one[1]));
      if (!f) return send(res, 404, { error: { code: 404, message: 'File not found' } });
      if (one[2] === '/export') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(String(f.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      }
      if (one[2] === '/permissions' && req.method === 'POST') {
        const p = { fileId: f.id, ...JSON.parse(body || '{}'), notify: url.searchParams.get('sendNotificationEmail') };
        permissions.push(p);
        return send(res, 200, { id: `perm-${permissions.length}`, ...p });
      }
      if (req.method === 'PATCH') {
        Object.assign(f, JSON.parse(body || '{}'));
        return send(res, 200, meta(f));
      }
      if (req.method === 'GET') return send(res, 200, meta(f));
    }
    send(res, 404, { error: { code: 404, message: `no route ${req.method} ${path}` } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Folder path of a file: "AI Office/<bisnis>/<sub>".
  const pathOf = (f) => {
    const out = [];
    let p = f.parents?.[0];
    while (p && files.get(p)) {
      out.unshift(files.get(p).name);
      p = files.get(p).parents?.[0];
    }
    return out.join('/');
  };
  return {
    base, state, files, permissions, calls, revoked, pathOf,
    docs: () => [...files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.document'),
    close: () => new Promise((r) => server.close(r)),
  };
}
