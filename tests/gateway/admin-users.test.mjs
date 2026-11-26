// P5-13a: the admin pages for accounts. A real gateway in this process with a fake runner and a fake llm-proxy; no Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Audit } from '../../gateway/src/audit.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const PW = 'a-long-password-1';

async function world({ runnerDown = false, revokeFails = false } = {}) {
  const store = new Store(':memory:');
  const ids = {};
  for (const [name, email] of [['admin', 'admin@example.com'], ['alice', 'alice@example.com'], ['bob', 'bob@example.com'], ['carol', 'Carol.Smith@example.com']]) ids[name] = store.createUser(email.toLowerCase(), hashPassword(PW));
  store.setAdmin('admin@example.com', true);
  const boxes = new Map([[ids.alice, { running: true, startedAt: 't1' }], [ids.bob, { running: false }]]);
  const calls = [];
  const runner = {
    list: async () => { if (runnerDown) throw new Error('runner down'); return [...boxes].map(([userId, b]) => ({ userId, running: b.running })); },
    info: async (id) => (boxes.has(id) ? { running: boxes.get(id).running, startedAt: boxes.get(id).startedAt ?? null, llmManaged: true } : null),
    stop: async (id) => { calls.push(['stop', id]); if (boxes.has(id)) boxes.get(id).running = false; },
    remove: async (id) => { calls.push(['remove', id]); boxes.delete(id); },
    start: async (id) => { calls.push(['start', id]); },
    diskUsage: async () => { if (runnerDown) throw new Error('runner down'); return [{ userId: ids.alice, bytes: 2048 }]; },
  };
  const llm = {
    usage: async (id) => ({ day: { used: id * 10, limit: 1000 }, month: { used: id * 100, limit: 10000 }, exhausted: false }),
    usageAll: async () => [{ userId: ids.alice, day: { used: 500, limit: 1000 }, month: { used: 800, limit: 10000 }, exhausted: false }],
    revoke: async (id) => { if (revokeFails) throw new Error('proxy down'); calls.push(['revoke', id]); },
    activity: async () => ({ users: [] }),
  };
  const cfg = loadConfig(base);
  const manager = new SandboxManager({ runner, cfg, log: () => {}, llm, audit: new Audit({ store, log: () => {} }) });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cookies = { admin: `gw_session=${store.createSession(ids.admin, 600)}`, alice: `gw_session=${store.createSession(ids.alice, 600)}`, bob: `gw_session=${store.createSession(ids.bob, 600)}` };
  const raw = (who, method, path, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const h = { ...(cookies[who] ? { cookie: cookies[who] } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...headers };
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: h }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(data);
    });
  const page = await raw('admin', 'GET', '/gw/admin');
  const csrf = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(page.text)[1]).csrf;
  const get = (path) => raw('admin', 'GET', path);
  const post = (path, body = {}, token = csrf) => raw('admin', 'POST', path, { headers: { 'x-csrf-token': token, origin: 'https://localhost' }, body });
  return { store, ids, manager, boxes, calls, raw, get, post, csrf, cookies, close: () => { server.closeAllConnections(); server.close(); } };
}

test('list: newest first, state, tokens and storage per account, search by part of an email', async () => {
  const w = await world();
  try {
    const out = (await w.get('/gw/admin/api/users')).json();
    assert.equal(out.total, 4);
    assert.deepEqual(out.users.map((u) => u.email), ['carol.smith@example.com', 'bob@example.com', 'alice@example.com', 'admin@example.com']);
    const alice = out.users.find((u) => u.email === 'alice@example.com');
    assert.equal(alice.sandbox.state, 'running');
    assert.deepEqual(alice.tokens, { day: 500, month: 800, exhausted: false });
    assert.equal(alice.storageBytes, 2048);
    assert.equal(out.users.find((u) => u.email === 'bob@example.com').sandbox.state, 'stopped');
    assert.equal(out.users.find((u) => u.email === 'carol.smith@example.com').sandbox.state, 'none');
    assert.equal(out.users.find((u) => u.email === 'admin@example.com').isAdmin, true);
    assert.deepEqual(out.sources, { runner: true, proxy: true, storage: true });
    assert.deepEqual((await w.get('/gw/admin/api/users?q=SMITH')).json().users.map((u) => u.email), ['carol.smith@example.com'], 'case-insensitive');
    assert.equal((await w.get('/gw/admin/api/users?q=%25')).json().total, 0, 'a percent sign is text, not a wildcard');
    assert.equal((await w.get('/gw/admin/api/users?q=a_ice')).json().total, 0, 'so is an underscore');
    assert.equal((await w.get('/gw/admin/api/users?q=nobody')).json().users.length, 0);
    assert.equal((await w.get('/gw/admin/api/users?page=2')).json().users.length, 0, 'past the last page is empty, not an error');
    assert.ok(!(await w.get('/gw/admin/api/users')).text.includes('pw_hash'));
  } finally { w.close(); }
});

test('list: with the runner down the accounts still show, with the state marked unknown', async () => {
  const w = await world({ runnerDown: true });
  try {
    const out = (await w.get('/gw/admin/api/users')).json();
    assert.equal(out.total, 4);
    assert.deepEqual(out.sources, { runner: false, proxy: true, storage: false });
    assert.ok(out.users.every((u) => u.sandbox.state === null && u.storageBytes === null));
  } finally { w.close(); }
});

test('detail: account, sandbox, usage, storage, the account\'s own audit rows and the feedback it sent', async () => {
  const w = await world();
  try {
    w.store.addAudit({ event: 'login.ok', userId: w.ids.alice, ip: '10.0.0.1' });
    w.store.addAudit({ event: 'login.ok', userId: w.ids.bob });
    w.store.addFeedback(w.ids.alice, 'bug', 'the build button is gone', { source: 'x' });
    w.manager.held.set(w.ids.alice, 'x');
    w.manager.problems.set(w.ids.alice, { code: 'stopped_run_time', params: {} });
    const d = (await w.get(`/gw/admin/api/users/${w.ids.alice}`)).json();
    assert.equal(d.account.email, 'alice@example.com');
    assert.deepEqual([d.sandbox.state, d.sandbox.startedAt, d.sandbox.held.code], ['running', 't1', 'stopped_run_time']);
    assert.equal(d.sandbox.held.title, 'Your workspace reached its time limit');
    assert.deepEqual(d.usage.day, { used: w.ids.alice * 10, limit: 1000 });
    assert.equal(d.storageBytes, 2048);
    assert.deepEqual(d.audit.map((r) => r.event), ['login.ok'], 'only this account\'s rows');
    assert.equal(d.audit[0].ip, '10.0.0.1');
    assert.deepEqual(d.feedback.map((f) => [f.kind, f.message]), [['bug', 'the build button is gone']]);
    assert.equal((await w.get('/gw/admin/api/users/999')).status, 404);
    assert.equal((await w.get('/gw/admin/api/users/abc')).status, 404);
    assert.ok(!(await w.get(`/gw/admin/api/users/${w.ids.alice}`)).text.includes('pw_hash'));
  } finally { w.close(); }
});

test('csrf: a change without the page\'s token, with a wrong one, or with another session\'s is refused and audited; nothing happens', async () => {
  const w = await world();
  try {
    const path = `/gw/admin/api/users/${w.ids.alice}/stop`;
    for (const token of [undefined, '', 'nope', 'a'.repeat(64)]) {
      const r = await w.raw('admin', 'POST', path, { headers: { ...(token === undefined ? {} : { 'x-csrf-token': token }), origin: 'https://localhost' }, body: {} });
      assert.equal(r.status, 403, `token ${JSON.stringify(token)}`);
      assert.equal(r.json().error, 'csrf');
    }
    assert.deepEqual(w.calls, [], 'the runner was never asked to do anything');
    assert.equal(w.store.queryAudit({ event: 'admin.denied' }).filter((r) => r.detail.reason === 'csrf').length, 4);
    // Another admin session has a different token.
    w.store.setAdmin('alice@example.com', true);
    const other = (await w.raw('alice', 'POST', path, { headers: { 'x-csrf-token': w.csrf, origin: 'https://localhost' }, body: {} }));
    assert.equal(other.status, 403, 'a token from another session is not valid');
    // And a request from another site is refused by the gateway before any of this.
    assert.equal((await w.raw('admin', 'POST', path, { headers: { 'x-csrf-token': w.csrf, origin: 'https://evil.example' }, body: {} })).status, 403);
    assert.equal((await w.post(path)).status, 200, 'the right token works');
  } finally { w.close(); }
});

test('stop: the workspace is stopped and held with its own state, the user sees it, and it is audited with who did it', async () => {
  const w = await world();
  try {
    const r = await w.post(`/gw/admin/api/users/${w.ids.alice}/stop`);
    assert.equal(r.status, 200);
    assert.deepEqual(w.calls, [['stop', w.ids.alice]]);
    assert.equal(r.json().sandbox.held.code, 'stopped_admin');
    const status = (await w.raw('alice', 'GET', '/gw/api/status')).json();
    assert.equal(status.problem.code, 'stopped_admin');
    assert.equal(status.problem.title, 'Your workspace was stopped by an administrator');
    assert.equal(status.problem.action.kind, 'restart', 'the user can start it again');
    const row = w.store.queryAudit({ event: 'admin.user_stop' })[0];
    assert.deepEqual([row.userId, row.detail.by], [w.ids.alice, w.ids.admin]);
    assert.ok(w.store.queryAudit({ event: 'sandbox.stop' }).some((x) => x.detail.by === 'admin'));
  } finally { w.close(); }
});

test('sign out everywhere: the account\'s sessions end, nobody else\'s do', async () => {
  const w = await world();
  try {
    w.store.createSession(w.ids.alice, 600);
    assert.equal((await w.raw('alice', 'GET', '/gw/api/me')).status, 200);
    const r = await w.post(`/gw/admin/api/users/${w.ids.alice}/signout`);
    assert.equal(r.status, 200);
    assert.equal((await w.raw('alice', 'GET', '/gw/api/me')).status, 401);
    assert.equal((await w.raw('bob', 'GET', '/gw/api/me')).status, 200);
    assert.equal(w.store.queryAudit({ event: 'admin.user_signout' })[0].detail.sessions, 2);
    // They can sign in again.
    const login = await w.raw(undefined, 'POST', '/gw/login', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost' }, body: `email=alice%40example.com&password=${PW}` });
    assert.equal(login.status, 303);
  } finally { w.close(); }
});

test('restart: runs through the workspace manager and is audited; a suspended account cannot be restarted', async () => {
  const w = await world();
  try {
    const seen = [];
    w.manager.restart = async (id) => { seen.push(id); return { done: Promise.resolve() }; };
    assert.equal((await w.post(`/gw/admin/api/users/${w.ids.bob}/restart`)).status, 200);
    assert.deepEqual(seen, [w.ids.bob]);
    assert.equal(w.store.queryAudit({ event: 'admin.user_restart' }).length, 1);
    w.store.suspendUser(w.ids.bob);
    const r = await w.post(`/gw/admin/api/users/${w.ids.bob}/restart`);
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'suspended');
    assert.deepEqual(seen, [w.ids.bob], 'not run again');
  } finally { w.close(); }
});

test('suspend: needs the email typed back; then no sign-in, no sessions, workspace stopped and held, model access revoked, audited', async () => {
  const w = await world();
  try {
    const path = `/gw/admin/api/users/${w.ids.alice}/suspend`;
    for (const body of [{}, { confirm: 'alice' }, { confirm: 'bob@example.com' }, { confirm: true }]) {
      const r = await w.post(path, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json().error, 'confirm_mismatch');
    }
    assert.equal(w.store.accountById(w.ids.alice).suspendedAt, null);
    assert.deepEqual(w.calls, [], 'nothing was touched');
    const r = await w.post(path, { confirm: '  Alice@Example.com ' });
    assert.equal(r.status, 200);
    assert.equal(r.json().account.suspendedAt !== null, true);
    assert.deepEqual(w.calls, [['stop', w.ids.alice], ['revoke', w.ids.alice]]);
    assert.equal(r.json().sandbox.held.code, 'stopped_admin');
    assert.equal((await w.raw('alice', 'GET', '/gw/api/me')).status, 401, 'the session they had is gone');
    const form = (password) => w.raw(undefined, 'POST', '/gw/login', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost' }, body: `email=alice%40example.com&password=${password}` });
    const login = await form(PW);
    assert.equal(login.status, 403);
    assert.match(login.text, /This account has been suspended/);
    const wrong = await form('wrong-password-1');
    assert.equal(wrong.status, 401, 'a wrong password still just says invalid: a suspension is not revealed to someone who does not know the password');
    assert.ok(!/suspended/.test(wrong.text));
    assert.equal(w.store.queryAudit({ event: 'login.fail' }).filter((x) => x.detail.reason === 'suspended').length, 1);
    const row = w.store.queryAudit({ event: 'admin.user_suspend' })[0];
    assert.deepEqual([row.userId, row.detail.by], [w.ids.alice, w.ids.admin]);
    assert.equal((await w.post(path, { confirm: 'alice@example.com' })).status, 409, 'already suspended');
  } finally { w.close(); }
});

test('suspend: an admin cannot be suspended (themselves included), and an unknown account is not found', async () => {
  const w = await world();
  try {
    for (const id of [w.ids.admin]) {
      const r = await w.post(`/gw/admin/api/users/${id}/suspend`, { confirm: 'admin@example.com' });
      assert.equal(r.status, 409);
      assert.equal(r.json().error, 'admin_target');
    }
    assert.equal(w.store.accountById(w.ids.admin).suspendedAt, null);
    assert.equal((await w.post('/gw/admin/api/users/999/suspend', { confirm: 'x' })).status, 404);
    assert.equal((await w.post('/gw/admin/api/users/999/stop')).status, 404);
  } finally { w.close(); }
});

test('suspend: if the model token cannot be revoked the account is still suspended and signed out, and the answer says what is left to do', async () => {
  const w = await world({ revokeFails: true });
  try {
    const r = await w.post(`/gw/admin/api/users/${w.ids.alice}/suspend`, { confirm: 'alice@example.com' });
    assert.equal(r.status, 502);
    assert.equal(r.json().error, 'partial');
    assert.equal(r.json().detail.account.suspendedAt !== null, true);
    assert.equal(w.store.accountById(w.ids.alice).suspendedAt !== null, true);
    assert.equal((await w.raw('alice', 'GET', '/gw/api/me')).status, 401);
    assert.equal(w.store.queryAudit({ event: 'admin.user_suspend' })[0].detail.partial, true);
  } finally { w.close(); }
});

test('unsuspend: they can sign in again, the old container (with the revoked token) is removed, the hold is lifted', async () => {
  const w = await world();
  try {
    assert.equal((await w.post(`/gw/admin/api/users/${w.ids.bob}/unsuspend`)).status, 409, 'not suspended');
    await w.post(`/gw/admin/api/users/${w.ids.alice}/suspend`, { confirm: 'alice@example.com' });
    w.calls.length = 0;
    const r = await w.post(`/gw/admin/api/users/${w.ids.alice}/unsuspend`);
    assert.equal(r.status, 200);
    assert.equal(r.json().account.suspendedAt, null);
    assert.deepEqual(w.calls, [['remove', w.ids.alice]]);
    assert.equal(r.json().sandbox.held, null);
    const login = await w.raw(undefined, 'POST', '/gw/login', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost' }, body: `email=alice%40example.com&password=${PW}` });
    assert.equal(login.status, 303);
    assert.equal(w.store.queryAudit({ event: 'admin.user_unsuspend' }).length, 1);
  } finally { w.close(); }
});

test('a body that is not JSON is a 400, not a crash', async () => {
  const w = await world();
  try {
    const r = await w.raw('admin', 'POST', `/gw/admin/api/users/${w.ids.alice}/suspend`, { headers: { 'x-csrf-token': w.csrf, origin: 'https://localhost' }, body: '{not json' });
    assert.equal(r.status, 400);
    assert.equal(r.json().error, 'bad_request');
    assert.equal(w.store.accountById(w.ids.alice).suspendedAt, null);
  } finally { w.close(); }
});
