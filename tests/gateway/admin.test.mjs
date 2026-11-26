// P5-11: the admin role and its guard. The role can only be set from the command line; every /gw/admin route refuses signed-out
// visitors and ordinary users (a table of routes, so a route added without the guard fails here); admins get the panel, and
// everything they do is audited. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adminRoutes } from '../../gateway/src/admin.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const CLI = fileURLToPath(new URL('../../gateway/src/cli.js', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/make-admin.sh', import.meta.url));

test('store: the admin role is off by default, set by email, and shows on the session user', () => {
  const s = new Store(':memory:');
  const a = s.createUser('a@example.com', 'x');
  const b = s.createUser('b@example.com', 'x');
  const cookie = (id) => s.createSession(id, 60);
  assert.equal(s.userBySession(cookie(a)).isAdmin, false);
  assert.deepEqual(s.setAdmin('a@example.com', true), { id: a, email: 'a@example.com', isAdmin: true, changed: true });
  assert.equal(s.userBySession(cookie(a)).isAdmin, true);
  assert.equal(s.userBySession(cookie(b)).isAdmin, false, 'only that account');
  assert.equal(s.setAdmin('a@example.com', true).changed, false, 'granting twice changes nothing');
  assert.deepEqual(s.listAdmins().map((x) => x.email), ['a@example.com']);
  assert.equal(s.setAdmin('a@example.com', false).isAdmin, false);
  assert.equal(s.userBySession(cookie(a)).isAdmin, false);
  assert.equal(s.setAdmin('nobody@example.com', true), null, 'an unknown account is not created');
});

test('migration: a database from before the admin role gets the column, and nobody becomes an admin', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'old-db-')), 'gateway.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL, welcomed_at INTEGER); INSERT INTO users (email, pw_hash, created_at) VALUES ('old@example.com', 'x', 1);");
  old.close();
  const s = new Store(file);
  assert.deepEqual(s.listAdmins(), []);
  assert.equal(s.userBySession(s.createSession(1, 60)).isAdmin, false);
  assert.equal(new Store(file).userByEmail('old@example.com').email, 'old@example.com', 'opening it again is harmless');
});

async function gateway() {
  const store = new Store(':memory:');
  const ids = { admin: store.createUser('admin@example.com', 'x'), user: store.createUser('user@example.com', 'x') };
  store.setAdmin('admin@example.com', true);
  const cfg = loadConfig(base);
  const manager = new SandboxManager({ runner: { diskUsage: async () => [] }, cfg, log: () => {} });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cookies = { anon: undefined, admin: `gw_session=${store.createSession(ids.admin, 60)}`, user: `gw_session=${store.createSession(ids.user, 60)}` };
  const call = (who, method, path, { headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const h = { ...(cookies[who] ? { cookie: cookies[who] } : {}), ...headers };
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: h }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end();
    });
  return { store, ids, call, close: () => { server.closeAllConnections(); server.close(); } };
}

test('guard: every admin route refuses a signed-out visitor and an ordinary user, and serves an admin', async () => {
  const g = await gateway();
  try {
    const routes = adminRoutes({ store: g.store });
    assert.ok(routes.length >= 3, 'the table has the routes');
    for (const r of routes) {
      const anon = await g.call('anon', r.method, r.path);
      if (r.page) {
        assert.equal(anon.status, 303, `${r.path} signed out`);
        assert.equal(anon.headers.location, `/gw/login?next=${encodeURIComponent(r.path)}`);
      } else assert.equal(anon.status, 401, `${r.path} signed out`);
      const user = await g.call('user', r.method, r.path);
      assert.equal(user.status, 404, `${r.path} as an ordinary user looks like it does not exist`);
      assert.ok(!/admin/i.test(user.text.replace(/\/gw\/admin/g, '')) || user.text === 'Not found', 'nothing about the panel is revealed');
      const admin = await g.call('admin', r.method, r.path);
      assert.equal(admin.status, 200, `${r.path} as an admin`);
    }
    // Paths that are not in the table: the same answers, so nothing tells the two apart for an ordinary user.
    for (const path of ['/gw/admin/', '/gw/admin/api/users', '/gw/admin/api', '/gw/admin/../me', '/gw/admin/api/me/extra']) {
      assert.equal((await g.call('user', 'GET', path)).status, 404, path);
      assert.equal((await g.call('anon', 'GET', path)).status, 401, path);
      assert.equal((await g.call('admin', 'GET', path)).status, 404, `${path} (an admin gets "not found" too)`);
    }
    // Wrong method on a real path is not a route either.
    assert.equal((await g.call('admin', 'POST', '/gw/admin/api/me')).status, 404);
  } finally { g.close(); }
});

test('guard: the attempts by ordinary users are audited, and nothing is recorded for admins just for looking', async () => {
  const g = await gateway();
  try {
    await g.call('user', 'GET', '/gw/admin');
    await g.call('user', 'GET', '/gw/admin/api/audit');
    await g.call('admin', 'GET', '/gw/admin');
    const denied = g.store.queryAudit({ event: 'admin.denied' });
    assert.equal(denied.length, 2);
    assert.ok(denied.every((r) => r.userId === g.ids.user));
    assert.deepEqual(denied.map((r) => r.detail.path).sort(), ['/gw/admin', '/gw/admin/api/audit']);
    assert.equal(g.store.queryAudit({ userId: g.ids.admin }).length, 0);
  } finally { g.close(); }
});

test('the panel is never framed and is not cached; the page and its data are what an admin sees', async () => {
  const g = await gateway();
  try {
    const page = await g.call('admin', 'GET', '/gw/admin');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['cache-control'], 'no-store');
    const boot = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(page.text)[1]);
    assert.deepEqual(boot, { page: 'admin', email: 'admin@example.com' });
    const me = JSON.parse((await g.call('admin', 'GET', '/gw/admin/api/me')).text);
    assert.deepEqual(me, { id: g.ids.admin, email: 'admin@example.com' });
    assert.equal((await g.call('admin', 'GET', '/gw/admin/api/me')).headers['x-frame-options'], 'DENY');
  } finally { g.close(); }
});

test('the audit view shows what admins did, newest first, and nothing else', async () => {
  const g = await gateway();
  try {
    g.store.addAudit({ ts: 1000, event: 'admin.grant', userId: g.ids.admin, detail: { via: 'cli' } });
    g.store.addAudit({ ts: 2000, event: 'admin.invite_create', detail: { count: 2 } });
    g.store.addAudit({ ts: 3000, event: 'login.ok', userId: g.ids.user });
    const out = JSON.parse((await g.call('admin', 'GET', '/gw/admin/api/audit')).text);
    assert.deepEqual(out.events.map((e) => e.event), ['admin.invite_create', 'admin.grant']);
    assert.equal(out.events[0].detail.count, 2);
  } finally { g.close(); }
});

test('no request can make anyone an admin: the role is only set from the command line', async () => {
  const g = await gateway();
  try {
    for (const [method, path] of [['POST', '/gw/api/me'], ['POST', '/gw/api/me?admin=1'], ['POST', '/gw/admin/api/grant'], ['POST', '/gw/admin'], ['PUT', '/gw/admin/api/me'], ['GET', '/gw/api/me?isAdmin=1']]) {
      await g.call('user', method, path, { headers: { origin: 'https://localhost' } });
    }
    assert.deepEqual(g.store.listAdmins().map((a) => a.email), ['admin@example.com']);
    const me = JSON.parse((await g.call('user', 'GET', '/gw/api/me')).text);
    assert.equal(me.admin, false);
    assert.equal(JSON.parse((await g.call('admin', 'GET', '/gw/api/me')).text).admin, true, 'the shell learns it from /gw/api/me');
  } finally { g.close(); }
});

function cli(dir, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } });
}

test('command line: grant and revoke by email, audited once per change, unknown accounts refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-cli-'));
  const s = new Store(join(dir, 'gateway.db'));
  const id = s.createUser('boss@example.com', 'x');
  s.createUser('other@example.com', 'x');
  assert.match(cli(dir, 'admin', 'list').stdout, /no admins yet/);
  const unknown = cli(dir, 'admin', 'grant', 'ghost@example.com');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no account with the email "ghost@example.com"/);
  assert.match(cli(dir, 'admin', 'grant', 'BOSS@example.com').stdout, /boss@example.com is an admin$/m);
  assert.match(cli(dir, 'admin', 'grant', 'boss@example.com').stdout, /\(no change\)/);
  assert.match(cli(dir, 'admin', 'list').stdout, new RegExp(`user ${id}  boss@example.com`));
  assert.match(cli(dir, 'admin', 'revoke', 'boss@example.com').stdout, /is not an admin/);
  const rows = new Store(join(dir, 'gateway.db')).queryAudit({ event: 'admin.' });
  assert.deepEqual(rows.map((r) => r.event).sort(), ['admin.grant', 'admin.revoke'], 'one row per real change');
  assert.ok(rows.every((r) => r.userId === id && r.detail.via === 'cli'));
});

/** scripts/make-admin.sh with a stub `docker` that records what it is asked to run. */
function script(args) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME } });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n'); } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

test('scripts/make-admin.sh: grant, revoke and list go to the gateway container; bad use is refused without calling it', () => {
  assert.deepEqual(script(['me@example.com']).calls, ['exec dshcloud-gateway-1 node src/cli.js admin grant me@example.com']);
  assert.deepEqual(script(['--revoke', 'me@example.com']).calls, ['exec dshcloud-gateway-1 node src/cli.js admin revoke me@example.com']);
  assert.deepEqual(script(['--list']).calls, ['exec dshcloud-gateway-1 node src/cli.js admin list']);
  for (const bad of [[], ['--revoke'], ['--nope']]) {
    const r = script(bad);
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.deepEqual(r.calls, []);
  }
  assert.match(script(['--help']).stdout, /make this account an admin/);
  assert.equal(script(['--help']).status, 0);
});
