// SEC-06 and SEC-18 (docs/security-review.md): what an anonymous caller can do to the gateway through the sign-in pages. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Audit } from '../../gateway/src/audit.js';
import { BusyError, Gate, RateLimiter, hashGate, hashPassword, hashPasswordAsync, normalizeEmail, verifyPassword, verifyPasswordAsync } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const PW = 'a-long-password-1';
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));

async function gateway(env = {}) {
  const store = new Store(':memory:');
  const lines = [];
  const server = createGateway({ cfg: loadConfig({ ...base, ...env }), store, manager: { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: async () => ({}), status: () => ({}) }, log: (l) => lines.push(l), audit: new Audit({ store, log: (l) => lines.push(l) }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const form = (path, fields, headers = {}) => fetch(url + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost', ...headers }, body: new URLSearchParams(fields) });
  const login = (email, password, ip) => form('/gw/login', { email, password }, ip ? { 'x-forwarded-for': ip } : {});
  return { store, lines, url, form, login, audits: (event) => store.queryAudit({ event, limit: 500 }) };
}

// ---- hashing off the main thread ----

test('the gate: never more than maxActive at once, a bounded queue, refusal past it, and first come first served', async () => {
  const gate = new Gate(2, 3);
  let active = 0;
  let peak = 0;
  const order = [];
  const release = [];
  const job = (id) => gate.run(async () => { active++; peak = Math.max(peak, active); order.push(id); await new Promise((r) => release.push(r)); active--; });
  const all = [1, 2, 3, 4, 5].map(job); // 2 running, 3 waiting: the queue is full
  // (raced against a timer: without a queue bound this would wait for ever instead of failing)
  const sixth = await Promise.race([job(6).then(() => 'accepted', (e) => e), new Promise((r) => setTimeout(() => r('waited'), 300))]);
  assert.ok(sixth instanceof BusyError, `the sixth was ${sixth}`);
  assert.equal(peak, 2);
  while (release.length) { release.shift()(); await new Promise((r) => setImmediate(r)); }
  await Promise.all(all);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  assert.equal(gate.active, 0);
  await gate.run(async () => {}); // usable again once drained
});

test('async hashes and checks are the same format as the synchronous ones, so existing accounts keep working', async () => {
  assert.ok(verifyPassword(PW, await hashPasswordAsync(PW)));
  assert.equal(await verifyPasswordAsync(PW, hashPassword(PW)), true);
  assert.equal(await verifyPasswordAsync('wrong-password-1', hashPassword(PW)), false);
  assert.equal(await verifyPasswordAsync(PW, undefined), false, 'an unknown user costs the same work and is refused');
  assert.equal(await verifyPasswordAsync(PW, 'not$a$hash'), false);
});

test('while passwords are being checked the gateway keeps answering: the event loop is not blocked', async () => {
  const stored = hashPassword(PW);
  const t0 = process.hrtime.bigint();
  verifyPassword(PW, stored);
  const oneMs = Number(process.hrtime.bigint() - t0) / 1e6; // what one check used to freeze the thread for
  let last = performance.now();
  let maxGap = 0;
  const ticker = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 2);
  await Promise.all(Array.from({ length: 8 }, () => verifyPasswordAsync('wrong-password-1', stored, new Gate(8, 8))));
  maxGap = Math.max(maxGap, performance.now() - last); // a loop that never got a turn has not ticked at all: count the time up to now
  clearInterval(ticker);
  assert.ok(maxGap < oneMs / 2, `the loop stalled for ${maxGap.toFixed(1)} ms; one synchronous check takes ${oneMs.toFixed(1)} ms`);
});

test('a full hashing queue is a 503 with Retry-After, before anything is spent; a reset link is not used up by it', async () => {
  const g = await gateway();
  g.store.createUser('ann@example.com', hashPassword(PW));
  const saved = [hashGate.active, hashGate.maxQueue];
  hashGate.active = hashGate.maxActive;
  hashGate.maxQueue = 0; // saturated
  try {
    const r = await g.login('ann@example.com', PW);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '2');
    assert.match(await r.text(), /busy right now/);
    const up = await g.form('/gw/signup', { email: 'new@example.com', password: PW, invite: 'x' });
    assert.ok([400, 503].includes(up.status));
    const token = g.store.createResetToken(g.store.userByEmail('ann@example.com').id, 60_000);
    const reset = await g.form('/gw/reset', { token, password: 'brand-new-password-1', confirm: 'brand-new-password-1' });
    assert.equal(reset.status, 503);
    assert.equal(g.store.resetTokenStatus(token), 'valid', 'the link is still good');
  } finally {
    [hashGate.active, hashGate.maxQueue] = saved;
  }
  assert.equal((await g.login('ann@example.com', PW)).status, 303, 'and the service works again once it is not saturated');
});

// ---- the limits do not depend on the half of the key an attacker can change ----

test('trying many different emails from one address is limited by address, not only by address and email', async () => {
  const g = await gateway({ LOGIN_MAX_PER_IP: '5' });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await g.login(`nobody${i}@example.com`, 'whatever-password', '10.0.0.1')).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429], 'the sixth fresh email is refused though no email was repeated');
  assert.equal((await g.login('nobody9@example.com', 'whatever-password', '10.0.0.2')).status, 401, 'another address is not affected');
});

test('guessing one account from many addresses is limited by email', async () => {
  const g = await gateway({ LOGIN_MAX_PER_EMAIL: '3' });
  g.store.createUser('ann@example.com', hashPassword(PW));
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await g.login('ann@example.com', 'wrong-password-1', `10.1.0.${i}`)).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('a successful sign-in from a fresh address still works, and does not clear the other counters', async () => {
  const g = await gateway({ LOGIN_MAX_PER_EMAIL: '3' });
  g.store.createUser('ann@example.com', hashPassword(PW));
  assert.equal((await g.login('ann@example.com', PW, '10.2.0.1')).status, 303);
  assert.equal((await g.login('ann@example.com', 'wrong-password-1', '10.2.0.2')).status, 401);
});

// ---- what a flood leaves behind ----

test('a flood of refused sign-ins is written down once, not once each', async () => {
  const g = await gateway({ LOGIN_MAX_PER_IP: '2' });
  for (let i = 0; i < 40; i++) await g.login(`x${i}@example.com`, 'whatever-password', '10.3.0.1');
  assert.equal(g.audits('login.fail').filter((r) => r.detail.reason === 'rate_limited').length, 1);
  assert.equal(g.audits('login.fail').filter((r) => r.detail.reason === 'bad_credentials').length, 2, 'only real attempts are rows');
  assert.ok(g.lines.length < 20, `${g.lines.length} log lines for 40 requests`);
});

test('the path a signed-in non-admin asks for is bounded in the audit row', async () => {
  const g = await gateway();
  const uid = g.store.createUser('plain@example.com', hashPassword(PW));
  const cookie = `gw_session=${g.store.createSession(uid, 600)}`;
  await fetch(`${g.url}/gw/admin/${'a'.repeat(5000)}`, { headers: { cookie } });
  const row = g.audits('admin.denied')[0];
  assert.ok(row, 'denied and audited');
  assert.ok(row.detail.path.length <= 120, `path of ${row.detail.path.length} characters`);
});

test('limiters: expired keys are swept, size is capped, and a block is noted once per window', () => {
  let now = 1_000;
  const l = new RateLimiter(2, 1000, () => now, 3);
  for (const k of ['a', 'b', 'c', 'd', 'e']) l.fail(k);
  assert.equal(l.hits.size, 3, 'the oldest keys were forgotten to stay within the cap');
  now += 5000;
  l.sweep();
  assert.equal(l.hits.size, 0, 'all expired: nothing kept');
  assert.equal(l.firstBlock('k'), true);
  assert.equal(l.firstBlock('k'), false);
  now += 1001;
  assert.equal(l.firstBlock('k'), true, 'a new window');
});

// ---- sign-up: the error pages are not an invite oracle ----

test('every sign-up attempt counts, so a code cannot be probed through the error pages; a refused caller learns nothing', async () => {
  const g = await gateway();
  const good = g.store.createInvite();
  const statusOf = async (r) => /"status":"(\w+)"/.exec(await r.text())?.[1];
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const r = await g.form('/gw/signup', { email: 'new@example.com', password: 'short', invite: good }, { 'x-forwarded-for': '10.4.0.1' });
    seen.push([r.status, await statusOf(r)]);
  }
  assert.deepEqual(seen.slice(0, 10).map((s) => s[0]), Array(10).fill(400));
  assert.deepEqual(seen.slice(10).map((s) => s[0]), [429, 429], 'the eleventh attempt, valid code or not, is refused');
  assert.ok(seen.slice(0, 10).every((s) => s[1] === 'valid'), 'within the limit the page still helps a real person');
  assert.ok(seen.slice(10).every((s) => s[1] !== 'valid'), 'past it, the page does not say whether the code is good');
});

// ---- addresses that end up in a mail header ----

test('addresses with separators, brackets, quotes, spaces or non-ASCII are not accepted', () => {
  assert.equal(normalizeEmail('First.Last+tag@Example.com'), 'first.last+tag@example.com');
  for (const bad of ['x,victim@y.com', 'x;v@y.com', 'x<v@y.com>', '"q"@y.com', 'a b@y.com', 'ünï@y.com', 'a@b', 'a@b..co', 'a@-.co', 'a(b)@y.com', 'a\\b@y.com', 'a@y.com\nBcc: z@y.com', '']) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
});

test('waitlist entries nobody confirmed are purged after the time given, confirmed ones never', () => {
  const s = new Store(':memory:');
  s.joinWaitlist('old@example.com', 1000);
  s.joinWaitlist('keep@example.com', 1000);
  s.confirmWaitlist('keep@example.com', 2000);
  s.joinWaitlist('new@example.com', 9000);
  assert.equal(s.purgeUnconfirmedWaitlist(5000), 1);
  assert.deepEqual(s.listWaitlist().map((e) => e.email).sort(), ['keep@example.com', 'new@example.com']);
});
