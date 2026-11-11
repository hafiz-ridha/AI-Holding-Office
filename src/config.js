// Central configuration from environment variables.
// Secrets live in env (or a generated file in the data volume as fallback), never in the DB as plaintext.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const dataDir = path.resolve(env.DATA_DIR || './data');

export const config = {
  env: env.NODE_ENV || 'development',
  host: env.HOST || '0.0.0.0',
  port: int(env.PORT, 3000),
  dataDir,
  dbPath: path.resolve(env.DB_PATH || path.join(dataDir, 'office.db')),
  backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')),
  appUrl: env.APP_URL || '',
  appName: env.APP_NAME || 'AI Virtual Office',
  trustProxy: env.TRUST_PROXY || 'loopback,uniquelocal',
  cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(), // auto | true | false
  adminUsername: env.ADMIN_USERNAME || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  logLevel: env.LOG_LEVEL || 'info',
  defaultTimezone: env.TZ_DEFAULT || 'Asia/Jakarta',
  telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
  // Pause before each part of a split report ("typing…"); 0 = no pause (tests).
  telegramTypingScale: Number(env.TELEGRAM_TYPING_SCALE ?? 1),
  // Web research for the AI (no API key): Google News RSS, Google Trends RSS, Wikipedia API, DuckDuckGo HTML search.
  // The URLs can be overridden (tests use a local stand-in); WEB_ALLOW_PRIVATE is for tests only.
  webNewsRss: env.WEB_NEWS_RSS_URL || 'https://news.google.com/rss/search',
  webSearchUrl: env.WEB_SEARCH_URL || 'https://html.duckduckgo.com/html/',
  webTrendsRss: env.WEB_TRENDS_RSS_URL || 'https://trends.google.com/trending/rss',
  webWikiApi: env.WEB_WIKI_API_URL || 'https://id.wikipedia.org/w/api.php',
  webAllowPrivate: bool(env.WEB_ALLOW_PRIVATE, false),
  // Google (Drive connection, OAuth device flow). Overridable for tests (local stand-ins).
  googleOAuthBase: (env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com').replace(/\/+$/, ''),
  googleApiBase: (env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, ''),
  disableBackgroundJobs: bool(env.DISABLE_BACKGROUND_JOBS, false),
  queueIntervalMs: int(env.QUEUE_INTERVAL_MS, 5000),
  apiRateLimitPerMin: int(env.API_RATE_LIMIT_PER_MIN, 300),
  schedulerIntervalMs: int(env.SCHEDULER_INTERVAL_MS, 30000),
  appSecret: '',
};

// APP_SECRET encrypts provider API keys and the Telegram bot token.
// Prefer env; fall back to a generated file inside the data volume (with a warning).
// Fail fast with an actionable message when the data volume is not writable (common with bind mounts).
export function assertDataDirWritable() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
    throw new Error(
      `Folder data "${config.dataDir}" tidak dapat ditulis oleh proses (uid ${uid}). ` +
        'Di host jalankan: chown -R 1000:1000 ./data  (user "node" di container ber-uid 1000).'
    );
  }
}

export function loadAppSecret(log = console) {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) {
    config.appSecret = env.APP_SECRET;
    return { source: 'env' };
  }
  if (env.APP_SECRET && env.APP_SECRET.length < 32) {
    throw new Error('APP_SECRET harus minimal 32 karakter.');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, '.app_secret');
  if (fs.existsSync(file)) {
    config.appSecret = fs.readFileSync(file, 'utf8').trim();
  } else {
    config.appSecret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, config.appSecret, { mode: 0o600 });
  }
  log.warn?.(
    'APP_SECRET tidak diset di environment. Memakai secret yang dibuat otomatis di data/.app_secret. ' +
      'Simpan nilainya di tempat aman; tanpa secret ini API key terenkripsi tidak dapat dibaca.'
  );
  return { source: 'file' };
}
