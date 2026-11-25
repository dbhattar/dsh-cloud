// P5-1 on a live stack: a sandbox whose agent is busy survives with no browser attached; an idle one is stopped; the
// busy-time cap still applies. Timings are shortened: idle limit 20 s, busy cap 90 s, reap every 5 s.
// Needs Docker. Under gVisor: DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoDevData, compose, request, sh, signupUser, sleep, waitFor, waitSandboxUp } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const REAL_KEY = `sk-real-${randomBytes(16).toString('hex')}`;
const MODEL = 'test/model';
const GATEWAY = 'dshcloud-gateway-1';
const FAKE = 'fake-llm';
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  UPSTREAM_API_KEY: REAL_KEY,
  UPSTREAM_BASE_URL: `http://${FAKE}:9000/v1`,
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
  DEFAULT_MODEL: MODEL,
  ALLOWED_MODELS: MODEL,
  DAILY_TOKEN_QUOTA: '0',
  MONTHLY_TOKEN_QUOTA: '0',
  RATE_LIMIT_PER_MINUTE: '600',
  IDLE_SECONDS: '20',
  REAP_INTERVAL_SECONDS: '5',
  MAX_BUSY_SECONDS: '90',
  BUSY_SIGNAL_SECONDS: '20',
  BUSY_CPU_PERCENT: '10',
};
const users = {};
let owned = false;

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const running = (u) => tryDocker('inspect', '-f', '{{.State.Running}}', u.container) === 'true';
const audit = () => docker('exec', GATEWAY, 'node', 'src/cli.js', 'audit', '--json', '--limit', '500').split('\n').filter(Boolean).map((l) => JSON.parse(l));

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
    tryDocker('volume', 'rm', `dsh-data-${u.id}`, `dsh-ws-${u.id}`);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  tryDocker('rm', '-f', FAKE);
  compose(FILE, ['down', '-v'], ENV);
});

test('idle stop still works, and a busy agent (CPU or model calls) keeps its sandbox with no browser attached', async () => {
  for (const name of ['cpu', 'model', 'idle']) {
    users[name] = await signupUser(name, run);
    await waitSandboxUp(users[name]);
  }
  // From here no request goes through the gateway for these users: no browser is attached.
  // CPU: a build-like load for longer than the cap. Model: a request every 5 s, as an agent loop would.
  docker('exec', '-d', users.cpu.container, 'node', '-e', 'const e=Date.now()+150000; while(Date.now()<e);');
  docker('exec', '-d', users.model.container, 'node', '-e', `
    const end = Date.now() + 150000;
    const call = () => fetch(process.env.LLM_BASE_URL + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.LLM_PROXY_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ model: ${JSON.stringify(MODEL)}, messages: [{ role: 'user', content: 'tick' }] }) }).catch(() => {});
    const t = setInterval(() => { if (Date.now() > end) process.exit(); call(); }, 5000); call();`);

  // Past the idle limit (20 s) plus a few reaps: the idle one is gone, the busy ones are not.
  await waitFor(() => !running(users.idle), { timeoutMs: 60000, what: 'the idle sandbox to be stopped' });
  await sleep(10000);
  assert.equal(running(users.cpu), true, 'the CPU-busy sandbox was kept');
  assert.equal(running(users.model), true, 'the sandbox making model calls was kept');
  const rows = audit();
  assert.ok(rows.some((r) => r.event === 'sandbox.kept_busy' && r.userId === users.cpu.id && r.detail.signal === 'cpu'), 'kept for CPU use');
  assert.ok(rows.some((r) => r.event === 'sandbox.kept_busy' && r.userId === users.model.id && r.detail.signal === 'model'), 'kept for model calls');
  assert.ok(rows.some((r) => r.event === 'sandbox.stop' && r.userId === users.idle.id && r.detail.by === 'idle'), 'the idle one was stopped as idle');
});

test('the busy cap: busy sandboxes are stopped about MAX_BUSY_SECONDS after the user was last active, and audited as busy_cap', async () => {
  await waitFor(() => !running(users.cpu) && !running(users.model), { timeoutMs: 120000, what: 'both busy sandboxes to hit the cap' });
  const rows = audit();
  for (const name of ['cpu', 'model']) {
    assert.ok(rows.some((r) => r.event === 'sandbox.stop' && r.userId === users[name].id && r.detail.by === 'busy_cap'), `${name} stopped at the cap`);
  }
});

test('a user who comes back gets their sandbox again (stopping for the cap is not a hold)', async () => {
  await waitSandboxUp(users.cpu);
  assert.equal(running(users.cpu), true);
});
