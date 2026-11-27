import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { windows } from './quota.js';

const hash = (t) => createHash('sha256').update(t).digest('hex');

/** Per-user tokens (stored hashed) and daily usage counters. */
export class UsageStore {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tokens (
        user_id INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage (
        user_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
      );
      CREATE TABLE IF NOT EXISTS policy (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** Admin overrides of the settings in policy.js: [{ key, value, updatedAt }]. */
  policyOverrides() {
    return this.db.prepare('SELECT key, value, updated_at FROM policy').all().map((r) => ({ key: r.key, value: Number(r.value), updatedAt: r.updated_at }));
  }
  setPolicy(key, value, now = Date.now()) {
    this.db.prepare('INSERT INTO policy (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, now);
  }
  deletePolicy(key) {
    this.db.prepare('DELETE FROM policy WHERE key = ?').run(key);
  }

  /** Issue a fresh token for the user, invalidating any previous one. The plaintext is returned once. */
  issueToken(userId, now = Date.now()) {
    const token = `dshu_${randomBytes(32).toString('base64url')}`;
    this.db
      .prepare(
        `INSERT INTO tokens (user_id, token_hash, created_at, revoked_at) VALUES (?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, revoked_at = NULL`,
      )
      .run(userId, hash(token), now);
    return token;
  }
  revoke(userId, now = Date.now()) {
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
  }
  userByToken(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT user_id FROM tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token));
    return row ? Number(row.user_id) : null;
  }

  record(userId, { input = 0, output = 0 }, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO usage (user_id, day, input_tokens, output_tokens, requests) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(user_id, day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens, requests = requests + 1`,
      )
      .run(userId, windows(now).day, input, output);
  }

  /** Tokens (input + output) used by one user today and this month (UTC). */
  used(userId, now = Date.now()) {
    const w = windows(now);
    const sum = (where, arg) =>
      Number(
        this.db
          .prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM usage WHERE user_id = ? AND ${where}`)
          .get(userId, arg).n,
      );
    return { day: sum('day = ?', w.day), month: sum('day LIKE ?', `${w.month}-%`) };
  }

  /** Tokens (input + output) used by every user today (UTC). */
  usedAllToday(now = Date.now()) {
    return Number(
      this.db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM usage WHERE day = ?').get(windows(now).day).n,
    );
  }

  /**
   * Tokens, requests and distinct users per UTC day for the last `days` days ending today, oldest first, with a zero entry for a
   * day nobody used (the admin overview charts it). Never more than 90 days.
   */
  dailySeries(days = 14, now = Date.now()) {
    const n = Math.min(90, Math.max(1, Math.trunc(days) || 14));
    const dayOf = (offset) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
    const rows = new Map(
      this.db
        .prepare('SELECT day, SUM(input_tokens + output_tokens) AS tokens, SUM(requests) AS requests, COUNT(DISTINCT user_id) AS users FROM usage WHERE day >= ? GROUP BY day')
        .all(dayOf(n - 1))
        .map((r) => [r.day, { tokens: Number(r.tokens), requests: Number(r.requests), users: Number(r.users) }]),
    );
    return Array.from({ length: n }, (_, i) => dayOf(n - 1 - i)).map((day) => ({ day, ...(rows.get(day) ?? { tokens: 0, requests: 0, users: 0 }) }));
  }

  /** Per-user totals for scripts/usage.sh. */
  allUsed(now = Date.now()) {
    const ids = this.db.prepare('SELECT user_id FROM tokens UNION SELECT user_id FROM usage ORDER BY user_id').all();
    return ids.map((r) => ({ userId: Number(r.user_id), ...this.used(Number(r.user_id), now) }));
  }
}
