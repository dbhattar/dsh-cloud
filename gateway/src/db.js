import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashToken, newSessionToken } from './auth.js';

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        pw_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        user_id INTEGER,
        ip TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
      CREATE INDEX IF NOT EXISTS audit_user ON audit (user_id, ts);
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        used_by INTEGER REFERENCES users(id),
        used_at INTEGER
      );
    `);
  }
  addAudit({ ts = Date.now(), event, userId = null, ip = null, detail = {} }) {
    this.db.prepare('INSERT INTO audit (ts, event, user_id, ip, detail) VALUES (?, ?, ?, ?, ?)').run(ts, event, userId, ip, JSON.stringify(detail));
  }
  /** Newest first. `event` matches exactly, or as a prefix when it ends in "." or "*" ("sandbox." / "login*"). */
  queryAudit({ userId, event, since, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (userId !== undefined) (where.push('user_id = ?'), args.push(userId));
    if (event) {
      const prefix = /[.*]$/.test(event);
      where.push(prefix ? 'event LIKE ?' : 'event = ?');
      args.push(prefix ? `${event.replace(/\*$/, '')}%` : event);
    }
    if (since) (where.push('ts >= ?'), args.push(since));
    const rows = this.db
      .prepare(`SELECT ts, event, user_id, ip, detail FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(1000, Math.max(1, limit)));
    return rows.map((r) => ({ ts: r.ts, event: r.event, userId: r.user_id, ip: r.ip, detail: JSON.parse(r.detail) }));
  }
  purgeAudit(before) {
    this.db.prepare('DELETE FROM audit WHERE ts < ?').run(before);
  }
  /** New single-use invite code (stored hashed; the plaintext is returned once). */
  createInvite({ note = '', ttlDays = 0 } = {}, now = Date.now()) {
    const code = `inv_${randomBytes(12).toString('base64url')}`;
    this.db
      .prepare('INSERT INTO invites (code_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(code), note, now, ttlDays > 0 ? now + ttlDays * 86400000 : null);
    return code;
  }
  /** True if the code exists, is unused and has not expired. */
  inviteValid(code, now = Date.now()) {
    if (typeof code !== 'string' || !code) return false;
    const r = this.db.prepare('SELECT used_by, expires_at FROM invites WHERE code_hash = ?').get(hashToken(code.trim()));
    return Boolean(r) && r.used_by === null && (r.expires_at === null || r.expires_at > now);
  }
  /**
   * Create the user and spend the invite in one transaction, so a code works for exactly one account even
   * when two sign-ups race. Returns the new user id, or null if the code is not (or no longer) valid.
   */
  createUserWithInvite(email, pwHash, code, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.inviteValid(code, now)) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const id = this.createUser(email, pwHash);
      this.db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?').run(id, now, hashToken(code.trim()));
      this.db.exec('COMMIT');
      return id;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  /** [{ note, createdAt, expiresAt, usedBy, usedAt }] without the codes (only hashes are stored). */
  listInvites() {
    return this.db.prepare('SELECT note, created_at, expires_at, used_by, used_at FROM invites ORDER BY created_at').all().map((r) => ({
      note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, usedBy: r.used_by, usedAt: r.used_at,
    }));
  }
  createUser(email, pwHash) {
    const r = this.db
      .prepare('INSERT INTO users (email, pw_hash, created_at) VALUES (?, ?, ?)')
      .run(email, pwHash, Date.now());
    return Number(r.lastInsertRowid);
  }
  userByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }
  createSession(userId, ttlSeconds) {
    const token = newSessionToken();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Date.now() + ttlSeconds * 1000);
    return token;
  }
  userBySession(token) {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return { id: row.id, email: row.email };
  }
  deleteSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  addFeedback(userId, kind, message, context) {
    const r = this.db
      .prepare('INSERT INTO feedback (user_id, kind, message, context, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, kind, message, JSON.stringify(context), Date.now());
    return Number(r.lastInsertRowid);
  }
  purgeExpired() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }
}
