import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 10;

export function normalizeEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const DUMMY = hashPassword('dummy-password-for-timing');

/** Pass stored=undefined for unknown users so timing does not reveal account existence. */
export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored ?? DUMMY).split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return stored !== undefined && stored !== null && timingSafeEqual(actual, expected);
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Sliding-window failure limiter keyed by string. */
export class RateLimiter {
  constructor(max, windowMs, now = () => Date.now()) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  #prune(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
  blocked(key) {
    return this.#prune(key).length >= this.max;
  }
  fail(key) {
    const list = this.#prune(key);
    list.push(this.now());
    this.hits.set(key, list);
  }
  reset(key) {
    this.hits.delete(key);
  }
}
