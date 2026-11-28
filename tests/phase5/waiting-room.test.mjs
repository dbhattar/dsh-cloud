// P5-9 on a live stack: with one place and it taken, a second user waits in line, sees their place on the page the user sees,
// and is started by themselves when the first stops, with no click. Needs Docker. Under gVisor:
//   DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5
// This suite deletes data (it starts the real compose project and removes its volumes): see tests/README.md before running it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, removeUserVolumes, request, sh, signupUser, waitFor } from '../lib/helpers.mjs';
import { loadBrowser, signIn, waitForText } from '../ui/browser.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  UPSTREAM_API_KEY: 'phase5-placeholder', // required by the stack; nothing here calls a model
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
  MAX_RUNNING_SANDBOXES: '1',
  EVICT_AFTER_IDLE_SECONDS: '99999', // never evict: the second user has to wait
  WAIT_QUEUE_SECONDS: '300',
  WAIT_POLL_MS: '1000',
  IDLE_SECONDS: '100000',
  REAP_INTERVAL_SECONDS: '5',
  DAILY_TOKEN_QUOTA: '0',
  MONTHLY_TOKEN_QUOTA: '0',
  GLOBAL_DAILY_TOKEN_BUDGET: '0',
};
const users = {};
let owned = false;
let browser = null;
let browserWhy = '';

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const status = async (u) => JSON.parse((await request('/gw/api/status', { headers: { cookie: u.cookie } })).body);
const post = (u, path) => request(path, { method: 'POST', headers: { cookie: u.cookie, origin: 'https://localhost' } });
const audit = (event) => tryDocker('exec', '-u', 'node', 'dshcloud-gateway-1', 'node', 'src/cli.js', 'audit', '--event', event, '--since', '1h', '--json').split('\n').filter(Boolean).map((l) => JSON.parse(l));

before(async () => {
  assertNoDevData();
  owned = true;
  const b = await loadBrowser();
  if (b.available) browser = await b.launch(); else browserWhy = b.why;
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
});

after(async () => {
  await browser?.close();
  if (!owned) return;
  for (const u of Object.values(users)) {
    tryDocker('rm', '-f', u.container);
    removeUserVolumes(u.id);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  compose(FILE, ['down', '-v'], ENV);
});

test('full: the second user is put in line, told their place, and not shown a refusal', async () => {
  users.a = await signupUser('a', run);
  users.b = await signupUser('b', run);
  await post(users.a, '/gw/api/start');
  // Running, not merely answering: the launching page also answers 200 while the user is still waiting for a place.
  await waitFor(async () => (await status(users.a)).state === 'running', { timeoutMs: 150000, what: 'a running' });
  await post(users.b, '/gw/api/start');
  const s = await waitFor(async () => { const j = await status(users.b); return j.queue ? j : null; }, { timeoutMs: 60000, what: 'a place in line for b' });
  assert.equal(s.state, 'starting');
  assert.equal(s.problem, null, 'not an error');
  assert.equal(s.queue.position, 1);
  assert.equal(s.queue.total, 1);
  assert.equal(s.queue.maxSeconds, 300);
  if (browser) {
    const page = await signIn(browser, users.b.email, 'test-password-123');
    const text = await waitForText(page, /Waiting for a place/, { timeoutMs: 30000 });
    assert.match(text, /number 1 of 1 in line/);
    assert.match(text, /starts by itself/);
    assert.ok(!/busy right now/i.test(text), 'no refusal');
    await page.context().close();
  } else console.log(`note: no browser checks (${browserWhy})`);
});

test('a place frees: the user in line is started by itself, with no click, and the audit trail says queued then dequeued', async () => {
  await post(users.a, '/gw/api/stop'); // a leaves
  const s = await waitFor(async () => { const j = await status(users.b); return j.state === 'running' ? j : null; }, { timeoutMs: 120000, what: 'b started by itself' });
  assert.equal(s.queue, null);
  assert.equal(tryDocker('inspect', '-f', '{{.State.Running}}', users.b.container), 'true');
  const events = [...audit('sandbox.queued'), ...audit('sandbox.dequeued')].filter((r) => r.userId === users.b.id).map((r) => r.event);
  assert.deepEqual(events.sort(), ['sandbox.dequeued', 'sandbox.queued']);
});
