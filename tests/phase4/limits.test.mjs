// Phase 4 acceptance, abuse controls on a live stack (infra/docker-compose.gateway.yml): invite-only signup, capacity
// cap, global token budget, per-user disk limit, and an audit row for each. A fake provider charges 30 tokens a call.
// Needs Docker. Under gVisor: SANDBOX_RUNTIME=runsc DOCKER_CONTEXT=lima-dsh-linux tests/run.sh phase4
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoDevData, compose, removeUserVolumes, request, sh, waitFor, waitSandboxUp } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const REAL_KEY = `sk-real-${randomBytes(16).toString('hex')}`;
const MODEL = 'test/model';
const GATEWAY = 'dshcloud-gateway-1';
const PROXY = 'dshcloud-llm-proxy-1';
const FAKE = 'fake-llm';
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'false',
  UPSTREAM_API_KEY: REAL_KEY,
  UPSTREAM_BASE_URL: `http://${FAKE}:9000/v1`,
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
  DEFAULT_MODEL: MODEL,
  ALLOWED_MODELS: MODEL,
  DAILY_TOKEN_QUOTA: '0',
  MONTHLY_TOKEN_QUOTA: '0',
  RATE_LIMIT_PER_MINUTE: '600',
  MAX_RUNNING_SANDBOXES: '1',
  EVICT_AFTER_IDLE_SECONDS: '100000', // never evict: the second user must be refused
  WAIT_QUEUE_SECONDS: '0', // and not queued either: this suite tests the refusal (the waiting room is tests/phase5/waiting-room.test.mjs)
  MAX_DISK_MB: '1',
  DISK_CHECK_SECONDS: '15',
  REAP_INTERVAL_SECONDS: '5',
  GLOBAL_DAILY_TOKEN_BUDGET: '60', // two calls of 30 tokens
};
const users = {};
let owned = false;

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const cli = (...a) => docker('exec', GATEWAY, 'node', 'src/cli.js', ...a);
const invite = () => cli('invite', 'create', '1');
const cookieOf = (r) => String(r.headers['set-cookie'] ?? '').split(';')[0];

async function signup(label, code) {
  const email = `${label}-${run}@example.com`;
  const r = await request('/gw/signup', { method: 'POST', body: { email, password: 'test-password-123', ...(code === undefined ? {} : { invite: code }) } });
  if (r.status !== 303) return { status: r.status };
  const cookie = cookieOf(r);
  const me = JSON.parse((await request('/gw/api/me', { headers: { cookie } })).body);
  return { status: 303, email, cookie, id: me.id, container: `dsh-sbx-${me.id}` };
}
const statusOf = async (u) => JSON.parse((await request('/gw/api/status', { headers: { cookie: u.cookie } })).body);
const start = (u) => request('/gw/api/start', { method: 'POST', headers: { cookie: u.cookie } });
const chatFrom = (u) => JSON.parse(docker('exec', u.container, 'node', '-e', `
  fetch(process.env.LLM_BASE_URL + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.LLM_PROXY_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ model: ${JSON.stringify(MODEL)}, messages: [{ role: 'user', content: 'hello' }] }) })
    .then(async (r) => console.log(JSON.stringify({ status: r.status, text: await r.text() })), (e) => console.log(JSON.stringify({ status: 0, text: String(e) })));`));

before(async () => {
  assertNoDevData();
  owned = true;
  tryDocker('rm', '-f', FAKE);
  compose(FILE, ['up', '-d', '--build'], ENV);
  docker('run', '-d', '--name', FAKE, '--network', 'dsh-sandboxes', '-e', `REAL_KEY=${REAL_KEY}`,
    '-v', `${join(dirname(fileURLToPath(import.meta.url)), '..', 'phase3', 'fake-upstream.mjs')}:/app/fake-upstream.mjs:ro`, 'node:24-slim', 'node', '/app/fake-upstream.mjs');
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
});

after(() => {
  if (!owned) return;
  for (const u of Object.values(users)) {
    tryDocker('rm', '-f', u.container);
    removeUserVolumes(u.id);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  tryDocker('rm', '-f', FAKE);
  compose(FILE, ['down', '-v'], ENV);
});

test('signup without an invite code, or with a wrong or reused one, is refused; a valid code works once', async () => {
  assert.equal((await signup('x', undefined)).status, 400, 'no code');
  assert.equal((await signup('x', 'inv_not-a-real-code')).status, 400, 'wrong code');
  const code = invite();
  users.a = await signup('a', code);
  assert.equal(users.a.status, 303, 'valid code');
  assert.equal((await signup('reuse', code)).status, 400, 'the same code again');
});

test('capacity cap: with one slot taken, a second user is refused with a clear message and nothing is evicted', async () => {
  users.b = await signup('b', invite());
  assert.equal(users.b.status, 303);
  await start(users.a);
  await waitSandboxUp(users.a);
  await start(users.b);
  const s = await waitFor(async () => { const j = await statusOf(users.b); return j.state === 'error' ? j : null; }, { what: 'capacity refusal', timeoutMs: 60000 });
  assert.match(s.error, /at capacity/);
  assert.equal(tryDocker('inspect', '-f', '{{.State.Running}}', users.a.container), 'true', 'the running sandbox was not evicted');
  assert.notEqual(tryDocker('inspect', '-f', '{{.State.Running}}', users.b.container), 'true', 'the refused user\'s container was not started');
});

test('global token budget: once all users together use it up, every call gets 429 and the provider is not called', async () => {
  assert.equal(chatFrom(users.a).status, 200);
  assert.equal(chatFrom(users.a).status, 200); // 60 tokens: the budget
  const blocked = chatFrom(users.a);
  assert.equal(blocked.status, 429);
  assert.equal(JSON.parse(blocked.text).error.code, 'budget_exhausted');
  assert.match(docker('logs', PROXY), /audit .*"event":"budget\.exhausted"/);
});

test('disk limit: a user over MAX_DISK_MB is stopped and told why', async () => {
  docker('exec', users.a.container, 'sh', '-c', 'head -c 3000000 /dev/urandom > /workspace/big.bin');
  const s = await waitFor(async () => { const j = await statusOf(users.a); return j.state === 'error' ? j : null; }, { what: 'disk-limit stop', timeoutMs: 120000, everyMs: 3000 });
  assert.match(s.error, /storage.*over the 1 MB limit/);
  await waitFor(() => tryDocker('inspect', '-f', '{{.State.Running}}', users.a.container) === 'false', { what: 'container stopped' });
  // a request from an open tab does not quietly restart it
  await request('/', { headers: { cookie: users.a.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
  assert.equal(tryDocker('inspect', '-f', '{{.State.Running}}', users.a.container), 'false');
});

test('every action above left an audit row', () => {
  const rows = cli('audit', '--json', '--limit', '500').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const has = (event, pred = () => true) => rows.some((r) => r.event === event && pred(r));
  assert.ok(has('signup.fail', (r) => r.detail.reason === 'invite_invalid'), 'refused signup');
  assert.ok(has('signup.ok', (r) => r.userId === users.a.id && r.detail.viaInvite === true), 'invited signup');
  assert.ok(has('admin.invite_create'), 'invite created');
  assert.ok(has('token.issue', (r) => r.userId === users.a.id), 'token issued');
  assert.ok(has('sandbox.start', (r) => r.userId === users.a.id), 'sandbox started');
  assert.ok(has('sandbox.refused', (r) => r.userId === users.b.id && r.detail.reason === 'capacity'), 'capacity refusal');
  assert.ok(has('sandbox.stop', (r) => r.userId === users.a.id && r.detail.by === 'limit:disk'), 'disk-limit stop');
  assert.ok(!JSON.stringify(rows).includes('test-password-123'), 'no password in the trail');
});
