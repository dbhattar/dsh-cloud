// P5-14: invites, the feedback inbox and audit search with export, behind the admin guard. A real gateway in this process; no Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { csvCell, parseAuditFilters } from '../../gateway/src/admin-records.js';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const CLI = fileURLToPath(new URL('../../gateway/src/cli.js', import.meta.url));
const PW = 'a-long-password-1';

async function world() {
  const store = new Store(':memory:');
  const admin = store.createUser('admin@example.com', hashPassword(PW));
  const alice = store.createUser('alice@example.com', hashPassword(PW));
  store.setAdmin('admin@example.com', true);
  const cfg = loadConfig(base); // sign-up needs an invite
  const manager = new SandboxManager({ runner: { diskUsage: async () => [], list: async () => [], info: async () => null }, cfg, log: () => {} });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cookie = `gw_session=${store.createSession(admin, 600)}`;
  const raw = (method, path, { headers = {}, body, auth = true } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const h = { ...(auth ? { cookie } : {}), ...(data && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers };
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: h }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(data);
    });
  const page = await raw('GET', '/gw/admin');
  const csrf = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(page.text)[1]).csrf;
  const get = (path) => raw('GET', path);
  const post = (path, body = {}) => raw('POST', path, { headers: { 'x-csrf-token': csrf, origin: 'https://localhost' }, body });
  const signup = (email, invite) => raw('POST', '/gw/signup', { auth: false, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost' }, body: new URLSearchParams({ email, password: PW, invite }).toString() });
  return { store, ids: { admin, alice }, get, post, raw, signup, close: () => { server.closeAllConnections(); server.close(); } };
}

// ---- invites ----
test('store: an invite can be revoked until it is used; revoked is its own status and no longer works', () => {
  const s = new Store(':memory:');
  const code = s.createInvite({ note: 'for bob', ttlDays: 3 }, 1000);
  const [inv] = s.listInvites(2000);
  assert.match(inv.id, /^[0-9a-f]{12}$/);
  assert.equal(inv.status, 'valid');
  assert.ok(!JSON.stringify(inv).includes(code), 'the list never holds the code');
  assert.equal(s.revokeInvite(inv.id, 3000), 'revoked');
  assert.equal(s.inviteStatus(code, 4000), 'revoked');
  assert.equal(s.inviteValid(code, 4000), false);
  assert.equal(s.createUserWithInvite('b@example.com', 'x', code, 4000), null, 'a revoked code creates nothing');
  assert.equal(s.revokeInvite(inv.id, 5000), 'already');
  assert.equal(s.listInvites(6000)[0].revokedAt, 3000);
  const used = s.createInvite({}, 1000);
  const uid = s.createUserWithInvite('c@example.com', 'x', used, 2000);
  const usedRow = s.listInvites(3000).find((i) => i.usedBy === uid);
  assert.equal(usedRow.status, 'used');
  assert.equal(usedRow.usedByEmail, 'c@example.com');
  assert.equal(s.revokeInvite(usedRow.id), 'used', 'a used invite cannot be revoked');
  for (const bad of [undefined, '', 'zz', 'ABCDEF123456', 'aaaaaaaaaaaa', '0123456789abcdef']) assert.equal(s.revokeInvite(bad), null, String(bad));
  assert.equal(s.inviteStatus(s.createInvite({ ttlDays: 1 }, 0), 2 * 86400000), 'expired');
});

test('migration: an older database gets the new columns and keeps its invites and feedback', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'old-db-')), 'gateway.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO users (email, pw_hash, created_at) VALUES ('a@example.com', 'x', 1);
    CREATE TABLE invites (code_hash TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER, used_by INTEGER, used_at INTEGER);
    INSERT INTO invites (code_hash, note, created_at) VALUES ('0123456789abcdef', 'old', 5);
    CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, context TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO feedback (user_id, kind, message, context, created_at) VALUES (1, 'bug', 'old message', '{}', 9);`);
  old.close();
  const s = new Store(file);
  assert.equal(s.listInvites()[0].note, 'old');
  assert.equal(s.listInvites()[0].status, 'valid');
  assert.deepEqual(s.feedbackCounts(), { total: 1, unread: 1 }, 'old feedback counts as unread');
  assert.equal(new Store(file).listInvites().length, 1, 'opening it again is harmless');
});

test('create: codes come back once with links, the list never shows them, the audit row has no code, and the code works for sign-up', async () => {
  const w = await world();
  try {
    const r = await w.post('/gw/admin/api/invites', { note: '  for the team  ', days: 7, count: 2 });
    assert.equal(r.status, 201);
    const out = r.json();
    assert.equal(out.created.length, 2);
    for (const c of out.created) {
      assert.match(c.code, /^inv_[\w-]{16}$/);
      assert.equal(c.link, `https://localhost/gw/signup?invite=${c.code}`);
    }
    assert.equal(out.invites.length, 2);
    assert.ok(out.invites.every((i) => i.status === 'valid' && i.note === 'for the team' && i.createdBy === w.ids.admin && i.expiresAt > Date.now()));
    const listed = (await w.get('/gw/admin/api/invites')).text;
    for (const c of out.created) assert.ok(!listed.includes(c.code), 'a later list does not hold the code');
    const row = w.store.queryAudit({ event: 'admin.invite_create' })[0];
    assert.deepEqual([row.detail.count, row.detail.note, row.detail.by, row.detail.via], [2, 'for the team', w.ids.admin, 'panel']);
    for (const c of out.created) assert.ok(!JSON.stringify(row).includes(c.code), 'the audit row never holds a code');
    const up = await w.signup('bob@example.com', out.created[0].code);
    assert.equal(up.status, 303);
    const after = (await w.get('/gw/admin/api/invites')).json().invites;
    assert.equal(after.filter((i) => i.status === 'used').length, 1);
    assert.equal(after.find((i) => i.status === 'used').usedByEmail, 'bob@example.com');
  } finally { w.close(); }
});

test('create: bad counts, days and notes are refused and nothing is created', async () => {
  const w = await world();
  try {
    for (const body of [{ count: 0 }, { count: 21 }, { count: 'x' }, { count: 1.5 }, { days: -1 }, { days: 366 }, { days: 'soon' }, { note: 'x'.repeat(101) }]) {
      const r = await w.post('/gw/admin/api/invites', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await w.get('/gw/admin/api/invites')).json().invites.length, 0);
    assert.equal((await w.post('/gw/admin/api/invites', {})).status, 201, 'the defaults: one invite, no expiry, no note');
    assert.equal(w.store.listInvites()[0].expiresAt, null);
  } finally { w.close(); }
});

test('revoke: the invite stops working with its own message; used and unknown ones are refused; twice is harmless and audited once', async () => {
  const w = await world();
  try {
    const { created, invites } = (await w.post('/gw/admin/api/invites', { count: 2 })).json();
    const [a, b] = created;
    const ids = invites.map((i) => i.id);
    await w.signup('used@example.com', b.code);
    const usedId = w.store.listInvites().find((i) => i.status === 'used').id;
    const freeId = ids.find((id) => id !== usedId);
    assert.equal((await w.post(`/gw/admin/api/invites/${usedId}/revoke`)).status, 409);
    assert.equal((await w.post('/gw/admin/api/invites/aaaaaaaaaaaa/revoke')).status, 404);
    const r = await w.post(`/gw/admin/api/invites/${freeId}/revoke`);
    assert.equal(r.status, 200);
    assert.equal(r.json().invites.find((i) => i.id === freeId).status, 'revoked');
    assert.equal((await w.post(`/gw/admin/api/invites/${freeId}/revoke`)).status, 200);
    assert.equal(w.store.queryAudit({ event: 'admin.invite_revoke' }).length, 1, 'the second revoke changed nothing, so it is not audited again');
    const link = await w.raw('GET', `/gw/signup?invite=${a.code}`, { auth: false });
    assert.match(link.text, /no longer valid/);
    const up = await w.signup('late@example.com', a.code);
    assert.equal(up.status, 400);
    assert.match(up.text, /no longer valid/);
    assert.equal(w.store.userByEmail('late@example.com'), undefined);
  } finally { w.close(); }
});

// ---- feedback ----
test('feedback: unread by default, all on request, marking read and unread, counts, who sent it, and it is audited', async () => {
  const w = await world();
  try {
    w.store.addFeedback(w.ids.alice, 'bug', 'the <b>button</b> is gone', { source: 'x' });
    w.store.addFeedback(w.ids.alice, 'idea', 'add dark mode', {});
    const unread = (await w.get('/gw/admin/api/feedback')).json();
    assert.deepEqual([unread.total, unread.counts, unread.status], [2, { total: 2, unread: 2 }, 'unread']);
    assert.deepEqual(unread.rows.map((f) => [f.kind, f.email]), [['idea', 'alice@example.com'], ['bug', 'alice@example.com']], 'newest first, with who sent it');
    assert.equal(unread.rows[1].message, 'the <b>button</b> is gone', 'returned as text; the page shows it as text');
    const bug = unread.rows[1].id;
    const marked = await w.post(`/gw/admin/api/feedback/${bug}/read`, { read: true });
    assert.deepEqual(marked.json().counts, { total: 2, unread: 1 });
    assert.deepEqual((await w.get('/gw/admin/api/feedback')).json().rows.map((f) => f.kind), ['idea']);
    assert.deepEqual((await w.get('/gw/admin/api/feedback?status=all')).json().rows.map((f) => f.kind), ['idea', 'bug']);
    assert.ok((await w.get('/gw/admin/api/feedback?status=all')).json().rows[1].readAt > 0);
    assert.deepEqual((await w.post(`/gw/admin/api/feedback/${bug}/read`, { read: false })).json().counts, { total: 2, unread: 2 });
    assert.equal((await w.post(`/gw/admin/api/feedback/${bug}/read`, {})).status, 400);
    assert.equal((await w.post(`/gw/admin/api/feedback/${bug}/read`, { read: 'yes' })).status, 400);
    assert.equal((await w.post('/gw/admin/api/feedback/999/read', { read: true })).status, 404);
    const rows = w.store.queryAudit({ event: 'admin.feedback_mark' });
    assert.deepEqual(rows.map((r) => [r.detail.feedbackId, r.detail.read, r.detail.by]), [[bug, false, w.ids.admin], [bug, true, w.ids.admin]]);
    assert.ok(!JSON.stringify(rows).includes('button'), 'the audit row holds no feedback text');
  } finally { w.close(); }
});

// ---- audit search and export ----
test('audit filters: user, event (exact or prefix), since; bad input says so', () => {
  const q = (s) => parseAuditFilters(new URLSearchParams(s), 1_000_000);
  assert.deepEqual(q('user=5&event=sandbox.&since=1h').filters, { userId: 5, event: 'sandbox.', since: 1_000_000 - 3_600_000 });
  assert.deepEqual(q('since=all').filters, {});
  assert.deepEqual(q('').filters, {});
  for (const bad of ['user=abc', 'user=1;2', 'event=a b', 'event=%27%3B', 'event=' + 'x'.repeat(61), 'since=yesterday', 'since=7']) assert.equal(q(bad).ok, false, bad);
});

test('audit search: filters, newest first, and pages by the last id with no gaps or repeats', async () => {
  const w = await world();
  try {
    for (let i = 0; i < 7; i++) w.store.addAudit({ ts: 1000 + i, event: i % 2 ? 'login.ok' : 'sandbox.start', userId: i % 3 === 0 ? w.ids.alice : w.ids.admin, ip: `10.0.0.${i}`, detail: { n: i } });
    const all = [];
    let before = '';
    for (let page = 0; page < 10; page++) {
      const r = (await w.get(`/gw/admin/api/audit/search?since=all&limit=3${before}`)).json();
      all.push(...r.rows);
      if (r.next === null) break;
      before = `&before=${r.next}`;
    }
    const ids = all.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'no repeats');
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
    assert.ok(all.filter((r) => r.event === 'sandbox.start' || r.event === 'login.ok').length === 7, 'every row appears once');
    const user = (await w.get(`/gw/admin/api/audit/search?since=all&user=${w.ids.alice}`)).json().rows;
    assert.deepEqual(user.map((r) => r.detail.n).sort(), [0, 3, 6]);
    const ev = (await w.get('/gw/admin/api/audit/search?since=all&event=login.ok')).json().rows;
    assert.ok(ev.length === 3 && ev.every((r) => r.event === 'login.ok'));
    const prefix = (await w.get('/gw/admin/api/audit/search?since=all&event=sandbox.')).json().rows;
    assert.ok(prefix.length === 4 && prefix.every((r) => r.event.startsWith('sandbox.')));
    assert.equal((await w.get('/gw/admin/api/audit/search?since=1h')).json().rows.filter((r) => r.detail.n !== undefined).length, 0, 'rows from 1970 are outside the last hour');
    assert.equal((await w.get('/gw/admin/api/audit/search?user=abc')).status, 400);
    assert.equal((await w.get('/gw/admin/api/audit/search?since=later')).status, 400);
    assert.equal((await w.get('/gw/admin/api/audit/search?since=all&limit=1000')).json().limit, 200, 'at most 200 a page');
  } finally { w.close(); }
});

test('csv: quoting, and anything a spreadsheet would run as a formula is defused', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(7), '7');
  for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tcmd', '=HYPERLINK("http://evil","x")']) assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), evil);
});

test('export: a CSV download with the same filters, formulas defused, and the export itself is audited', async () => {
  const w = await world();
  try {
    w.store.addAudit({ ts: 5000, event: 'login.ok', userId: w.ids.alice, ip: '=HYPERLINK("http://evil.example","x")', detail: { why: 'a,b' } });
    w.store.addAudit({ ts: 6000, event: 'sandbox.start', userId: w.ids.alice, ip: '10.0.0.9', detail: { ms: 4000 } });
    const r = await w.get('/gw/admin/api/audit/export?since=all&event=login.ok');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/csv/);
    assert.match(r.headers['content-disposition'], /^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    const lines = r.text.trim().split('\r\n');
    assert.equal(lines[0], 'id,time,event,user,ip,detail');
    assert.equal(lines.length, 2, 'only the filtered rows');
    assert.match(lines[1], /,login\.ok,\d+,"?'=HYPERLINK\(/, 'the formula in the address is defused (and quoted, as it holds commas)');
    assert.ok(lines[1].includes('"{""why"":""a,b""}"'), 'details are JSON, quoted');
    const row = w.store.queryAudit({ event: 'admin.audit_export' })[0];
    assert.deepEqual([row.detail.rows, row.detail.event, row.detail.since, row.detail.by], [1, 'login.ok', 'all', w.ids.admin]);
    assert.equal((await w.get('/gw/admin/api/audit/export?user=abc')).status, 400);
    assert.equal(w.store.queryAudit({ event: 'admin.audit_export' }).length, 1, 'a refused export is not an export');
    assert.equal(w.store.queryAudit({ limit: 5000, maxLimit: 5000 }).length >= 3, true);
  } finally { w.close(); }
});

// ---- command line ----
function cli(dir, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, PUBLIC_URL: 'https://localhost/' } });
}

test('command line: invite list shows the id and status, and revoke uses the same id as the panel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-cli-'));
  const s = new Store(join(dir, 'gateway.db'));
  s.createInvite({ note: 'one' });
  const id = s.listInvites()[0].id;
  assert.match(cli(dir, 'invite', 'list').stdout, new RegExp(`^${id}  unused`));
  assert.match(cli(dir, 'invite', 'revoke', id).stdout, /^revoked/);
  assert.match(cli(dir, 'invite', 'list').stdout, new RegExp(`^${id}  revoked`));
  assert.match(cli(dir, 'invite', 'revoke', id).stdout, /already revoked/);
  const unknown = cli(dir, 'invite', 'revoke', 'nope');
  assert.equal(unknown.status, 1);
  assert.deepEqual(new Store(join(dir, 'gateway.db')).queryAudit({ event: 'admin.invite_revoke' }).map((r) => r.detail.via), ['cli']);
});
