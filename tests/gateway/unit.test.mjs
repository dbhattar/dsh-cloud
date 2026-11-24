// Gateway unit tests (no Docker needed). Requires Node >= 24 for node:sqlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, hashPassword, normalizeEmail, parseCookies, verifyPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { STAGES, SandboxManager } from '../../gateway/src/sandbox.js';
import { launchingPage, loginPage } from '../../gateway/src/pages.js';

test('password hashing verifies and rejects', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('anything', undefined), 'unknown user never verifies');
  assert.notEqual(h, hashPassword('correct horse battery'), 'salted');
});

test('normalizeEmail', () => {
  assert.equal(normalizeEmail('  A@B.com '), 'a@b.com');
  assert.equal(normalizeEmail('nope'), null);
  assert.equal(normalizeEmail('a'.repeat(250) + '@b.com'), null);
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; b=2=3; junk'), { a: '1', b: '2=3' });
});

test('RateLimiter blocks after max failures and recovers after the window', () => {
  let t = 0;
  const rl = new RateLimiter(3, 1000, () => t);
  for (let i = 0; i < 3; i++) rl.fail('k');
  assert.ok(rl.blocked('k'));
  assert.ok(!rl.blocked('other'));
  t = 1001;
  assert.ok(!rl.blocked('k'));
  rl.fail('k');
  rl.reset('k');
  assert.ok(!rl.blocked('k'));
});

test('Store: users, sessions, expiry, logout', () => {
  const s = new Store(':memory:');
  const id = s.createUser('a@b.com', 'x');
  assert.throws(() => s.createUser('a@b.com', 'y'), 'duplicate email');
  const tok = s.createSession(id, 60);
  assert.equal(s.userBySession(tok).email, 'a@b.com');
  assert.equal(s.userBySession('bogus'), null);
  s.deleteSession(tok);
  assert.equal(s.userBySession(tok), null);
  const expired = s.createSession(id, -1);
  assert.equal(s.userBySession(expired), null);
});

test('config: requires PUBLIC_URL and derives hosts', () => {
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://localhost/' }), /RUNNER_URL/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://r:1', RUNNER_SECRET: 'short' }), /RUNNER_SECRET/);
  const c = loadConfig({ PUBLIC_URL: 'https://app.example.com:8443/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' });
  assert.equal(c.publicHost, 'app.example.com:8443');
  assert.equal(c.trustedHost, 'app.example.com');
  assert.ok(c.secureCookies);
});

/** Fake runner that records the manager's startup stage at every call. */
function fakeRunner({ exists, failCreate = false, stages }) {
  let created = exists;
  let running = false;
  const mgrRef = {};
  const rec = () => stages.push(mgrRef.m.status(1).stage);
  return {
    mgrRef,
    async info() {
      if (!created) return null;
      return { running, startedAt: 't1', llmManaged: true };
    },
    async create() {
      rec();
      if (failCreate) throw new Error('runner POST /1 (create) -> 502');
      created = true;
    },
    async start() {
      rec();
      running = true;
    },
    async logs() {
      rec();
      return 'dsh web: https://localhost/?token=abc_DEF-123\n';
    },
  };
}

async function withCookieServer(fn) {
  const srv = http.createServer((req, res) => {
    res.writeHead(303, { 'set-cookie': 'dsh-auth-x=v1.tok; Path=/; HttpOnly' }).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn(srv.address().port);
  } finally {
    srv.close();
  }
}

test('startup reports ordered stages, first-start vs resume, and clears when ready', async () => {
  await withCookieServer(async (port) => {
    for (const exists of [false, true]) {
      const stages = [];
      const runner = fakeRunner({ exists, stages });
      const cfg = { ...loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' }), sandboxPort: port };
      const m = new SandboxManager({ runner, cfg, log: () => {} });
      runner.mgrRef.m = m;
      m.name = () => '127.0.0.1'; // exchange target
      const p = m.ensure(1);
      assert.equal(m.status(1).state, 'starting');
      assert.equal(m.status(1).stages.length, STAGES.length);
      await p;
      assert.deepEqual(stages, [...stages].sort((a, b) => a - b), 'stages never go backwards');
      assert.ok(stages.includes(STAGES.findIndex((x) => x.key === 'connect')) || stages.at(-1) >= 2);
      const done = m.status(1);
      assert.equal(done.state, 'running');
      assert.equal(done.stage, -1, 'progress cleared once ready');
      assert.equal(m.progress.size, 0);
      if (!exists) assert.ok(stages.includes(0), 'first start passes through create');
    }
  });
});

test('a failed start reports the error, and a retry starts clean (no stale error shown)', async () => {
  const stages = [];
  const runner = fakeRunner({ exists: false, failCreate: true, stages });
  const m = new SandboxManager({ runner, cfg: loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' }), log: () => {} });
  runner.mgrRef.m = m;
  await assert.rejects(m.ensure(1));
  assert.equal(m.status(1).state, 'error');
  assert.match(m.status(1).error, /create/);
  const retry = m.ensure(1);
  retry.catch(() => {});
  const during = m.status(1);
  assert.equal(during.state, 'starting');
  assert.equal(during.error, undefined, 'previous error must not leak into the retry');
  await retry.catch(() => {});
});

test('launching page embeds every stage, never frame-busts, and the login page does', () => {
  const boot = (html) => JSON.parse(html.match(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s)[1]);
  const launching = boot(launchingPage());
  assert.equal(launching.page, 'launching');
  assert.deepEqual(launching.stages, STAGES.map((s) => s.label));
  assert.equal(boot(loginPage({ allowSignup: true })).page, 'login');
  // The bust-out lives in the app bundle: the launching page (rendered inside the app iframe) must be exempt.
  const js = readdirSync(new URL('../../gateway/web/dist/', import.meta.url)).find((f) => f.endsWith('.js'));
  const bundle = readFileSync(new URL(`../../gateway/web/dist/${js}`, import.meta.url), 'utf8');
  assert.match(bundle, /\/gw\/api\/status/);
  assert.match(bundle, /"launching"/);
});

test('page data cannot break out of its script element', () => {
  const html = loginPage({ error: '</script><img src=x onerror=alert(1)>', allowSignup: false });
  assert.ok(!html.includes('</script><img'), 'closing tag escaped');
});

