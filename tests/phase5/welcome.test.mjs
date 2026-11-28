// P5-6 on a live stack with the real harness: a new user gets the welcome once, and the harness page is curated (no "DSH Local Build"
// or build id, no Preview badge, a friendlier headline and model name, no Automation tasks entry) while Plugins and More stay.
// Needs Docker and a browser (Playwright and Chromium, see tests/ui/browser.mjs); the browser checks are skipped without one.
// Under gVisor: DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase5
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, removeUserVolumes, request, sh, signupUser, waitFor, waitSandboxUp } from '../lib/helpers.mjs';
import { allText, loadBrowser, signIn, waitForText } from '../ui/browser.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  UPSTREAM_API_KEY: 'phase5-placeholder',
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
  WORKSPACE_NAME: 'Workspace',
};
const users = {};
let owned = false;
let browser = null;
let browserWhy = '';

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };

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

test('the harness is configured, not just styled: the patch names the model and switches Automation tasks off', () => {
  const patch = docker('exec', users.a.container, 'cat', '/tmp/dsh-cloud-patch.yml');
  assert.match(patch, /- id: ui-schedule\n  disabled: true/);
  assert.match(patch, /- id: "openrouter\/free"\n\s+name: "Free models \(automatic\)"/);
});

test('/gw/api/me starts as not welcomed, and the limits payload carries the policy the welcome quotes', async () => {
  const me = JSON.parse((await request('/gw/api/me', { headers: { cookie: users.a.cookie } })).body);
  assert.equal(me.welcomed, false);
  const l = JSON.parse((await request('/gw/api/limits', { headers: { cookie: users.a.cookie } })).body);
  assert.ok(l.policy.idleSeconds > 0 && l.policy.maxRunSeconds > 0 && l.policy.maxDiskMb > 0, JSON.stringify(l.policy));
});

test('the page: welcome once, then the curated harness', async (t) => {
  if (!browser) return t.skip(`no browser (${browserWhy})`);
  const page = await signIn(browser, users.a.email, 'test-password-123');
  const dialog = page.getByRole('dialog', { name: 'Welcome to your workspace' });
  await dialog.waitFor({ timeout: 60000 });
  assert.match(await dialog.innerText(), /Limits/);
  await dialog.getByRole('button', { name: 'Got it' }).click();
  await waitForText(page, /New Session/, { timeoutMs: 120000 });
  await waitForText(page, /What would you like to build\?/, { timeoutMs: 60000 }); // the headline is swapped once the hero renders
  const text = await allText(page);
  for (const gone of [/DSH Local Build/, /\d+\.\d+\.\d+-/, /\bPreview\b/, /Into the Unknown/, /Automation tasks/, /Free Models Router/]) {
    assert.doesNotMatch(text, gone, `still visible: ${gone}`);
  }
  for (const kept of [/Workspace/, /Plugins/, /More/, /Free models \(automatic\)/, /Default workspace/]) assert.match(text, kept);
  // not shown again, on this device or any other: the server remembers it
  await page.reload();
  await waitForText(page, /New Session/, { timeoutMs: 120000 });
  assert.equal(await page.getByRole('dialog', { name: 'Welcome to your workspace' }).count(), 0);
  const me = JSON.parse((await request('/gw/api/me', { headers: { cookie: users.a.cookie } })).body);
  assert.equal(me.welcomed, true);
  await page.context().close();
});
