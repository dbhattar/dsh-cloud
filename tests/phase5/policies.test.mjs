// P5-15 on a live stack: settings changed in the admin panel apply to the running gateway and llm-proxy without a restart, and
// outlive a restart of either. A changed idle time stops a real sandbox that the old one would have kept; a changed model allowance
// shows in the person's own usage; opening and closing sign-up takes effect on the next sign-up. Needs Docker; gVisor in the Lima VM:
//   DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, request, sh, signupUser, sleep, waitFor, waitSandboxUp } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  IDLE_SECONDS: '3600', // far longer than this suite waits: only a change in the panel can stop an idle sandbox in time
  REAP_INTERVAL_SECONDS: '5',
  UPSTREAM_API_KEY: 'phase5-placeholder',
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
};
const GATEWAY = 'dshcloud-gateway-1';
const PROXY = 'dshcloud-llm-proxy-1';
const users = {};
let owned = false;
let csrf = '';

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const JSON_HEADERS = { 'content-type': 'application/json' };
const policies = async () => JSON.parse((await request('/gw/admin/api/policies', { headers: { cookie: users.admin.cookie } })).body);
const setting = async (key) => (await policies()).settings.find((s) => s.key === key);
const change = (key, value, confirm) => request(`/gw/admin/api/policies/${key}`, { method: 'POST', headers: { ...JSON_HEADERS, cookie: users.admin.cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ value, ...(confirm ? { confirm: true } : {}) }) });
const reset = (key) => request(`/gw/admin/api/policies/${key}/reset`, { method: 'POST', headers: { ...JSON_HEADERS, cookie: users.admin.cookie, 'x-csrf-token': csrf }, body: '{}' });
const limits = async (u) => JSON.parse((await request('/gw/api/limits', { headers: { cookie: u.cookie } })).body);
const status = (u) => tryDocker('inspect', '-f', '{{.State.Status}}', u.container) || 'missing';
const restart = async (name, healthy) => {
  docker('restart', name);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { timeoutMs: 90000, what: `${name} back` });
  if (healthy) await waitFor(() => tryDocker('inspect', '-f', '{{.State.Health.Status}}', name) === 'healthy', { timeoutMs: 90000, what: `${name} healthy` });
  await refreshCsrf(); // the session survives (it lives in the gateway database); the page token is per process
};

const refreshCsrf = async () => {
  const page = await request('/gw/admin', { headers: { cookie: users.admin.cookie, accept: 'text/html' } });
  csrf = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(page.body)[1]).csrf;
};

before(async () => {
  assertNoDevData();
  owned = true;
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
  users.admin = await signupUser('admin', run);
  users.target = await signupUser('target', run);
  docker('exec', GATEWAY, 'node', 'src/cli.js', 'admin', 'grant', users.admin.email);
  await refreshCsrf();
  await request('/gw/api/start', { method: 'POST', headers: { cookie: users.target.cookie } });
  await waitSandboxUp(users.target);
});

after(() => {
  if (!owned) return;
  for (const u of Object.values(users)) {
    tryDocker('rm', '-f', u.container);
    tryDocker('volume', 'rm', `dsh-data-${u.id}`, `dsh-ws-${u.id}`);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  compose(FILE, ['down', '-v'], ENV);
});

test('the list has the gateway\'s settings and the real proxy\'s, with the environment values as defaults', async () => {
  const out = await policies();
  assert.equal(out.proxy.ok, true);
  const idle = out.settings.find((s) => s.key === 'idleSeconds');
  assert.deepEqual([idle.scope, idle.value, idle.default, idle.source], ['gateway', 3600, 3600, 'default']);
  const quota = out.settings.find((s) => s.key === 'dailyTokenQuota');
  assert.deepEqual([quota.scope, quota.source], ['proxy', 'default']);
  assert.ok(quota.value > 0);
});

test('a model allowance changed in the panel shows in the person\'s own usage at once, and again after the proxy restarts; reset restores it', async () => {
  const before = (await limits(users.target)).tokens.day.limit;
  assert.equal((await change('dailyTokenQuota', 250_000)).status, 200);
  assert.equal((await limits(users.target)).tokens.day.limit, 250_000, 'no restart needed');
  assert.equal((await change('dailyTokenQuota', 5)).status, 400);
  assert.equal((await change('dailyTokenQuota', 0)).status, 400, 'turning it off needs the yes');
  assert.equal((await limits(users.target)).tokens.day.limit, 250_000, 'refusals changed nothing');
  await restart(PROXY, true);
  assert.equal((await limits(users.target)).tokens.day.limit, 250_000, 'the override outlives a restart of the proxy');
  assert.equal((await setting('dailyTokenQuota')).source, 'admin');
  assert.equal((await reset('dailyTokenQuota')).status, 200);
  assert.equal((await limits(users.target)).tokens.day.limit, before);
});

test('a shorter idle time stops a real sandbox that the old one would have kept, and survives a restart of the gateway', async () => {
  assert.equal(status(users.target), 'running');
  assert.equal((await change('idleSeconds', 60)).status, 200);
  await waitFor(() => status(users.target) === 'exited', { timeoutMs: 150000, everyMs: 3000, what: 'idle stop under the new limit' });
  const stop = tryDocker('exec', GATEWAY, 'node', 'src/cli.js', 'audit', '--user', String(users.target.id), '--event', 'sandbox.stop', '--json');
  assert.match(stop, /"by":"idle"/);
  await restart(GATEWAY);
  const idle = await setting('idleSeconds');
  assert.deepEqual([idle.value, idle.source], [60, 'admin'], 'the override outlives a restart of the gateway');
  assert.equal((await reset('idleSeconds')).status, 200);
  assert.equal((await setting('idleSeconds')).value, 3600);
  const log = tryDocker('exec', GATEWAY, 'node', 'src/cli.js', 'audit', '--event', 'admin.policy*', '--json');
  assert.match(log, /"key":"idleSeconds"[^}]*"to":60/);
});

test('closing sign-up refuses the next sign-up without an invite, opening it (with the yes) accepts it, with no restart', async () => {
  assert.equal((await change('allowSignup', false)).status, 200);
  const closed = await request('/gw/signup', { method: 'POST', body: { email: `closed-${run}@example.com`, password: 'test-password-123' } });
  assert.equal(closed.status, 400);
  assert.equal((await change('allowSignup', true)).status, 400, 'opening it needs the yes');
  assert.equal((await change('allowSignup', true, true)).status, 200);
  const open = await request('/gw/signup', { method: 'POST', body: { email: `open-${run}@example.com`, password: 'test-password-123' } });
  assert.equal(open.status, 303);
  users.late = { id: JSON.parse((await request('/gw/api/me', { headers: { cookie: open.headers['set-cookie'].join(';').split(';')[0] } })).body).id };
  users.late.container = `dsh-sbx-${users.late.id}`;
  assert.equal((await reset('allowSignup')).status, 200);
});
