// Password hashing (scrypt), secret encryption (AES-256-GCM), and token helpers. Built-in crypto only.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

let encKey = null;
function key() {
  if (!encKey) {
    if (!config.appSecret) throw new Error('APP_SECRET belum dimuat');
    encKey = crypto.hkdfSync('sha256', config.appSecret, 'ai-virtual-office', 'secret-encryption-v1', 32);
    encKey = Buffer.from(encKey);
  }
  return encKey;
}

export function resetKeyCache() {
  encKey = null;
}

// Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
export function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(enc) {
  if (!enc) return '';
  const [v, ivB64, tagB64, ctB64] = String(enc).split(':');
  if (v !== 'v1') throw new Error('Format secret tidak dikenal');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// Masked representation shown in the dashboard, e.g. "sk-or-…a1b2".
export function maskSecret(plain) {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 8) return '••••';
  const prefix = s.slice(0, Math.min(6, Math.floor(s.length / 4)));
  return `${prefix}…${s.slice(-4)}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
