// P5-13a on a live stack: an admin acts on another account's real workspace. Stop (held with its own state, the user can start it
// again), restart, sign out everywhere, and suspend (workspace stopped, sessions gone, sign-in refused, the model token revoked at
// the proxy) then lift the suspension (new container, new token, working again). Needs Docker; gVisor in the Lima VM:
//   DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, cookieOf, removeUserVolumes, request, sh, signupUser, waitFor, waitSandboxUp } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const PW = 'test-password-123';
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  UPSTREAM_API_KEY: 'phase5-placeholder',
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
};
const users = {};
let owned = false;
let csrf = '';

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const GATEWAY = 'dshcloud-gateway-1';
const status = (u) => tryDocker('inspect', '-f', '{{.State.Status}}', u.container) || 'missing';
const startedAt = (u) => tryDocker('inspect', '-f', '{{.State.StartedAt}}', u.container);
const tokenOf = (u) => tryDocker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', u.container).split('\n').find((l) => l.startsWith('LLM_PROXY_TOKEN='))?.slice('LLM_PROXY_TOKEN='.length) ?? '';
/** What the model proxy answers to this token (401 = revoked or unknown), asked from the gateway container, which can reach it. */
const proxyStatus = (token) => Number(docker('exec', GATEWAY, 'node', '-e', `fetch('http://llm-proxy:8081/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+process.argv[1],'content-type':'application/json'},body:JSON.stringify({model:'openrouter/free',messages:[{role:'user',content:'x'}]})}).then(r=>console.log(r.status))`, token));
const audit = (u, event) => tryDocker('exec', GATEWAY, 'node', 'src/cli.js', 'audit', '--user', String(u.id), '--event', event, '--json');
const JSON_HEADERS = { 'content-type': 'application/json' };
const act = (u, action, body = {}) => request(`/gw/admin/api/users/${u.id}/${action}`, { method: 'POST', headers: { ...JSON_HEADERS, cookie: users.admin.cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body) });
const me = async (u) => (await request('/gw/api/me', { headers: { cookie: u.cookie } })).status;

before(async () => {
  assertNoDevData();
  owned = true;
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
  users.admin = await signupUser('admin', run);
  users.target = await signupUser('target', run);
  users.other = await signupUser('other', run);
  docker('exec', GATEWAY, 'node', 'src/cli.js', 'admin', 'grant', users.admin.email);
  const page = await request('/gw/admin', { headers: { cookie: users.admin.cookie, accept: 'text/html' } });
  csrf = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(page.body)[1]).csrf;
  for (const u of [users.target, users.other]) {
    await request('/gw/api/start', { method: 'POST', headers: { cookie: u.cookie } });
    await waitSandboxUp(u);
  }
});

after(() => {
  if (!owned) return;
  for (const u of Object.values(users)) {
    tryDocker('rm', '-f', u.container);
    removeUserVolumes(u.id);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  compose(FILE, ['down', '-v'], ENV);
});

test('the list and the account page show the real workspace state, usage and storage; an ordinary user is refused', async () => {
  const list = JSON.parse((await request('/gw/admin/api/users', { headers: { cookie: users.admin.cookie } })).body);
  const row = list.users.find((u) => u.id === users.target.id);
  assert.equal(row.sandbox.state, 'running');
  assert.ok(row.storageBytes > 0, 'storage comes from the runner');
  const d = JSON.parse((await request(`/gw/admin/api/users/${users.target.id}`, { headers: { cookie: users.admin.cookie } })).body);
  assert.equal(d.sandbox.state, 'running');
  assert.ok(d.audit.some((r) => r.event === 'sandbox.start'));
  assert.equal((await request('/gw/admin/api/users', { headers: { cookie: users.other.cookie } })).status, 404);
});

test('stop: the workspace stops and is held with its own state; the user starts it again themselves', async () => {
  const r = await act(users.target, 'stop');
  assert.equal(r.status, 200, r.body);
  assert.equal(status(users.target), 'exited');
  const st = JSON.parse((await request('/gw/api/status', { headers: { cookie: users.target.cookie } })).body);
  assert.equal(st.problem.code, 'stopped_admin');
  assert.match(audit(users.target, 'admin.user_stop'), /"by":/);
  await request('/gw/api/start', { method: 'POST', headers: { cookie: users.target.cookie } });
  await waitSandboxUp(users.target);
  assert.equal(status(users.target), 'running');
  assert.equal(status(users.other), 'running', 'a neighbour is untouched');
});

test('restart: a new run of the same container, and a change without the CSRF token is refused', async () => {
  const before = startedAt(users.target);
  const noToken = await request(`/gw/admin/api/users/${users.target.id}/restart`, { method: 'POST', headers: { ...JSON_HEADERS, cookie: users.admin.cookie }, body: '{}' });
  assert.equal(noToken.status, 403);
  assert.equal(startedAt(users.target), before, 'nothing happened');
  assert.equal((await act(users.target, 'restart')).status, 200);
  await waitFor(() => startedAt(users.target) !== before && status(users.target) === 'running', { timeoutMs: 90000, what: 'restart' });
  await waitSandboxUp(users.target);
});

test('sign out everywhere ends the account\'s sessions only', async () => {
  assert.equal(await me(users.target), 200);
  assert.equal((await act(users.target, 'signout')).status, 200);
  assert.equal(await me(users.target), 401);
  assert.equal(await me(users.other), 200);
  const login = await request('/gw/login', { method: 'POST', body: { email: users.target.email, password: PW } });
  assert.equal(login.status, 303);
  users.target.cookie = cookieOf(login, 'gw_session');
});

test('suspend: stopped and held, signed out, sign-in refused, and the model token is revoked at the proxy', async () => {
  const token = tokenOf(users.target);
  assert.match(token, /^dshu_/);
  assert.notEqual(proxyStatus(token), 401, 'the token works before');
  const wrong = await act(users.target, 'suspend', { confirm: 'someone-else@example.com' });
  assert.equal(wrong.status, 400);
  assert.equal(status(users.target), 'running', 'a wrong confirmation changed nothing');
  const r = await act(users.target, 'suspend', { confirm: users.target.email });
  assert.equal(r.status, 200, r.body);
  assert.equal(status(users.target), 'exited');
  assert.equal(await me(users.target), 401);
  const login = await request('/gw/login', { method: 'POST', body: { email: users.target.email, password: PW } });
  assert.equal(login.status, 403);
  assert.match(login.body, /suspended/);
  assert.equal(proxyStatus(token), 401, 'the proxy refuses the token');
  assert.equal(await me(users.other), 200);
  assert.match(audit(users.target, 'admin.user_suspend'), /"by":/);
});

test('lift the suspension: the old container is removed, they sign in, and a new workspace starts with a new, working token', async () => {
  const oldToken = tokenOf(users.target);
  const r = await act(users.target, 'unsuspend');
  assert.equal(r.status, 200, r.body);
  assert.equal(status(users.target), 'missing', 'the container with the revoked token is gone (volumes stay)');
  const login = await request('/gw/login', { method: 'POST', body: { email: users.target.email, password: PW } });
  assert.equal(login.status, 303);
  users.target.cookie = cookieOf(login, 'gw_session');
  await request('/gw/api/start', { method: 'POST', headers: { cookie: users.target.cookie } });
  await waitSandboxUp(users.target);
  const fresh = tokenOf(users.target);
  assert.notEqual(fresh, oldToken);
  assert.notEqual(proxyStatus(fresh), 401, 'the new token works');
  assert.equal(proxyStatus(oldToken), 401, 'the old one stays revoked');
});
