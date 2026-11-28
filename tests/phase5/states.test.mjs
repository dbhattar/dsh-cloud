// P5-2 on a live stack: every refusal or stop reaches the user as a designed state (code, plain title, action), through the
// status API and, when Playwright is available, on the page the user sees. Limits are shortened so each state can be
// reached in a minute or two: one running sandbox, 90 s run time, 1 MB disk, tiny quota and budget, 30 s idle.
// Needs Docker. Under gVisor: DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, request, sh, signupUser, sleep, waitFor, waitSandboxUp } from '../lib/helpers.mjs';
import { clickButton, loadBrowser, signIn, waitForText } from '../ui/browser.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const PROXY = 'dshcloud-llm-proxy-1';
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  UPSTREAM_API_KEY: 'phase5-placeholder',
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
  MAX_RUNNING_SANDBOXES: '1',
  EVICT_AFTER_IDLE_SECONDS: '99999', // never evict: the second user must be refused
  WAIT_QUEUE_SECONDS: '0', // and not queued either: this suite tests the refusal (the waiting room is tests/phase5/waiting-room.test.mjs)
  MAX_RUN_SECONDS: '90', // longer than the idle limit, so the idle scenario can be reached before the run-time one
  MAX_DISK_MB: '1',
  DISK_CHECK_SECONDS: '15',
  IDLE_SECONDS: '30',
  MAX_BUSY_SECONDS: '0', // plain idle stop
  REAP_INTERVAL_SECONDS: '5',
  DAILY_TOKEN_QUOTA: '1000',
  MONTHLY_TOKEN_QUOTA: '0',
  GLOBAL_DAILY_TOKEN_BUDGET: '0',
};
const users = {};
let owned = false;
let browser = null;
let browserWhy = '';
let keepAlive = null; // stands in for an open tab on a's workspace, so the idle limit does not take its slot

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const running = (u) => tryDocker('inspect', '-f', '{{.State.Running}}', u.container) === 'true';
const status = async (u) => JSON.parse((await request('/gw/api/status', { headers: { cookie: u.cookie } })).body);
const usageOf = async (u) => JSON.parse((await request('/gw/api/usage', { headers: { cookie: u.cookie } })).body);
const start = (u) => request('/gw/api/start', { method: 'POST', headers: { cookie: u.cookie } });
const waitProblem = (u, code, timeoutMs = 90000) => waitFor(async () => { const s = await status(u); return s.problem?.code === code ? s : null; }, { timeoutMs, what: `${code} for ${u.email}` });
/** Record usage for a user directly in the llm-proxy database, as the proxy would after model calls. */
const addUsage = (userId, tokens) => docker('exec', PROXY, 'node', '--input-type=module', '-e', `
  import { DatabaseSync } from 'node:sqlite';
  const d = new DatabaseSync('/data/llm-proxy.db');
  d.prepare('INSERT INTO usage (user_id, day, input_tokens, output_tokens, requests) VALUES (?, ?, ?, 0, 1) ON CONFLICT(user_id, day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens')
    .run(${userId}, new Date().toISOString().slice(0, 10), ${tokens});`);

before(async () => {
  assertNoDevData();
  owned = true;
  const b = await loadBrowser();
  if (b.available) browser = await b.launch(); else browserWhy = b.why;
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
});

after(async () => {
  clearInterval(keepAlive);
  await browser?.close();
  if (!owned) return;
  for (const u of Object.values(users)) {
    tryDocker('rm', '-f', u.container);
    tryDocker('volume', 'rm', `dsh-data-${u.id}`, `dsh-ws-${u.id}`);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  compose(FILE, ['down', '-v'], ENV);
});

test('capacity: a second user is told the service is busy, with a retry action, and the raw message stays in the details', async () => {
  users.a = await signupUser('a', run);
  users.b = await signupUser('b', run);
  await start(users.a);
  await waitSandboxUp(users.a);
  keepAlive = setInterval(() => { request('/', { headers: { cookie: users.a.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } }).catch(() => {}); }, 5000); // a browser tab being open
  await start(users.b);
  const s = await waitProblem(users.b, 'capacity', 60000);
  assert.equal(s.state, 'error');
  assert.equal(s.problem.title, 'The service is busy right now');
  assert.equal(s.problem.action.kind, 'retry');
  assert.match(s.error, /at capacity/, 'the technical message is kept for the details');
  if (browser) {
    const page = await signIn(browser, users.b.email, 'test-password-123');
    const text = await waitForText(page, /The service is busy right now/);
    assert.match(text, /Try again/);
    assert.ok(!/at capacity right now; try again in a few/.test(text.split('Technical details')[0]), 'the raw message is not the main text');
    await page.context().close();
  } else console.log(`note: no browser checks (${browserWhy})`);
});

test('run-time limit: the stopped workspace explains itself, and the button brings it back', async () => {
  const s = await waitProblem(users.a, 'stopped_run_time', 120000);
  assert.equal(s.problem.title, 'Your workspace reached its time limit');
  assert.match(s.problem.message, /2 minutes at a time/, 'the limit is stated in words');
  assert.equal(s.problem.action.kind, 'restart');
  if (browser) {
    const page = await signIn(browser, users.a.email, 'test-password-123');
    await waitForText(page, /Your workspace reached its time limit/);
    await clickButton(page, 'Start my workspace');
    await waitForText(page, /New Session|Workspace|Choose workspace/, { timeoutMs: 90000 }); // the app is back
    await page.context().close();
  } else {
    await start(users.a);
    await waitSandboxUp(users.a);
  }
  assert.equal(running(users.a), true);
});

test('disk limit: an over-limit workspace is stopped with its numbers in plain words', async () => {
  docker('exec', users.a.container, 'sh', '-c', 'head -c 3000000 /dev/urandom > /workspace/big.bin');
  const s = await waitProblem(users.a, 'stopped_disk', 120000);
  assert.equal(s.problem.title, 'Your workspace is over its storage limit');
  assert.match(s.problem.message, /MB of the 1 MB you can store/);
  assert.match(s.problem.message, /checked about every 1 minute/);
  assert.equal(s.problem.action.kind, 'restart');
  docker('exec', 'dshcloud-gateway-1', 'true'); // the stack is still healthy
});

test('model access: a spent daily allowance, then a spent shared budget, show as the right banner and the budget wins', async () => {
  // Clear the disk stop first so the workspace itself is fine; these states are about the model.
  clearInterval(keepAlive); // a is stopped by now; later tests need its slot
  tryDocker('exec', users.a.container, 'rm', '-f', '/workspace/big.bin');
  const before = await usageOf(users.a);
  assert.equal(before.problem, null);
  addUsage(users.a.id, 1500);
  let u = await usageOf(users.a);
  assert.equal(u.problem.code, 'quota_day');
  assert.match(u.problem.message, /1,500 of 1,000 tokens today/);
  // the shared budget: switch it on (the proxy reads its environment at start)
  compose(FILE, ['up', '-d', '--no-deps', 'llm-proxy'], { ...ENV, GLOBAL_DAILY_TOKEN_BUDGET: '1200' });
  await waitFor(async () => (await usageOf(users.a)).global?.exhausted === true, { timeoutMs: 60000, what: 'budget exhausted' });
  u = await usageOf(users.a);
  assert.equal(u.problem.code, 'budget', 'the shared budget takes priority over the personal quota');
  assert.equal(u.global.used, undefined, 'the shared totals are not exposed to a user');
  assert.equal(u.global.limit, undefined);
  if (browser) {
    // Start the workspace again (explicitly) and look at the app shell.
    await start(users.a);
    await waitSandboxUp(users.a).catch(() => {});
    const page = await signIn(browser, users.a.email, 'test-password-123');
    await waitForText(page, /daily model budget is used up/, { timeoutMs: 60000 });
    await page.context().close();
  }
});

test('an unrequested stop is explained when the user comes back', async () => {
  users.c = await signupUser('c', run);
  // capacity is 1, so free the slot first by stopping a's workspace the way a user would
  await request('/gw/api/stop', { method: 'POST', headers: { cookie: users.a.cookie } });
  await start(users.c);
  await waitSandboxUp(users.c);
  // no browser from here: the idle limit (45 s) stops it
  await waitFor(() => !running(users.c), { timeoutMs: 120000, what: 'idle stop' });
  const s = await status(users.c);
  assert.equal(s.state, 'stopped');
  assert.equal(s.notice.code, 'resumed_idle');
  assert.match(s.notice.message, /paused after 1 minute without activity.*files and sessions are kept/);
  assert.equal(s.problem, null, 'an idle stop is not an error');
});
