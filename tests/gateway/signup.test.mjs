// P5-7: invite links, distinct sign-up messages, returning to the page you wanted, and the invite link CLI. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeNext } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const PASSWORD = 'a-long-password-1';

test('safeNext: same-origin paths only, never back into the sign-in pages', () => {
  for (const ok of ['/', '/some/page', '/some/page?x=1&y=2#frag', '/gw/feedback', '/a/b%20c']) assert.equal(safeNext(ok), ok);
  for (const bad of ['//evil.example', '/\\evil.example', 'http://evil.example', 'https://evil.example/x', 'javascript:alert(1)', 'data:text/html,x', 'relative/path', '', undefined, null, 42, '/a\nb', '/a\tb', '/a\u0000b', '/gw/login', '/gw/login?next=/x', '/gw/signup?invite=x', '/gw/logout', `/${'x'.repeat(2001)}`]) {
    assert.equal(safeNext(bad), null, JSON.stringify(bad));
  }
});

test('inviteStatus tells the four states apart, and trims what was pasted', () => {
  const s = new Store(':memory:');
  const now = Date.now();
  const valid = s.createInvite();
  const used = s.createInvite();
  s.createUserWithInvite('a@b.com', 'x', used);
  const expired = s.createInvite({ ttlDays: 1 }, now - 2 * 86400000);
  assert.equal(s.inviteStatus(valid), 'valid');
  assert.equal(s.inviteStatus(`  ${valid}\n`), 'valid');
  assert.equal(s.inviteStatus(used), 'used');
  assert.equal(s.inviteStatus(expired), 'expired');
  for (const nothing of ['inv_never-issued', '', '   ', undefined, null, 5]) assert.equal(s.inviteStatus(nothing), 'unknown', String(nothing));
  assert.equal(s.inviteValid(valid), true);
  assert.equal(s.inviteValid(used), false);
});

async function gateway(extra = {}) {
  const store = new Store(':memory:');
  const cfg = { ...loadConfig({ ...base, ...extra }) };
  const server = createGateway({ cfg, store, manager: { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: () => Promise.resolve(), status: () => ({}) }, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, path, { body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const data = body ? new URLSearchParams(body).toString() : null;
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(data ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(data);
    });
  /** The data the page was sent: what the React page renders from. */
  const bootOf = (r) => JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(r.text)[1]);
  return { store, call, bootOf, close: () => { server.closeAllConnections(); server.close(); } };
}

test('invite link: a valid code opens the sign-up form with the code filled in and no error', async () => {
  const g = await gateway();
  try {
    const code = g.store.createInvite();
    const b = g.bootOf(await g.call('GET', `/gw/signup?invite=${encodeURIComponent(code)}`));
    assert.equal(b.mode, 'signup');
    assert.deepEqual(b.invite, { code, status: 'valid' });
    assert.equal(b.error, undefined);
    assert.equal(b.inviteRequired, true);
    assert.equal(g.bootOf(await g.call('GET', '/gw/login')).mode, 'login', 'the plain sign-in page still leads with sign-in');
    assert.equal(g.bootOf(await g.call('GET', '/gw/signup')).mode, 'signup');
    assert.equal(g.bootOf(await g.call('GET', `/gw/login?invite=${encodeURIComponent(code)}`)).mode, 'signup', 'an invite on the login URL also leads with sign-up');
  } finally { g.close(); }
});

test('invite link: used, expired and unknown codes say so above the form, and keep the code to correct', async () => {
  const g = await gateway();
  try {
    const used = g.store.createInvite();
    g.store.createUserWithInvite('first@example.com', 'x', used);
    const expired = g.store.createInvite({ ttlDays: 1 }, Date.now() - 3 * 86400000);
    for (const [code, status, message] of [[used, 'used', /already been used/], [expired, 'expired', /has expired/], ['inv_typo', 'unknown', /not valid.*typos/]]) {
      const b = g.bootOf(await g.call('GET', `/gw/signup?invite=${encodeURIComponent(code)}`));
      assert.equal(b.invite.status, status);
      assert.match(b.error, message);
      assert.equal(b.invite.code, code);
    }
  } finally { g.close(); }
});

test('invite link lookups are rate limited per address, and past the limit reveal nothing', async () => {
  const g = await gateway();
  try {
    const code = g.store.createInvite();
    let last;
    for (let i = 0; i < 32; i++) last = g.bootOf(await g.call('GET', `/gw/signup?invite=${encodeURIComponent(code)}`));
    assert.equal(last.invite.status, 'unknown', 'a valid code is no longer confirmed once the limit is passed');
  } finally { g.close(); }
});

test('sign-up says what is wrong with the invite, and keeps what was typed (never the password)', async () => {
  const g = await gateway();
  try {
    const used = g.store.createInvite();
    g.store.createUserWithInvite('first@example.com', 'x', used);
    const expired = g.store.createInvite({ ttlDays: 1 }, Date.now() - 3 * 86400000);
    const cases = [
      [{ invite: '' }, /Enter your invite code/, 'invite_missing'],
      [{ invite: 'inv_nope' }, /not valid/, 'invite_invalid'],
      [{ invite: used }, /already been used/, 'invite_used'],
      [{ invite: expired }, /has expired/, 'invite_expired'],
    ];
    for (const [fields, message, reason] of cases) {
      const r = await g.call('POST', '/gw/signup', { body: { email: 'New@Example.com', password: PASSWORD, next: '/some/page', ...fields } });
      assert.equal(r.status, 400, reason);
      const b = g.bootOf(r);
      assert.match(b.error, message);
      assert.equal(b.mode, 'signup');
      assert.equal(b.email, 'New@Example.com', 'the email is refilled as typed');
      assert.equal(b.next, '/some/page');
      assert.ok(!r.text.includes(PASSWORD), 'the password is never sent back');
      assert.equal(g.store.queryAudit({ event: 'signup.fail' })[0].detail.reason, reason);
    }
    assert.equal(g.store.userByEmail('new@example.com'), undefined, 'no account was created');
  } finally { g.close(); }
});

test('sign-up with a valid invite creates the account and goes where the user wanted (or to the app), never off-site', async () => {
  const g = await gateway();
  try {
    const one = await g.call('POST', '/gw/signup', { body: { email: 'a@example.com', password: PASSWORD, invite: g.store.createInvite(), next: '/some/page?x=1' } });
    assert.equal(one.status, 303);
    assert.equal(one.headers.location, '/some/page?x=1');
    const two = await g.call('POST', '/gw/signup', { body: { email: 'b@example.com', password: PASSWORD, invite: g.store.createInvite(), next: '//evil.example' } });
    assert.equal(two.headers.location, '/');
    const three = await g.call('POST', '/gw/signup', { body: { email: 'c@example.com', password: PASSWORD, invite: g.store.createInvite() } });
    assert.equal(three.headers.location, '/');
  } finally { g.close(); }
});

test('sign-in goes back to the page the user wanted; a failure keeps the email and where to go; unsafe targets are ignored', async () => {
  const g = await gateway({ ALLOW_SIGNUP: 'true' });
  try {
    await g.call('POST', '/gw/signup', { body: { email: 'u@example.com', password: PASSWORD } });
    const ok = await g.call('POST', '/gw/login', { body: { email: 'u@example.com', password: PASSWORD, next: '/deep/link?a=1' } });
    assert.equal(ok.headers.location, '/deep/link?a=1');
    assert.equal((await g.call('POST', '/gw/login', { body: { email: 'u@example.com', password: PASSWORD, next: 'https://evil.example/' } })).headers.location, '/');
    const bad = await g.call('POST', '/gw/login', { body: { email: 'u@example.com', password: 'wrong-password-xx', next: '/deep/link' } });
    assert.equal(bad.status, 401);
    const b = g.bootOf(bad);
    assert.equal(b.email, 'u@example.com');
    assert.equal(b.next, '/deep/link');
    assert.equal(b.mode, 'login');
    assert.ok(!bad.text.includes('wrong-password-xx'));
  } finally { g.close(); }
});

test('an unauthenticated page visit is sent to sign-in with the page remembered; frames and API calls are not', async () => {
  const g = await gateway();
  try {
    const page = await g.call('GET', '/some/deep/link?x=1', { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
    assert.equal(page.status, 303);
    assert.equal(page.headers.location, `/gw/login?next=${encodeURIComponent('/some/deep/link?x=1')}`);
    const frame = await g.call('GET', '/some/deep/link', { headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
    assert.equal(frame.headers.location, '/gw/login', 'the workspace frame does not remember a page');
    assert.equal((await g.call('GET', '//evil.example/x', { headers: { accept: 'text/html' } })).headers.location, '/gw/login');
    assert.equal((await g.call('GET', '/api/thing', { headers: { accept: 'application/json' } })).status, 401);
  } finally { g.close(); }
});

test('already signed in: the sign-in and sign-up pages send you on', async () => {
  const g = await gateway({ ALLOW_SIGNUP: 'true' });
  try {
    const r = await g.call('POST', '/gw/signup', { body: { email: 'u@example.com', password: PASSWORD } });
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    assert.equal((await g.call('GET', '/gw/login', { headers: { cookie } })).headers.location, '/');
    assert.equal((await g.call('GET', '/gw/signup?invite=x&next=/after', { headers: { cookie } })).headers.location, '/after');
  } finally { g.close(); }
});

test('cli: invite create --link prints sign-up links from PUBLIC_URL, and plain output is still just the codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-cli-'));
  const run = (...args) => execFileSync('node', ['gateway/src/cli.js', 'invite', 'create', ...args], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, PUBLIC_URL: 'https://workspace.example.com/' } }).trim().split('\n');
  const links = run('2', '--link');
  assert.equal(links.length, 2);
  for (const l of links) assert.match(l, /^https:\/\/workspace\.example\.com\/gw\/signup\?invite=inv_[\w-]+$/);
  const plain = run('1');
  assert.match(plain[0], /^inv_[\w-]+$/, 'scripts that read the bare code keep working');
  const store = new Store(join(dir, 'gateway.db'));
  assert.equal(store.inviteStatus(decodeURIComponent(new URL(links[0]).searchParams.get('invite'))), 'valid', 'the link carries a code that works');
});
