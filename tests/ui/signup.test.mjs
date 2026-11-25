// P5-7 in a real browser: the invite link, Show password, and being sent back to the page you wanted. Runs a gateway in this
// process on a local port (no Docker), and is skipped when Playwright or Chromium cannot be found (tests/ui/browser.mjs).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createGateway } from '../../gateway/src/server.js';
import { loadBrowser } from './browser.mjs';

const PASSWORD = 'a-long-password-1';
let browser = null;
let why = '';
let server;
let store;
let base;

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

before(async () => {
  const b = await loadBrowser();
  if (!b.available) { why = b.why; return; }
  browser = await b.launch();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  store = new Store(':memory:');
  const cfg = loadConfig({ PUBLIC_URL: `${base}/`, RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' });
  const manager = { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: () => Promise.resolve(), status: () => ({ state: 'stopped' }), limits: async () => ({ workspace: { state: 'stopped' }, tokens: null, storage: null, run: null, problem: null, warnings: [] }) };
  server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); server.close(); }
});

const newPage = async () => (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();

test('an invite link opens the sign-up form, filled in and welcoming; creating the account lands on the page asked for', async (t) => {
  if (!browser) return t.skip(why);
  const code = store.createInvite();
  const page = await newPage();
  await page.goto(`${base}/gw/signup?invite=${encodeURIComponent(code)}&next=${encodeURIComponent('/projects/42?tab=files')}`);
  await page.getByText('You have been invited').waitFor();
  assert.equal(await page.getByLabel('Invite code').inputValue(), code, 'the code is already in the field');
  assert.equal(await page.getByRole('heading', { name: 'Create your account' }).count() > 0, true);
  const signUp = page.getByRole('form', { name: 'Create account' });
  await signUp.getByLabel('Email').fill('new.user@example.com');
  await signUp.getByLabel('Password').fill(PASSWORD);
  await Promise.all([page.waitForURL((u) => u.pathname === '/projects/42', { timeout: 15000 }), signUp.getByRole('button', { name: 'Create account' }).click()]);
  assert.equal(new URL(page.url()).search, '?tab=files', 'back to the page that was asked for, not the home page');
  assert.ok(store.userByEmail('new.user@example.com'));
  await page.context().close();
});

test('a used invite link says so plainly and keeps the code; a wrong code on submit explains itself and keeps the email', async (t) => {
  if (!browser) return t.skip(why);
  const used = store.createInvite();
  store.createUserWithInvite('someone@example.com', 'x', used);
  const page = await newPage();
  await page.goto(`${base}/gw/signup?invite=${encodeURIComponent(used)}`);
  await page.getByText(/already been used/).waitFor();
  assert.equal(await page.getByText('You have been invited').count(), 0, 'no welcome for a code that cannot be used');
  const signUp = page.getByRole('form', { name: 'Create account' });
  await signUp.getByLabel('Invite code').fill('inv_wrong-code');
  await signUp.getByLabel('Email').fill('typed.email@example.com');
  await signUp.getByLabel('Password').fill(PASSWORD);
  await signUp.getByRole('button', { name: 'Create account' }).click();
  await page.getByText(/not valid.*typos/).waitFor();
  assert.equal(await page.getByRole('form', { name: 'Create account' }).getByLabel('Email').inputValue(), 'typed.email@example.com', 'the email survived the failed submit');
  assert.equal(await page.getByRole('form', { name: 'Create account' }).getByLabel('Password').inputValue(), '', 'the password did not');
  await page.context().close();
});

test('Show and Hide reveal the password, and the sign-in page is usable by keyboard', async (t) => {
  if (!browser) return t.skip(why);
  const page = await newPage();
  await page.goto(`${base}/gw/login`);
  const form = page.getByRole('form', { name: 'Sign in' });
  const password = form.getByLabel('Password');
  await password.fill('secret-value-123');
  assert.equal(await password.getAttribute('type'), 'password');
  await form.getByRole('button', { name: /Show/ }).click();
  assert.equal(await password.getAttribute('type'), 'text');
  assert.equal(await password.inputValue(), 'secret-value-123', 'what was typed is kept');
  await form.getByRole('button', { name: /Hide/ }).click();
  assert.equal(await password.getAttribute('type'), 'password');
  // by keyboard: the email field has focus on load, Tab reaches the password, then the Show button, and Enter activates it
  await page.reload();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'email', 'the email field is focused on load');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'password');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Show password');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('form', { name: 'Sign in' }).getByLabel('Password').getAttribute('type'), 'text');
  await page.context().close();
});

test('visiting a page while signed out, then signing in, returns to that page', async (t) => {
  if (!browser) return t.skip(why);
  store.createUser('returning@example.com', (await import('../../gateway/src/auth.js')).hashPassword(PASSWORD));
  const page = await newPage();
  await page.goto(`${base}/reports/2026?view=full`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((u) => u.pathname === '/gw/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/reports/2026?view=full');
  const form = page.getByRole('form', { name: 'Sign in' });
  await form.getByLabel('Email').fill('returning@example.com');
  await form.getByLabel('Password').fill(PASSWORD);
  await Promise.all([page.waitForURL((u) => u.pathname === '/reports/2026', { timeout: 15000 }), form.getByRole('button', { name: 'Sign in' }).click()]);
  assert.equal(new URL(page.url()).search, '?view=full');
  await page.context().close();
});
