import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashToken, newSessionToken } from './auth.js';

const accountRow = (r) => ({ id: Number(r.id), email: r.email, createdAt: r.created_at, isAdmin: r.is_admin === 1, suspendedAt: r.suspended_at ?? null, lastActive: r.last_active ?? null });

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
    // Columns added after the first release: add them to databases that predate them.
    const columns = this.db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!columns.includes('welcomed_at')) this.db.exec('ALTER TABLE users ADD COLUMN welcomed_at INTEGER');
    if (!columns.includes('is_admin')) this.db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    const inviteColumns = this.db.prepare('PRAGMA table_info(invites)').all().map((c) => c.name);
    if (!inviteColumns.includes('revoked_at')) this.db.exec('ALTER TABLE invites ADD COLUMN revoked_at INTEGER');
    if (!inviteColumns.includes('created_by')) this.db.exec('ALTER TABLE invites ADD COLUMN created_by INTEGER');
    const feedbackColumns = this.db.prepare('PRAGMA table_info(feedback)').all().map((c) => c.name);
    if (!feedbackColumns.includes('read_at')) this.db.exec('ALTER TABLE feedback ADD COLUMN read_at INTEGER');
    if (!columns.includes('suspended_at')) this.db.exec('ALTER TABLE users ADD COLUMN suspended_at INTEGER');
  }
  addAudit({ ts = Date.now(), event, userId = null, ip = null, detail = {} }) {
    this.db.prepare('INSERT INTO audit (ts, event, user_id, ip, detail) VALUES (?, ?, ?, ?, ?)').run(ts, event, userId, ip, JSON.stringify(detail));
  }
  /** Newest first. `event` matches exactly, or as a prefix when it ends in "." or "*" ("sandbox." / "login*"). */
  queryAudit({ userId, event, since, limit = 100, beforeId, maxLimit = 1000 } = {}) {
    const where = [];
    const args = [];
    if (beforeId !== undefined) (where.push('id < ?'), args.push(beforeId));
    if (userId !== undefined) (where.push('user_id = ?'), args.push(userId));
    if (event) {
      const prefix = /[.*]$/.test(event);
      where.push(prefix ? 'event LIKE ?' : 'event = ?');
      args.push(prefix ? `${event.replace(/\*$/, '')}%` : event);
    }
    if (since) (where.push('ts >= ?'), args.push(since));
    const rows = this.db
      .prepare(`SELECT id, ts, event, user_id, ip, detail FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(maxLimit, Math.max(1, limit)));
    return rows.map((r) => ({ id: Number(r.id), ts: r.ts, event: r.event, userId: r.user_id, ip: r.ip, detail: JSON.parse(r.detail) }));
  }
  // ---- aggregates for the admin overview (counts only; nothing here reads content) ----
  /** { total, admins, newSince(ts) }: accounts and how many were created since each given time. */
  userCounts(since = []) {
    const one = (sql, ...a) => Number(this.db.prepare(sql).get(...a).n);
    return { total: one('SELECT COUNT(*) AS n FROM users'), admins: one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'), created: since.map((t) => one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', t)) };
  }
  /** Email by user id, for naming users in the overview tables. */
  emailsById() {
    return new Map(this.db.prepare('SELECT id, email FROM users').all().map((u) => [Number(u.id), u.email]));
  }
  /** Distinct users with a sign-in, sign-up or sandbox start since `since`: who was active. */
  activeUsers(since) {
    return Number(this.db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM audit WHERE ts >= ? AND user_id IS NOT NULL AND event IN ('login.ok', 'signup.ok', 'sandbox.start')").get(since).n);
  }
  /** Audit rows since `since` counted by event and, where there is one, the reason or "by" in the detail. */
  auditCounts(since) {
    return this.db
      .prepare("SELECT event, COALESCE(json_extract(detail, '$.reason'), json_extract(detail, '$.by')) AS why, COUNT(*) AS n FROM audit WHERE ts >= ? GROUP BY event, why")
      .all(since)
      .map((r) => ({ event: r.event, why: r.why ?? null, n: Number(r.n) }));
  }
  /** Milliseconds to ready of the sandbox starts since `since` (newest first, at most `limit`), with whether the start resumed a stopped one. */
  startTimes(since, limit = 5000) {
    return this.db
      .prepare("SELECT json_extract(detail, '$.ms') AS ms, json_extract(detail, '$.resumed') AS resumed FROM audit WHERE event = 'sandbox.start' AND ts >= ? ORDER BY id DESC LIMIT ?")
      .all(since, limit)
      .filter((r) => Number.isFinite(r.ms))
      .map((r) => ({ ms: Number(r.ms), resumed: r.resumed === 1 || r.resumed === true }));
  }
  purgeAudit(before) {
    this.db.prepare('DELETE FROM audit WHERE ts < ?').run(before);
  }
  /** When the user dismissed the welcome screen (ms), or null if they have not. */
  welcomedAt(userId) {
    return this.db.prepare('SELECT welcomed_at FROM users WHERE id = ?').get(userId)?.welcomed_at ?? null;
  }
  /** Record that the user has seen the welcome screen; the first time wins. */
  markWelcomed(userId, now = Date.now()) {
    this.db.prepare('UPDATE users SET welcomed_at = ? WHERE id = ? AND welcomed_at IS NULL').run(now, userId);
  }
  /** New single-use invite code (stored hashed; the plaintext is returned once). */
  createInvite({ note = '', ttlDays = 0, createdBy = null } = {}, now = Date.now()) {
    const code = `inv_${randomBytes(12).toString('base64url')}`;
    this.db
      .prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(code), note, now, ttlDays > 0 ? now + ttlDays * 86400000 : null, createdBy);
    return code;
  }
  /** 'valid', 'used', 'revoked', 'expired' or 'unknown' (never seen, or empty). Only the hash of a code is stored. */
  inviteStatus(code, now = Date.now()) {
    if (typeof code !== 'string' || !code.trim()) return 'unknown';
    const r = this.db.prepare('SELECT used_by, expires_at, revoked_at FROM invites WHERE code_hash = ?').get(hashToken(code.trim()));
    if (!r) return 'unknown';
    if (r.used_by !== null) return 'used';
    if (r.revoked_at !== null) return 'revoked';
    if (r.expires_at !== null && r.expires_at <= now) return 'expired';
    return 'valid';
  }
  /** True if the code exists, is unused and has not expired. */
  inviteValid(code, now = Date.now()) {
    if (typeof code !== 'string' || !code) return false;
    const r = this.db.prepare('SELECT used_by, expires_at, revoked_at FROM invites WHERE code_hash = ?').get(hashToken(code.trim()));
    return Boolean(r) && r.used_by === null && r.revoked_at === null && (r.expires_at === null || r.expires_at > now);
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
  /**
   * Every invite, oldest first, without the codes (only hashes are stored). `id` is the first 12 characters of the stored hash: it
   * names the invite for revoking and reveals nothing about the code. `status` is valid, used, revoked or expired.
   */
  listInvites(now = Date.now()) {
    return this.db
      .prepare(
        `SELECT i.code_hash, i.note, i.created_at, i.expires_at, i.used_by, i.used_at, i.revoked_at, i.created_by, u.email AS used_by_email
         FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at, i.rowid`,
      )
      .all()
      .map((r) => ({
        id: r.code_hash.slice(0, 12),
        note: r.note,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        usedBy: r.used_by,
        usedByEmail: r.used_by_email ?? null,
        usedAt: r.used_at,
        revokedAt: r.revoked_at,
        createdBy: r.created_by,
        status: r.used_by !== null ? 'used' : r.revoked_at !== null ? 'revoked' : r.expires_at !== null && r.expires_at <= now ? 'expired' : 'valid',
      }));
  }
  /** Revoke an unused invite by its id. Returns 'revoked', 'used', 'already', or null when there is no such invite. */
  revokeInvite(ref, now = Date.now()) {
    if (!/^[0-9a-f]{12}$/.test(ref ?? '')) return null;
    const rows = this.db.prepare("SELECT code_hash, used_by, revoked_at FROM invites WHERE code_hash LIKE ? || '%'").all(ref);
    if (rows.length !== 1) return null;
    const r = rows[0];
    if (r.used_by !== null) return 'used';
    if (r.revoked_at !== null) return 'already';
    this.db.prepare('UPDATE invites SET revoked_at = ? WHERE code_hash = ?').run(now, r.code_hash);
    return 'revoked';
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
        `SELECT u.id, u.email, u.is_admin, u.suspended_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token));
    if (!row) return null;
    if (row.suspended_at !== null) return null; // a suspended account has no working session, even one that somehow survived
    if (row.expires_at < Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return { id: row.id, email: row.email, isAdmin: row.is_admin === 1 };
  }
  /**
   * Grant or take away the admin role. Only the command line calls this (scripts/make-admin.sh): no request can, so taking over
   * a normal account never leads to admin. Returns the user, or null if there is no such account.
   */
  setAdmin(email, isAdmin) {
    const user = this.userByEmail(email);
    if (!user) return null;
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, user.id);
    return { id: user.id, email: user.email, isAdmin: Boolean(isAdmin), changed: (user.is_admin === 1) !== Boolean(isAdmin) };
  }
  listAdmins() {
    return this.db.prepare('SELECT id, email FROM users WHERE is_admin = 1 ORDER BY id').all();
  }
  // ---- accounts, for the admin pages ----
  /**
   * Accounts with when they were last active (sign-in or workspace start), newest sign-up first. `q` matches part of the email
   * (case-insensitive); `limit` is at most 200. Returns { rows, total } where total counts every match.
   */
  listUsers({ q = '', limit = 50, offset = 0 } = {}) {
    const like = `%${String(q).trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const total = Number(this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE ? ESCAPE '\\'").get(like).n);
    const rows = this.db
      .prepare(
        `SELECT u.id, u.email, u.created_at, u.is_admin, u.suspended_at,
           (SELECT MAX(ts) FROM audit a WHERE a.user_id = u.id AND a.event IN ('login.ok', 'signup.ok', 'sandbox.start')) AS last_active
         FROM users u WHERE lower(u.email) LIKE ? ESCAPE '\\' ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      )
      .all(like, Math.min(200, Math.max(1, limit)), Math.max(0, offset))
      .map(accountRow);
    return { rows, total };
  }
  /** One account in the same shape as listUsers, or null. */
  accountById(id) {
    const r = this.db
      .prepare(
        `SELECT u.id, u.email, u.created_at, u.is_admin, u.suspended_at,
           (SELECT MAX(ts) FROM audit a WHERE a.user_id = u.id AND a.event IN ('login.ok', 'signup.ok', 'sandbox.start')) AS last_active
         FROM users u WHERE u.id = ?`,
      )
      .get(id);
    return r ? accountRow(r) : null;
  }
  /** Suspend an account and end every session it has. Returns true if it changed. */
  suspendUser(id, now = Date.now()) {
    const r = this.db.prepare('UPDATE users SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL').run(now, id);
    this.deleteSessionsFor(id);
    return r.changes > 0;
  }
  unsuspendUser(id) {
    return this.db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ? AND suspended_at IS NOT NULL').run(id).changes > 0;
  }
  /** End every session of a user ("sign out everywhere"). Returns how many there were. */
  deleteSessionsFor(userId) {
    return this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
  }
  /** Feedback for the admin inbox, newest first, with who sent it. `unreadOnly` hides what an admin has marked read. */
  listFeedback({ unreadOnly = false, limit = 25, offset = 0 } = {}) {
    const where = unreadOnly ? 'WHERE f.read_at IS NULL' : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM feedback f ${where}`).get().n);
    const rows = this.db
      .prepare(`SELECT f.id, f.user_id, u.email, f.kind, f.message, f.created_at, f.read_at FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`)
      .all(Math.min(100, Math.max(1, limit)), Math.max(0, offset))
      .map((f) => ({ id: Number(f.id), userId: Number(f.user_id), email: f.email ?? null, kind: f.kind, message: f.message, createdAt: f.created_at, readAt: f.read_at ?? null }));
    return { rows, total };
  }
  feedbackCounts() {
    const one = (sql) => Number(this.db.prepare(sql).get().n);
    return { total: one('SELECT COUNT(*) AS n FROM feedback'), unread: one('SELECT COUNT(*) AS n FROM feedback WHERE read_at IS NULL') };
  }
  /** Mark one piece of feedback read or unread. Returns false if there is no such feedback. */
  markFeedback(id, read, now = Date.now()) {
    return this.db.prepare('UPDATE feedback SET read_at = ? WHERE id = ?').run(read ? now : null, id).changes > 0;
  }
  /** What the user sent through the feedback form (they sent it to us), newest first. */
  feedbackFor(userId, limit = 20) {
    return this.db
      .prepare('SELECT id, kind, message, created_at FROM feedback WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit)
      .map((f) => ({ id: Number(f.id), kind: f.kind, message: f.message, createdAt: f.created_at }));
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
