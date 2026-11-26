// P5-11 in a real browser, against a gateway started in this process (no Docker, no harness): an admin sees the Admin link in the
// workspace bar and the panel, an ordinary user sees neither and gets "not found" at the panel's address, and the panel cannot be
// shown inside another page. Skipped without Playwright (tests/ui/browser.mjs).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';
import { loadBrowser } from './browser.mjs';

let browser = null;
let why = '';
before(async () => {
  const b = await loadBrowser();
  if (b.available) browser = await b.launch(); else why = b.why;
});
after(async () => { await browser?.close(); });

const PW = 'a-long-password-1';

async function start() {
  const port = await new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const store = new Store(':memory:');
  const cfg = loadConfig({ PUBLIC_URL: `${base}/`, RUNNER_URL: 'http://r:1', RUNNER_SECRET: 'runner-secret-0123456789' });
  const manager = new SandboxManager({ runner: { diskUsage: async () => [], info: async () => null, list: async () => [] }, cfg, log: () => {} });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  store.createUser('boss@example.com', hashPassword(PW));
  store.createUser('plain@example.com', hashPassword(PW));
  store.setAdmin('boss@example.com', true);
  store.addAudit({ event: 'admin.grant', userId: 1, detail: { via: 'cli' } });
  const signIn = async (email) => {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
    await page.goto(`${base}/gw/login`);
    const form = page.getByRole('form', { name: 'Sign in' });
    await form.getByLabel('Email').fill(email);
    await form.getByLabel('Password').fill(PW);
    await Promise.all([page.waitForURL((u) => u.pathname === '/'), form.getByRole('button', { name: 'Sign in' }).click()]);
    await page.getByRole('button', { name: 'Got it' }).click({ timeout: 15000 }); // the welcome, shown once to a new user
    return page;
  };
  return { base, store, signIn, close: () => { server.closeAllConnections(); server.close(); } };
}

test('an admin sees the Admin link, opens the panel, sees what admins did, and goes back', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start();
  try {
    const page = await g.signIn('boss@example.com');
    const link = page.getByRole('link', { name: 'Admin', exact: true });
    await link.waitFor({ timeout: 15000 });
    await Promise.all([page.waitForURL((u) => u.pathname === '/gw/admin'), link.click()]);
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    assert.equal(await page.title(), 'Admin');
    assert.match(await page.locator('header').innerText(), /boss@example\.com/);
    const row = page.getByRole('row', { name: /admin\.grant/ });
    await row.waitFor({ timeout: 10000 });
    assert.match(await row.innerText(), /via: cli/);
    assert.match(await page.locator('main').innerText(), /cannot see the content of anyone's workspace/);
    assert.equal(await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { current: 'page' }).innerText(), 'Overview');
    await page.screenshot({ path: process.env.ADMIN_SHOT || '/tmp/admin-panel.png' });
    await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.getByRole('link', { name: 'Back to my workspace' }).click()]);
    await page.getByRole('link', { name: 'Admin', exact: true }).waitFor();
    await page.context().close();
  } finally { g.close(); }
});

test('an ordinary user sees no Admin link, and the panel address answers "not found"', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start();
  try {
    const page = await g.signIn('plain@example.com');
    await page.getByRole('button', { name: /Usage/ }).waitFor({ timeout: 15000 }).catch(() => {});
    assert.equal(await page.getByRole('link', { name: 'Admin', exact: true }).count(), 0);
    const res = await page.goto(`${g.base}/gw/admin`);
    assert.equal(res.status(), 404);
    assert.equal(await page.locator('body').innerText(), 'Not found');
    assert.equal(g.store.queryAudit({ event: 'admin.denied' }).length, 1);
    await page.context().close();
  } finally { g.close(); }
});

test('the panel cannot be shown inside another page', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start();
  try {
    const page = await g.signIn('boss@example.com');
    // Same-origin framing is refused too (the account shell's own frame rule would allow it for other pages).
    await page.evaluate((src) => { const f = document.createElement('iframe'); f.id = 'probe'; f.src = src; document.body.appendChild(f); }, '/gw/admin');
    await page.waitForTimeout(1500);
    const framed = await page.evaluate(() => { try { return document.getElementById('probe').contentDocument?.querySelector('#root')?.childElementCount ?? 0; } catch { return -1; } });
    assert.ok(framed <= 0, `the admin page rendered inside a frame (${framed})`);
    await page.context().close();
  } finally { g.close(); }
});
