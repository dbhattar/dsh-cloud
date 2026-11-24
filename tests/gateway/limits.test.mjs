// D1-D3: capacity cap, run-time and disk limits, invite-only sign-up. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const cfgOf = (extra = {}, port = 3080) => ({ ...loadConfig({ ...base, ...extra }), sandboxPort: port });

/** In-memory runner: containers by user id with running/startedAt; records stops. */
function fakeRunner(initial = {}) {
  const boxes = new Map(Object.entries(initial).map(([id, s]) => [Number(id), { running: false, startedAt: new Date().toISOString(), ...s }]));
  const stopped = [];
  let usage = [];
  return {
    boxes, stopped,
    setUsage: (u) => (usage = u),
    async info(id) { const b = boxes.get(id); return b ? { running: b.running, startedAt: b.startedAt, llmManaged: true } : null; },
    async create(id) { boxes.set(id, { running: false, startedAt: null }); },
    async start(id) { const b = boxes.get(id); if (!b.running) { b.running = true; b.startedAt = new Date().toISOString(); } },
    async stop(id) { stopped.push(id); boxes.get(id).running = false; },
    async remove(id) { boxes.delete(id); },
    async logs() { return 'dsh web: https://localhost/?token=abc_DEF-123\n'; },
    async list() { return [...boxes].map(([userId, b]) => ({ userId, running: b.running })); },
    async diskUsage() { return usage; },
  };
}

async function withCookieServer(fn) {
  const srv = http.createServer((req, res) => res.writeHead(303, { 'set-cookie': 'dsh-auth-x=v1.tok; Path=/' }).end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(srv.address().port); } finally { srv.close(); }
}
const manager = (runner, cfg) => {
  const m = new SandboxManager({ runner, cfg, log: () => {} });
  m.name = () => '127.0.0.1';
  return m;
};
const ago = (s) => Date.now() - s * 1000;

test('D1 config: limits default to off in code, signup defaults to invite-only', () => {
  const c = loadConfig(base);
  assert.equal(c.maxRunningSandboxes, 0);
  assert.equal(c.maxRunSeconds, 0);
  assert.equal(c.maxDiskMb, 0);
  assert.equal(c.allowSignup, false);
  assert.equal(loadConfig({ ...base, ALLOW_SIGNUP: 'true' }).allowSignup, true);
  assert.equal(loadConfig({ ...base, MAX_RUNNING_SANDBOXES: '5' }).maxRunningSandboxes, 5);
});

test('D1 capacity: a newcomer is refused with a clear message when full and nobody is idle long enough', async () => {
  await withCookieServer(async (port) => {
    const runner = fakeRunner({ 1: { running: true }, 2: { running: true } });
    const m = manager(runner, cfgOf({ MAX_RUNNING_SANDBOXES: '2' }, port));
    m.lastSeen.set(1, Date.now()); m.lastSeen.set(2, Date.now());
    await assert.rejects(m.ensure(3), /at capacity/);
    assert.equal(m.status(3).state, 'error');
    assert.match(m.status(3).error, /at capacity/);
    assert.deepEqual(runner.stopped, [], 'nobody was evicted');
    assert.equal(runner.boxes.get(3).running, false);
  });
});

test('D1 capacity: when full, the longest-idle sandbox without open sockets is stopped to make room', async () => {
  await withCookieServer(async (port) => {
    const runner = fakeRunner({ 1: { running: true }, 2: { running: true }, 3: { running: true } });
    const m = manager(runner, cfgOf({ MAX_RUNNING_SANDBOXES: '3', EVICT_AFTER_IDLE_SECONDS: '300' }, port));
    m.lastSeen.set(1, ago(1000)); // idle longest, but has an open socket
    m.sockets.set(1, 1);
    m.lastSeen.set(2, ago(900)); // idle, no sockets: the victim
    m.lastSeen.set(3, ago(10));
    await m.ensure(4);
    assert.deepEqual(runner.stopped, [2]);
    assert.equal(runner.boxes.get(4).running, true);
  });
});

test('D1 capacity: a sandbox that is already running is not refused, and is not counted against itself', async () => {
  await withCookieServer(async (port) => {
    const runner = fakeRunner({ 1: { running: true }, 2: { running: true } });
    const m = manager(runner, cfgOf({ MAX_RUNNING_SANDBOXES: '2' }, port));
    await m.ensure(1);
    assert.deepEqual(runner.stopped, []);
  });
});

test('D1 capacity: two newcomers racing for the last slot cannot both get it', async () => {
  await withCookieServer(async (port) => {
    const runner = fakeRunner({ 1: { running: true } });
    const m = manager(runner, cfgOf({ MAX_RUNNING_SANDBOXES: '2' }, port));
    m.lastSeen.set(1, Date.now());
    const results = await Promise.allSettled([m.ensure(2), m.ensure(3)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal([...runner.boxes.values()].filter((b) => b.running).length, 2);
  });
});

test('D1 capacity: with no cap nothing is checked', async () => {
  await withCookieServer(async (port) => {
    const runner = fakeRunner({ 1: { running: true }, 2: { running: true } });
    runner.list = async () => { throw new Error('list must not be called'); };
    await manager(runner, cfgOf({}, port)).ensure(3);
  });
});

test('D2 run time: a sandbox past MAX_RUN_SECONDS is stopped with a message, and stays stopped until started on purpose', async () => {
  await withCookieServer(async (port) => {
    const runner = fakeRunner({ 1: { running: true, startedAt: new Date(ago(7200)).toISOString() }, 2: { running: true, startedAt: new Date(ago(60)).toISOString() } });
    const m = manager(runner, cfgOf({ MAX_RUN_SECONDS: '3600' }, port));
    m.lastSeen.set(1, Date.now()); m.lastSeen.set(2, Date.now());
    await m.reap();
    assert.deepEqual(runner.stopped, [1]);
    assert.match(m.status(1).error, /maximum run time of 1 h/);
    assert.equal(m.status(2).state, 'stopped');
    // an open browser tab asking again does not restart it
    await assert.rejects(m.ensure(1), /maximum run time/);
    assert.equal(runner.boxes.get(1).running, false);
    // the launching page's explicit start does, and resets the clock
    await m.ensure(1, { explicit: true });
    assert.equal(runner.boxes.get(1).running, true);
    assert.equal(m.held.has(1), false);
    await m.reap();
    assert.deepEqual(runner.stopped, [1], 'fresh run time, not stopped again');
  });
});

test('D2 disk: users over MAX_DISK_MB are stopped with their usage in the message; others and stopped ones are left alone', async () => {
  const runner = fakeRunner({ 1: { running: true }, 2: { running: true }, 3: { running: false } });
  runner.setUsage([{ userId: 1, bytes: 3 * 1024 * 1024 }, { userId: 2, bytes: 1024 * 1024 }, { userId: 3, bytes: 9 * 1024 * 1024 }]);
  const m = manager(runner, cfgOf({ MAX_DISK_MB: '2' }));
  for (const id of [1, 2]) m.lastSeen.set(id, Date.now());
  await m.reap();
  assert.deepEqual(runner.stopped, [1]);
  assert.match(m.status(1).error, /3 MB of storage, over the 2 MB limit/);
  assert.equal(m.held.has(3), false);
});

test('D2 disk: usage is only fetched every DISK_CHECK_SECONDS, and a failing runner does not break the reaper', async () => {
  const runner = fakeRunner({ 1: { running: true } });
  let calls = 0;
  runner.diskUsage = async () => { calls++; throw new Error('boom'); };
  const m = manager(runner, cfgOf({ MAX_DISK_MB: '2', DISK_CHECK_SECONDS: '300' }));
  m.lastSeen.set(1, Date.now());
  await m.reap();
  await m.reap();
  assert.equal(calls, 1);
  assert.equal(runner.boxes.get(1).running, true);
});

// ---- D3 invites ----
test('D3 store: an invite works once, expires, and a lost race cannot create a second account', () => {
  const s = new Store(':memory:');
  const code = s.createInvite({ note: 'for ann' });
  assert.match(code, /^inv_/);
  assert.equal(s.inviteValid(code), true);
  assert.equal(s.inviteValid('inv_wrong'), false);
  assert.equal(s.inviteValid(''), false);
  const id = s.createUserWithInvite('a@b.com', 'x', code);
  assert.ok(id > 0);
  assert.equal(s.inviteValid(code), false, 'single use');
  assert.equal(s.createUserWithInvite('c@d.com', 'x', code), null);
  assert.equal(s.userByEmail('c@d.com'), undefined, 'no account created with a spent code');
  assert.equal(s.listInvites()[0].usedBy, id);
  const old = s.createInvite({ ttlDays: 1 }, Date.now() - 2 * 86400000);
  assert.equal(s.inviteValid(old), false, 'expired');
});

test('D3 store: a duplicate email does not burn the invite', () => {
  const s = new Store(':memory:');
  s.createUser('dup@b.com', 'x');
  const code = s.createInvite();
  assert.throws(() => s.createUserWithInvite('dup@b.com', 'x', code));
  assert.equal(s.inviteValid(code), true);
});

async function gateway(extra = {}) {
  const cfg = cfgOf(extra);
  const store = new Store(':memory:');
  const server = createGateway({ cfg, store, manager: { touch() {} }, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (path, body) =>
    new Promise((resolve, reject) => {
      const data = new URLSearchParams(body).toString();
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      });
      req.on('error', reject); req.end(data);
    });
  return { store, post, close: () => server.closeAllConnections() || server.close() };
}

test('D3 signup: without ALLOW_SIGNUP a valid invite is required, and is spent by the account it creates', async () => {
  const g = await gateway();
  try {
    const user = { email: 'new@example.com', password: 'a-long-password-1' };
    assert.equal((await g.post('/gw/signup', user)).status, 400, 'no code');
    assert.equal((await g.post('/gw/signup', { ...user, invite: 'inv_nope' })).status, 400, 'wrong code');
    assert.equal(g.store.userByEmail(user.email), undefined);
    const code = g.store.createInvite();
    const ok = await g.post('/gw/signup', { ...user, invite: code });
    assert.equal(ok.status, 303);
    assert.match(String(ok.headers['set-cookie']), /gw_session=/);
    const again = await g.post('/gw/signup', { email: 'other@example.com', password: 'a-long-password-1', invite: code });
    assert.equal(again.status, 400, 'a spent code does not work twice');
    assert.equal(g.store.userByEmail('other@example.com'), undefined);
  } finally { g.close(); }
});

test('D3 signup: with ALLOW_SIGNUP=true no code is needed', async () => {
  const g = await gateway({ ALLOW_SIGNUP: 'true' });
  try {
    assert.equal((await g.post('/gw/signup', { email: 'open@example.com', password: 'a-long-password-1' })).status, 303);
  } finally { g.close(); }
});

test('D3 signup: guessing invite codes is rate limited per address', async () => {
  const g = await gateway();
  try {
    let last;
    for (let i = 0; i < 12; i++) last = await g.post('/gw/signup', { email: `g${i}@example.com`, password: 'a-long-password-1', invite: `inv_guess${i}` });
    assert.equal(last.status, 429);
  } finally { g.close(); }
});
