// Websites and code repos (dashboard → Website), owner-initiated publishing, and the private preview of a site.
// The preview serves the repo's files from GitHub under /preview/<token>/<branch or commit>/... without a login (the
// token is the key) and inside a CSP sandbox: the page gets a unique origin, so the site's scripts can never use the
// dashboard session.
import { getArtifact } from '../connections/artifacts.js';
import { isConnected } from '../connections/store.js';
import * as github from '../connections/github.js';
import { getSetting } from '../lib/settings.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { auditReq } from '../lib/audit.js';
import { cleanPath } from '../sites/files.js';
import { listSites, publishSite, isPublishing, siteByPreviewToken, siteMeta, connectedHosts, HOST_LABEL, hostConnector } from '../sites/index.js';
import { idParam, body, httpError } from './schemas.js';

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', pdf: 'application/pdf',
};
const typeOf = (path) => TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';

// Sandboxed: scripts run, but in a unique origin (no cookies, no same-origin access to the dashboard).
const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";

// Short cache: a page loads its CSS/JS/images right after the HTML. Commits never change, branches do.
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map(); // key -> { buf, type, exp }
let cacheBytes = 0;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) {
    cache.delete(key);
    cacheBytes -= e.buf.length;
    return null;
  }
  return e;
}

function cacheSet(key, entry) {
  if (entry.buf.length > CACHE_MAX_BYTES / 4) return;
  const old = cache.get(key);
  if (old) cacheBytes -= old.buf.length;
  cache.set(key, entry);
  cacheBytes += entry.buf.length;
  for (const [k, e] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    cacheBytes -= e.buf.length;
  }
}

export function clearPreviewCache() {
  cache.clear();
  cacheBytes = 0;
}

async function readSiteFile(fullName, ref, path) {
  const key = `${fullName}@${ref}:${path}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const tries = [path];
  if (!/\.[A-Za-z0-9]+$/.test(path)) tries.push(`${path}.html`, `${path}/index.html`); // clean URLs (/tentang → tentang.html)
  for (const p of tries) {
    const f = await github.readFile(fullName, p, ref);
    if (f) {
      const entry = { buf: f.buf, type: typeOf(p), exp: Date.now() + (/^[0-9a-f]{40}$/.test(ref) ? 600_000 : 15_000) };
      cacheSet(key, entry);
      return entry;
    }
  }
  return null;
}

const page = (reply, code, text) => reply.code(code).header('Content-Security-Policy', "default-src 'none'").type('text/plain; charset=utf-8').send(text);

export default async function siteRoutes(app) {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 240 });
  app.addHook('onClose', async () => limiter.stop());

  app.get('/api/sites', async () => ({
    items: listSites(),
    hosts: Object.entries(HOST_LABEL).map(([id, label]) => ({ id, label, connected: isConnected(hostConnector(id)) })),
    default_host: getSetting('site_default_host'),
  }));

  // The owner publishes from the dashboard (the owner is the approver): runs in the background, the page polls.
  app.post('/api/sites/:id/publish', {
    schema: { params: idParam, body: body({ host: { type: 'string', enum: Object.keys(HOST_LABEL) } }, ['host']) },
  }, async (req) => {
    const a = getArtifact(req.params.id);
    if (!a || a.provider !== 'github' || a.status === 'trashed') throw httpError('Repo tidak ditemukan', 404);
    const { host } = req.body;
    if (!connectedHosts().includes(host)) throw httpError(`${HOST_LABEL[host]} belum terhubung (Koneksi)`);
    if (isPublishing(a.id, host)) throw httpError(`"${a.title}" sedang diterbitkan ke ${HOST_LABEL[host]}`, 409);
    auditReq(req, 'site_publish', siteMeta(a).full_name, { host }, a.business_id);
    publishSite(a, host, null, { by: 'owner' }).catch((e) => req.log.warn({ err: e.message, site: a.id, host }, 'publish failed'));
    return { started: true, host };
  });

  // ---------------- private preview ----------------
  app.get('/preview/*', async (req, reply) => {
    const hit = limiter.hit(req.ip);
    if (!hit.allowed) return page(reply.header('Retry-After', Math.ceil(hit.retryAfterMs / 1000)), 429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
    const raw = req.url.split('?')[0];
    const m = raw.match(/^\/preview\/([A-Za-z0-9_-]{20,64})\/([A-Za-z0-9._-]{1,100})(\/.*)?$/);
    if (!m) return page(reply, 404, 'Pratinjau tidak ditemukan.');
    const [, token, ref, rest] = m;
    // Relative links (style.css) need the trailing slash.
    if (rest === undefined) return reply.redirect(`${raw}/`, 302);
    const a = siteByPreviewToken(token);
    if (!a) return page(reply, 404, 'Pratinjau tidak ditemukan.');
    if (!isConnected('github')) return page(reply, 503, 'GitHub belum terhubung, jadi pratinjau tidak bisa dibuka.');
    let path;
    try {
      path = decodeURIComponent(rest.slice(1));
      if (!path || path.endsWith('/')) path += 'index.html';
      path = cleanPath(path);
    } catch {
      return page(reply, 404, 'File tidak ditemukan.');
    }
    let f;
    try {
      f = await readSiteFile(siteMeta(a).full_name, ref, path);
    } catch (e) {
      return page(reply, e.status === 413 ? 413 : 502, `Tidak bisa membaca file dari GitHub: ${e.message}`);
    }
    if (!f) return page(reply, 404, `File ${path} tidak ada di repo ini.`);
    reply.header('Content-Security-Policy', PREVIEW_CSP);
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Cache-Control', 'no-store');
    return reply.type(f.type).send(f.buf);
  });
}
