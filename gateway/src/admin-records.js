import { parseSpan } from './audit.js';
import { normalizeEmail } from './auth.js';

/**
 * The admin pages for invites, feedback and the audit log (P5-14). What an admin sees: invite status (never a stored code: only
 * hashes exist, and a new code is shown once, at creation), the feedback people sent to us, and audit rows, which are counts and
 * identifiers and never content. Every change is audited with the acting admin; exporting the audit log is itself audited.
 */
const NOTE_MAX = 100;
const MAX_PER_REQUEST = 20;

const ids = (s) => (/^\d{1,9}$/.test(String(s ?? '')) ? Number(s) : null);

/** Audit filters from a query string, the same ones the command line takes. Returns { ok, filters } or { ok: false, message }. */
export function parseAuditFilters(query, now = Date.now()) {
  const f = {};
  const user = query.get('user');
  if (user) {
    const id = ids(user);
    if (id === null) return { ok: false, message: 'The user must be an account number.' };
    f.userId = id;
  }
  const event = (query.get('event') ?? '').trim();
  if (event) {
    if (!/^[a-z0-9_.:*-]{1,60}$/.test(event)) return { ok: false, message: 'The event may only hold letters, digits and . _ : * -' };
    f.event = event;
  }
  const since = (query.get('since') ?? '').trim();
  if (since && since !== 'all') {
    const span = parseSpan(since);
    if (!span) return { ok: false, message: 'Since must look like 90m, 24h or 7d.' };
    f.since = now - span;
  }
  return { ok: true, filters: f, echo: { user: query.get('user') || undefined, event: event || undefined, since: since || undefined } };
}

/** One CSV cell: quoted when it needs to be, and defused when a spreadsheet would run it as a formula. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createRecordsApi({ store, cfg, audit, mail = null, now = () => Date.now() }) {
  const invites = {
    list: () => ({ invites: store.listInvites(now()).reverse(), signupUrl: new URL('gw/signup', cfg.publicUrl).href, mailEnabled: Boolean(mail?.enabled) }),

    /** Create invites; the codes are in this answer and nowhere else. */
    create({ note, days, count, email, admin, ip }) {
      const n = count === undefined ? 1 : Number(count);
      const d = days === undefined || days === '' ? 0 : Number(days);
      const text = typeof note === 'string' ? note.trim() : '';
      if (!Number.isInteger(n) || n < 1 || n > MAX_PER_REQUEST) return { status: 400, json: { error: 'bad_count', message: `Create between 1 and ${MAX_PER_REQUEST} invites at a time.` } };
      if (!Number.isInteger(d) || d < 0 || d > 365) return { status: 400, json: { error: 'bad_days', message: 'Days until it expires must be 0 (never) to 365.' } };
      if (text.length > NOTE_MAX) return { status: 400, json: { error: 'bad_note', message: `The note can be at most ${NOTE_MAX} characters.` } };
      // With an address, the one invite is also mailed. Checked before anything is created, so a refusal leaves no stray invite.
      const to = email === undefined || email === '' ? null : normalizeEmail(email);
      if (email !== undefined && email !== '' && !to) return { status: 400, json: { error: 'bad_email', message: 'That email address does not look right.' } };
      if (to && n !== 1) return { status: 400, json: { error: 'bad_count', message: 'An invite is mailed to one address at a time.' } };
      if (to && !mail?.enabled) return { status: 400, json: { error: 'mail_off', message: 'Email is not set up on this server (MAIL_PROVIDER), so the invite cannot be mailed. Create it without an address and copy the link.' } };
      const base = new URL('gw/signup', cfg.publicUrl).href;
      const codes = Array.from({ length: n }, () => store.createInvite({ note: text, ttlDays: d, createdBy: admin.id }, now()));
      const emailed = to ? mail.invite({ email: to, code: codes[0], days: d }) : null;
      audit.record('admin.invite_create', { ip, by: admin.id, count: n, note: text, days: d, via: 'panel', emailed: emailed ? emailed.queued : undefined });
      return { status: 201, json: { emailed, created: codes.map((code) => ({ code, link: `${base}?invite=${encodeURIComponent(code)}` })), ...invites.list() } };
    },

    revoke({ ref, admin, ip }) {
      const result = store.revokeInvite(ref);
      if (result === null) return { status: 404, json: { error: 'not_found' } };
      if (result === 'used') return { status: 409, json: { error: 'used', message: 'That invite was already used. The account it created is managed on the Users page.' } };
      if (result === 'revoked') audit.record('admin.invite_revoke', { ip, by: admin.id, ref, via: 'panel' });
      return { status: 200, json: invites.list() };
    },
  };

  const feedback = {
    list({ status, page }) {
      const limit = 20;
      const offset = Math.max(0, (Number.parseInt(page, 10) || 1) - 1) * limit;
      const { rows, total } = store.listFeedback({ unreadOnly: status !== 'all', limit, offset });
      return { rows, total, page: offset / limit + 1, pageSize: limit, counts: store.feedbackCounts(), status: status === 'all' ? 'all' : 'unread' };
    },
    mark({ id, read, admin, ip }) {
      if (typeof read !== 'boolean') return { status: 400, json: { error: 'bad_request', message: 'Say whether it is read: true or false.' } };
      if (!store.markFeedback(id, read, now())) return { status: 404, json: { error: 'not_found' } };
      audit.record('admin.feedback_mark', { ip, by: admin.id, feedbackId: id, read });
      return { status: 200, json: { counts: store.feedbackCounts() } };
    },
  };

  const auditLog = {
    /** A page of audit rows, newest first; `before` is the id of the last row of the previous page. */
    search(query) {
      const parsed = parseAuditFilters(query, now());
      if (!parsed.ok) return { status: 400, json: { error: 'bad_filter', message: parsed.message } };
      const limit = Math.min(200, Math.max(1, Number.parseInt(query.get('limit') ?? '50', 10) || 50));
      const before = ids(query.get('before'));
      const rows = store.queryAudit({ ...parsed.filters, limit: limit + 1, ...(before !== null ? { beforeId: before } : {}) });
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      return { status: 200, json: { rows: page.map((r) => ({ id: r.id, ts: new Date(r.ts).toISOString(), event: r.event, userId: r.userId, ip: r.ip, detail: r.detail })), next: more ? page.at(-1).id : null, limit } };
    },
    /** The same filters as a CSV file, up to 5000 rows. Exporting is itself an audit row. */
    export(query, { admin, ip }) {
      const parsed = parseAuditFilters(query, now());
      if (!parsed.ok) return { status: 400, json: { error: 'bad_filter', message: parsed.message } };
      const rows = store.queryAudit({ ...parsed.filters, limit: 5000, maxLimit: 5000 });
      const lines = ['id,time,event,user,ip,detail', ...rows.map((r) => [r.id, new Date(r.ts).toISOString(), r.event, r.userId, r.ip, JSON.stringify(r.detail)].map(csvCell).join(','))];
      audit.record('admin.audit_export', { ip, by: admin.id, rows: rows.length, ...parsed.echo });
      return { raw: { type: 'text/csv; charset=utf-8', filename: `audit-${new Date(now()).toISOString().slice(0, 10)}.csv`, body: `${lines.join('\r\n')}\r\n` } };
    },
  };

  /** The waitlist (docs/email.md): who asked, who confirmed their address, and inviting someone by email. */
  const waitlist = {
    list: () => ({ entries: store.listWaitlist(), mailEnabled: Boolean(mail?.enabled) }),

    /** Create one invite for a confirmed entry and mail it. The entry is marked invited only when the message was accepted for sending. */
    invite({ email, days, admin, ip }) {
      const to = normalizeEmail(email);
      const entry = to ? store.waitlistEntry(to) : null;
      const d = days === undefined || days === '' ? 7 : Number(days);
      if (!entry) return { status: 404, json: { error: 'not_found', message: 'That address is not on the waitlist.' } };
      if (!Number.isInteger(d) || d < 0 || d > 365) return { status: 400, json: { error: 'bad_days', message: 'Days until it expires must be 0 (never) to 365.' } };
      if (!mail?.enabled) return { status: 400, json: { error: 'mail_off', message: 'Email is not set up on this server (MAIL_PROVIDER), so the invite cannot be mailed.' } };
      if (!entry.confirmedAt) return { status: 409, json: { error: 'not_confirmed', message: 'They have not confirmed their address yet, so no invitation is sent to it.' } };
      const code = store.createInvite({ note: 'waitlist', ttlDays: d, createdBy: admin.id }, now());
      const sent = mail.invite({ email: to, code, days: d });
      if (sent.queued) store.markWaitlistInvited(to, now());
      audit.record('admin.waitlist_invite', { ip, by: admin.id, days: d, queued: sent.queued, reason: sent.reason });
      return { status: 200, json: { sent, ...waitlist.list() } };
    },

    remove({ email, admin, ip }) {
      const to = normalizeEmail(email);
      if (!to || !store.removeFromWaitlist(to)) return { status: 404, json: { error: 'not_found', message: 'That address is not on the waitlist.' } };
      audit.record('admin.waitlist_remove', { ip, by: admin.id });
      return { status: 200, json: waitlist.list() };
    },
  };
  return { invites, feedback, audit: auditLog, ids, waitlist };
}
