// P5-10 on a live stack: a harness that is killed is started again at once (no browser needed), the crash is audited, the user is
// told, and a sandbox that keeps dying is held as a crash loop until the user restarts it. Needs Docker (gVisor in the Lima VM:
// DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5). The browser check is skipped without Playwright.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, request, sh, signupUser, sleep, waitFor, waitSandboxUp } from '../lib/helpers.mjs';
import { loadBrowser, signIn } from '../ui/browser.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  UPSTREAM_API_KEY: 'phase5-placeholder',
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
  WATCHDOG_SECONDS: '2',
  CRASH_MAX_RESTARTS: '2', // the third exit inside the window is a loop
};
const users = {};
let owned = false;
let browser = null;
let browserWhy = '';

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const status = async (u) => JSON.parse((await request('/gw/api/status', { headers: { cookie: u.cookie } })).body);
const startedAt = (u) => tryDocker('inspect', '-f', '{{.State.StartedAt}}', u.container);
const audit = (u, event) => tryDocker('exec', 'dshcloud-gateway-1', 'node', 'src/cli.js', 'audit', '--user', String(u.id), '--event', event, '--json');

/** Kill the harness (the container's main process) the way a crash does, and wait for the next start to be up. */
async function crashAndWaitRestart(u) {
  const before = startedAt(u);
  docker('kill', u.container);
  await waitFor(() => startedAt(u) !== before && tryDocker('inspect', '-f', '{{.State.Status}}', u.container) === 'running', { timeoutMs: 60000, what: 'automatic restart' });
  await waitSandboxUp(u);
}

before(async () => {
  assertNoDevData();
  owned = true;
  const b = await loadBrowser();
  if (b.available) browser = await b.launch(); else browserWhy = b.why;
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
  users.a = await signupUser('a', run);
  await request('/gw/api/start', { method: 'POST', headers: { cookie: users.a.cookie } });
  await waitSandboxUp(users.a);
  users.b = await signupUser('b', run); // a user whose sandbox is left alone
  await request('/gw/api/start', { method: 'POST', headers: { cookie: users.b.cookie } });
  await waitSandboxUp(users.b);
});

after(async () => {
  await browser?.close();
  if (!owned) return;
  for (const u of Object.values(users)) {
    tryDocker('rm', '-f', u.container);
    tryDocker('volume', 'rm', `dsh-data-${u.id}`, `dsh-ws-${u.id}`);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  compose(FILE, ['down', '-v'], ENV);
});

test('a killed harness is started again with no browser open, the exit is audited, and a neighbour is untouched', async () => {
  const neighbour = startedAt(users.b);
  docker('exec', users.a.container, 'sh', '-c', 'echo kept > /workspace/crash-marker');
  await crashAndWaitRestart(users.a);
  assert.equal(docker('exec', users.a.container, 'cat', '/workspace/crash-marker'), 'kept', 'files survive');
  assert.match(audit(users.a, 'sandbox.crashed'), /"exitCode":137/);
  assert.match(audit(users.a, 'sandbox.auto_restart'), /sandbox\.auto_restart/);
  assert.equal(startedAt(users.b), neighbour, 'the other user was not restarted');
});

test('the user is told it happened, in the limits payload', async () => {
  const l = JSON.parse((await request('/gw/api/limits', { headers: { cookie: users.a.cookie } })).body);
  assert.equal(l.warnings[0].code, 'restarted_after_crash', JSON.stringify(l.warnings));
  assert.match(l.warnings[0].message, /send your message again/);
});

test('in a browser the workspace comes back by itself with the notice shown', async (t) => {
  if (!browser) return t.skip(`no browser (${browserWhy})`);
  const page = await signIn(browser, users.a.email, 'test-password-123');
  await page.getByRole('button', { name: 'Got it' }).click({ timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((f) => f.contentDocument?.body?.innerText.includes('Workspace')), null, { timeout: 90000 });
  const before = startedAt(users.a);
  docker('kill', users.a.container);
  await waitFor(() => startedAt(users.a) !== before, { timeoutMs: 60000, what: 'restart under an open page' });
  const banner = page.locator('[data-problem="restarted_after_crash"]');
  await banner.waitFor({ timeout: 90000 });
  assert.match(await banner.innerText(), /stopped unexpectedly and was restarted/);
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((f) => f.contentDocument?.body?.innerText.includes('What would you like to build')), null, { timeout: 90000 });
});

test('a sandbox that keeps dying is held as a crash loop, the page says so, and Restart brings it back', async () => {
  const u = users.a;
  // Earlier tests used two exits; one more is within the window of CRASH_MAX_RESTARTS=2 restarts, so this exit is a loop at most.
  for (let i = 0; i < 4 && (await status(u)).problem?.code !== 'crash_loop'; i++) {
    await waitSandboxUp(u).catch(() => {});
    docker('kill', u.container);
    await sleep(6000);
  }
  await waitFor(async () => (await status(u)).problem?.code === 'crash_loop', { timeoutMs: 60000, what: 'crash_loop state' });
  const s = await status(u);
  assert.equal(s.problem.title, 'Your workspace keeps stopping');
  assert.equal(s.problem.action.kind, 'restart');
  assert.equal(tryDocker('inspect', '-f', '{{.State.Status}}', u.container), 'exited', 'no automatic restart after the loop is detected');
  assert.match(audit(u, 'sandbox.crash_loop'), /sandbox\.crash_loop/);
  const r = await request('/gw/api/restart', { method: 'POST', headers: { cookie: u.cookie } });
  assert.ok([200, 202].includes(r.status), String(r.status));
  await waitSandboxUp(u);
  assert.equal((await status(u)).problem, null);
});
