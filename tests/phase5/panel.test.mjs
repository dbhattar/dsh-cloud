// P5-3 on a live stack: the usage and limits panel gets real numbers and early warnings, and its Stop and Restart buttons work.
// Limits are set so every warning is reachable at once: a 15 minute run limit, a 10 MB storage limit, a 1,000 token daily allowance.
// API checks always run; the page checks run when Playwright and Chromium are found (tests/ui/browser.mjs).
// Needs Docker. Under gVisor: DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, removeUserVolumes, request, sh, signupUser, sleep, waitFor, waitSandboxUp } from '../lib/helpers.mjs';
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
  MAX_RUN_SECONDS: '900',
  MAX_DISK_MB: '10',
  DISK_CHECK_SECONDS: '300',
  MAX_BUSY_SECONDS: '0',
  DAILY_TOKEN_QUOTA: '1000',
  MONTHLY_TOKEN_QUOTA: '0',
  GLOBAL_DAILY_TOKEN_BUDGET: '0',
};
/** These tests are about the limits panel, not the first-visit welcome (welcome.test.mjs): dismiss it, or its dialog covers the chip. */
const welcomed = async (u) => { await request('/gw/api/welcome', { method: 'POST', headers: { cookie: u.cookie, origin: 'https://localhost' } }); return u; };
const users = {};
let owned = false;
let browser = null;
let browserWhy = '';

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const running = (u) => tryDocker('inspect', '-f', '{{.State.Running}}', u.container) === 'true';
const startedAt = (u) => tryDocker('inspect', '-f', '{{.State.StartedAt}}', u.container);
const get = async (u, path) => JSON.parse((await request(path, { headers: { cookie: u.cookie } })).body);
const limits = (u) => get(u, '/gw/api/limits');
const status = (u) => get(u, '/gw/api/status');
const post = (u, path) => request(path, { method: 'POST', headers: { cookie: u.cookie } });
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
  users.a = await welcomed(await signupUser('a', run));
  await post(users.a, '/gw/api/start');
  await waitSandboxUp(users.a);
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

test('limits: real numbers for tokens, storage and time left, and no warnings while everything is comfortable', async () => {
  const l = await limits(users.a);
  assert.equal(l.workspace.state, 'running');
  assert.equal(l.tokens.day.limit, 1000);
  assert.equal(l.tokens.day.used, 0);
  assert.equal(l.storage.limitBytes, 10 * 1024 * 1024);
  assert.ok(l.storage.usedBytes >= 0);
  assert.equal(l.run.maxSeconds, 900);
  assert.ok(l.run.secondsLeft <= 900 && l.run.secondsLeft > 700, `run seconds left: ${l.run.secondsLeft}`);
  assert.equal(l.problem, null);
  assert.equal(l.warnings.some((w) => w.code.startsWith('tokens') || w.code.startsWith('storage')), false);
  assert.equal(l.warnings.some((w) => w.code === 'run_time_low'), true, 'the 15 minute run limit means the run warning is already due');
  assert.equal(l.tokens.global, null);
});

test('warnings appear as the limits near: tokens at 85%, storage at 85%', async () => {
  addUsage(users.a.id, 850);
  docker('exec', users.a.container, 'sh', '-c', 'head -c 8900000 /dev/urandom > /workspace/data.bin');
  // Storage sizes are cached for a minute and Docker computes them on demand: wait for it to show up.
  const l = await waitFor(async () => { const x = await limits(users.a); return x.storage.usedBytes > 8 * 1024 * 1024 ? x : null; }, { timeoutMs: 120000, everyMs: 3000, what: 'storage to show 8+ MB' });
  const codes = l.warnings.map((w) => w.code);
  assert.ok(codes.includes('tokens_day_high'), codes.join());
  assert.ok(codes.includes('storage_high'), codes.join());
  assert.match(l.warnings.find((w) => w.code === 'storage_high').title, /Your storage is 8\d% full/);
  assert.equal(l.problem, null, 'not exhausted, so a warning and not a problem');
  assert.ok(l.warnings.every((w) => w.title && w.message && !/undefined|null/.test(w.message)));
});

test('the page: the chip opens a panel with meters, warnings and Restart and Stop', async (t) => {
  if (!browser) return t.skip(`no browser (${browserWhy})`);
  const page = await signIn(browser, users.a.email, 'test-password-123');
  await waitForText(page, /model allowance|storage is/i, { timeoutMs: 60000 }); // the banner shows the most urgent warning
  await clickButton(page, /Today/);
  const text = await waitForText(page, /Model tokens today/);
  for (const expected of [/Model tokens this month/, /Storage/, /This run/, /Restart workspace/, /Stop workspace/, /850 \/ 1K|850 \/ 1,000/]) assert.match(text, expected);
  assert.match(text, /left/, 'time left in this run');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Usage and limits' }).count(), 0, 'Escape closes the panel');
  await page.context().close();
});

test('Restart: asks twice, then stops and starts the workspace again, and the page comes back', async (t) => {
  const before = startedAt(users.a);
  if (browser) {
    const page = await signIn(browser, users.a.email, 'test-password-123');
    await clickButton(page, /Today/);
    await clickButton(page, 'Restart workspace');
    await waitForText(page, /Click again to restart/); // armed, nothing has happened yet
    assert.equal(startedAt(users.a), before, 'the first click did nothing');
    await clickButton(page, 'Click again to restart');
    await waitFor(() => startedAt(users.a) !== before && running(users.a), { timeoutMs: 120000, what: 'the container to start again' });
    await waitForText(page, /New Session|Workspace|Choose workspace/, { timeoutMs: 120000 }); // the app is back
    await page.context().close();
  } else {
    assert.equal((await post(users.a, '/gw/api/restart')).status, 202);
    await waitFor(() => startedAt(users.a) !== before && running(users.a), { timeoutMs: 120000, what: 'the container to start again' });
    await waitSandboxUp(users.a);
  }
  assert.equal(await tryDocker('exec', users.a.container, 'sh', '-c', 'test -s /workspace/data.bin && echo kept'), 'kept', 'files survive a restart');
});

test('Stop: the workspace stays stopped, says so, and Start brings it back', async (t) => {
  if (browser) {
    const page = await signIn(browser, users.a.email, 'test-password-123');
    await clickButton(page, /Today/);
    await clickButton(page, 'Stop workspace');
    await clickButton(page, 'Click again to stop');
    await waitForText(page, /Your workspace is stopped/, { timeoutMs: 60000 });
    await waitFor(() => !running(users.a), { timeoutMs: 60000, what: 'the container to stop' });
    await sleep(12000); // the open page keeps asking; none of it may wake the workspace
    assert.equal(running(users.a), false, 'a stopped workspace is not woken by the open page');
    assert.equal((await status(users.a)).problem.code, 'stopped_user');
    await clickButton(page, 'Start my workspace');
    await waitForText(page, /New Session|Workspace|Choose workspace/, { timeoutMs: 120000 });
    await page.context().close();
  } else {
    await post(users.a, '/gw/api/stop?hold=1');
    await waitFor(() => !running(users.a), { timeoutMs: 60000, what: 'the container to stop' });
    await request('/', { headers: { cookie: users.a.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
    await sleep(8000);
    assert.equal(running(users.a), false);
    assert.equal((await status(users.a)).problem.code, 'stopped_user');
    await post(users.a, '/gw/api/start');
    await waitSandboxUp(users.a);
  }
  assert.equal(running(users.a), true);
});

test('visiting the app again ends a stop the user asked for: a new page load wakes the workspace', async () => {
  await post(users.a, '/gw/api/stop?hold=1');
  await waitFor(() => !running(users.a), { timeoutMs: 60000, what: 'the container to stop' });
  assert.equal((await status(users.a)).state, 'error');
  // the app shell is a top-level navigation; the workspace frame it loads then wakes the workspace
  await request('/', { headers: { cookie: users.a.cookie, accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.notEqual((await status(users.a)).problem?.code, 'stopped_user', 'the hold is gone');
  await waitSandboxUp(users.a);
  assert.equal(running(users.a), true);
});
