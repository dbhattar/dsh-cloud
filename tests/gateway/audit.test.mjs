// E1: audit trail. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Audit, parseSpan } from '../../gateway/src/audit.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };

function setup(extra = {}) {
  const store = new Store(':memory:');
  const logs = [];
  const audit = new Audit({ store, log: (l) => logs.push(l) });
  return { store, logs, audit, cfg: { ...loadConfig({ ...base, ...extra }) } };
}
const events = (store) => store.queryAudit({ limit: 100 }).reverse().map((r) => r.event);

test('Audit.record writes a row and one JSON line; extra fields go to detail', () => {
  const { store, logs, audit } = setup();
  audit.record('login.fail', { userId: 7, ip: '1.2.3.4', reason: 'bad_credentials', email: 'a@b.com' });
  const [row] = store.queryAudit();
  assert.deepEqual({ event: row.event, userId: row.userId, ip: row.ip, detail: row.detail }, { event: 'login.fail', userId: 7, ip: '1.2.3.4', detail: { reason: 'bad_credentials', email: 'a@b.com' } });
  const line = JSON.parse(logs[0].replace(/^audit /, ''));
  assert.equal(line.event, 'login.fail');
  assert.equal(line.userId, 7);
  assert.match(line.ts, /^\d{4}-\d\d-\d\dT/);
});

test('Audit.record never throws, even if the database does', () => {
  const logs = [];
  const audit = new Audit({ store: { addAudit() { throw new Error('disk full'); } }, log: (l) => logs.push(l) });
  assert.doesNotThrow(() => audit.record('signup.ok', { userId: 1 }));
  assert.ok(logs.some((l) => /audit write failed/.test(l)));
});

test('queryAudit filters by user, exact event, prefix and time, newest first; purge removes old rows', () => {
  const { store } = setup();
  const t = Date.now();
  store.addAudit({ ts: t - 3000, event: 'sandbox.start', userId: 1 });
  store.addAudit({ ts: t - 2000, event: 'sandbox.stop', userId: 1 });
  store.addAudit({ ts: t - 1000, event: 'login.ok', userId: 2 });
  assert.deepEqual(store.queryAudit({ userId: 1 }).map((r) => r.event), ['sandbox.stop', 'sandbox.start']);
  assert.deepEqual(store.queryAudit({ event: 'sandbox.' }).map((r) => r.event), ['sandbox.stop', 'sandbox.start']);
  assert.deepEqual(store.queryAudit({ event: 'login.ok' }).length, 1);
  assert.deepEqual(store.queryAudit({ event: 'login' }).length, 0, 'no prefix without a trailing . or *');
  assert.equal(store.queryAudit({ since: t - 1500 }).length, 1);
  store.purgeAudit(t - 2500);
  assert.equal(store.queryAudit().length, 2);
});

test('parseSpan', () => {
  assert.equal(parseSpan('90m'), 90 * 60000);
  assert.equal(parseSpan('24h'), 86400000);
  assert.equal(parseSpan('7d'), 7 * 86400000);
  for (const x of ['', '5', 'd', '1w', undefined]) assert.equal(parseSpan(x), null);
});

async function gateway(extra = {}) {
  const s = setup(extra);
  const server = createGateway({ cfg: s.cfg, store: s.store, manager: { touch() {} }, log: () => {}, audit: s.audit });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (path, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const data = new URLSearchParams(body).toString();
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
        let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject); req.end(data);
    });
  return { ...s, post, close: () => server.closeAllConnections() || server.close() };
}

test('sign-up, failed and successful sign-in, and logout are audited; passwords and invite codes never appear', async () => {
  const g = await gateway();
  try {
    const code = g.store.createInvite();
    const password = 'a-very-secret-password-1';
    await g.post('/gw/signup', { email: 'a@example.com', password, invite: 'inv_wrong' }, { 'x-forwarded-for': '9.9.9.9' });
    const ok = await g.post('/gw/signup', { email: 'a@example.com', password, invite: code }, { 'x-forwarded-for': '9.9.9.9' });
    assert.equal(ok.status, 303);
    await g.post('/gw/login', { email: 'a@example.com', password: 'wrong-password-xx' });
    await g.post('/gw/login', { email: 'a@example.com', password });
    await g.post('/gw/logout', {});
    assert.equal(events(g.store).at(-1), 'logout');
    const rows = g.store.queryAudit({ limit: 100 }).reverse();
    assert.deepEqual(rows.map((r) => r.event).filter((e) => e !== 'logout'), ['signup.fail', 'signup.ok', 'login.fail', 'login.ok']);
    assert.equal(rows[0].detail.reason, 'invite_invalid');
    assert.equal(rows[0].ip, '9.9.9.9');
    assert.equal(rows[1].detail.viaInvite, true);
    assert.equal(rows[2].detail.reason, 'bad_credentials');
    assert.equal(rows[2].userId, rows[1].userId, 'failed sign-in is tied to the real account');
    const everything = JSON.stringify(rows) + g.logs.join('\n');
    assert.ok(!everything.includes(password), 'no password');
    assert.ok(!everything.includes('wrong-password-xx'), 'no attempted password');
    assert.ok(!everything.includes(code), 'no invite code');
  } finally { g.close(); }
});

test('sign-up failures say why: invalid email, weak password, taken email, rate limit', async () => {
  const g = await gateway({ ALLOW_SIGNUP: 'true' });
  try {
    await g.post('/gw/signup', { email: 'nope', password: 'a-long-password-1' });
    await g.post('/gw/signup', { email: 'b@example.com', password: 'short' });
    g.store.createUser('c@example.com', 'x');
    await g.post('/gw/signup', { email: 'c@example.com', password: 'a-long-password-1' });
    assert.deepEqual(g.store.queryAudit().reverse().map((r) => r.detail.reason), ['invalid_email', 'weak_password', 'email_taken']);
    assert.equal(g.store.queryAudit().at(-1).detail.email, undefined, 'an unparseable email (maybe a typed password) is not stored');
  } finally { g.close(); }
});

function fakeRunner() {
  const boxes = new Map();
  return {
    boxes,
    async info(id) { const b = boxes.get(id); return b ? { running: b.running, startedAt: b.startedAt, llmManaged: true } : null; },
    async create(id) { boxes.set(id, { running: false, startedAt: null }); },
    async start(id) { const b = boxes.get(id); b.running = true; b.startedAt = new Date().toISOString(); },
    async stop(id) { boxes.get(id).running = false; },
    async remove(id) { boxes.delete(id); },
    async logs() { return 'dsh web: https://localhost/?token=abc_DEF-123\n'; },
    async list() { return [...boxes].map(([userId, b]) => ({ userId, running: b.running })); },
  };
}

test('sandbox lifecycle is audited: token issue, create, start, stop (and by whom), refusals', async () => {
  const srv = http.createServer((req, res) => res.writeHead(303, { 'set-cookie': 'dsh-auth-x=v1.tok; Path=/' }).end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { store, audit, cfg } = setup({ MAX_RUNNING_SANDBOXES: '1', MAX_RUN_SECONDS: '3600' });
    const runner = fakeRunner();
    const llm = { issueToken: async () => 'dshu_secret_token_value' };
    const m = new SandboxManager({ runner, cfg: { ...cfg, sandboxPort: srv.address().port }, log: () => {}, llm, audit });
    m.name = () => '127.0.0.1';
    await m.ensure(1);
    await assert.rejects(m.ensure(2), /at capacity/);
    await m.stop(1, 'user');
    await m.ensure(1);
    runner.boxes.get(1).startedAt = new Date(Date.now() - 7200000).toISOString();
    await m.reap();
    await assert.rejects(m.ensure(1), /maximum run time/);
    const log = store.queryAudit({ limit: 100 }).reverse();
    assert.deepEqual(log.map((r) => r.event), ['token.issue', 'sandbox.create', 'sandbox.start', 'token.issue', 'sandbox.create', 'sandbox.refused', 'sandbox.stop', 'sandbox.start', 'sandbox.stop', 'sandbox.refused']);
    assert.equal(log[5].detail.reason, 'capacity');
    assert.equal(log[6].detail.by, 'user');
    assert.equal(log[8].detail.by, 'limit:run_time');
    assert.equal(log[9].detail.reason, 'held');
    assert.ok(!JSON.stringify(log).includes('dshu_secret_token_value'), 'the token itself is never recorded');
  } finally { srv.close(); }
});

test('cli: `audit` accepts its flags in any order, including --json first', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'));
  const store = new Store(join(dir, 'gateway.db'));
  store.addAudit({ event: 'login.ok', userId: 1 });
  store.addAudit({ event: 'signup.ok', userId: 2 });
  store.db.close();
  const cli = (...a) => execFileSync('node', ['gateway/src/cli.js', ...a], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } }).trim().split('\n').filter(Boolean);
  for (const args of [['audit', '--json', '--limit', '10'], ['audit', '--limit', '10', '--json']]) {
    const rows = cli(...args).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.event), ['login.ok', 'signup.ok'], args.join(' '));
  }
  assert.deepEqual(cli('audit', '--user', '2', '--json').map((l) => JSON.parse(l).event), ['signup.ok']);
});
