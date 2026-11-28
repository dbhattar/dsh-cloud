import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Printable ASCII only, and none of the characters that separate or decorate addresses in a mail header or an API field (comma,
// semicolon, angle and round and square brackets, backslash, quotes): the address is later handed to the mail provider as the
// recipient, where "a,b@c.d" would mean two recipients.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'; // a domain label starts and ends with a letter or digit
const EMAIL_RE = new RegExp(`^[A-Za-z0-9!#$%&'*+/=?^_\`{|}~.-]+@(?:${LABEL}\\.)+${LABEL}$`);
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

/**
 * Hashing is the most expensive thing an anonymous caller can ask for, so it runs off the main thread (libuv's pool) and through a
 * gate: at most `maxActive` at once, at most `maxQueue` waiting, and anyone past that is refused at once with BusyError (a 503) instead
 * of piling up. Before this it ran synchronously on the one thread that serves every user, so a handful of logins a second froze the
 * gateway (docs/security-review.md, SEC-06). Two at a time leaves the rest of the thread pool (DNS, files) free.
 */
export class BusyError extends Error {}

export class Gate {
  constructor(maxActive, maxQueue) {
    this.maxActive = maxActive;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.waiting = [];
  }
  async run(fn) {
    if (this.active >= this.maxActive) {
      if (this.waiting.length >= this.maxQueue) throw new BusyError('hashing queue is full');
      await new Promise((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot straight on
      else this.active--;
    }
  }
}

export const hashGate = new Gate(2, 50);

/** Same format and cost as hashPassword, computed off the main thread. Throws BusyError when the queue is full. */
export function hashPasswordAsync(password, gate = hashGate) {
  return gate.run(async () => {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 32);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
  });
}

/** Same checks as verifyPassword (a missing user costs the same as a real one), off the main thread. */
export function verifyPasswordAsync(password, stored, gate = hashGate) {
  return gate.run(async () => {
    const [alg, saltB64, hashB64] = String(stored ?? DUMMY).split('$');
    if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
    return stored !== undefined && stored !== null && timingSafeEqual(actual, expected);
  });
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
  /** `maxKeys` bounds memory: past it the oldest key is forgotten to make room, so minting keys cannot grow the map for ever. */
  constructor(max, windowMs, now = () => Date.now(), maxKeys = 20000) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.hits = new Map();
    this.noted = new Map();
  }
  /** Forget keys whose hits have all expired. Called on a timer: #prune only ever looked at the key being asked about. */
  sweep() {
    for (const key of [...this.hits.keys()]) this.#prune(key);
    const cutoff = this.now() - this.windowMs;
    for (const [key, at] of [...this.noted]) if (at <= cutoff) this.noted.delete(key);
  }
  /** True the first time it is asked about a key in a window, so a flood of refusals is written down once and not once each. */
  firstBlock(key) {
    const at = this.noted.get(key);
    if (at !== undefined && at > this.now() - this.windowMs) return false;
    if (this.noted.size >= this.maxKeys) this.noted.delete(this.noted.keys().next().value);
    this.noted.set(key, this.now());
    return true;
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
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value);
    this.hits.set(key, list);
  }
  reset(key) {
    this.hits.delete(key);
  }
}

/**
 * A path to send the user to after signing in, or null if it is not safe: same-origin paths only (one leading slash, no
 * scheme, no host, no backslash or control characters), and never back into the sign-in pages themselves.
 */
export function safeNext(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  const path = value.split(/[?#]/)[0];
  if (['/gw/login', '/gw/signup', '/gw/logout', '/gw/forgot', '/gw/reset', '/gw/mail/stop', '/gw/waitlist', '/gw/waitlist/confirm'].includes(path)) return null;
  return value;
}
