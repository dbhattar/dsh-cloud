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

const iso = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** A stack with seeded numbers; `runnerDown` makes the runner fail so its sections show as unavailable. */
async function start({ runnerDown = false } = {}) {
  const port = await new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const store = new Store(':memory:');
  const cfg = loadConfig({ PUBLIC_URL: `${base}/`, RUNNER_URL: 'http://r:1', RUNNER_SECRET: 'runner-secret-0123456789' });
  const runner = {
    diskUsage: async () => { if (runnerDown) throw new Error('runner down'); return [{ userId: 1, bytes: 3 * 1024 ** 3 }, { userId: 2, bytes: 5 * 1024 ** 2 }]; },
    info: async () => null,
    list: async () => { if (runnerDown) throw new Error('runner down'); return [{ userId: 1, running: true }, { userId: 2, running: false }]; },
  };
  const llm = {
    stats: async () => ({ days: [3, 2, 1, 0].map((n, i) => ({ day: iso(n), tokens: [1000, 0, 4000, 2500][i], requests: [4, 0, 12, 8][i], users: [1, 0, 2, 2][i] })), global: { used: 2500, limit: 10000, exhausted: false } }),
    usageAll: async () => [{ userId: 1, day: { used: 2000, limit: 2500 }, month: { used: 7000, limit: 50000 }, exhausted: false }, { userId: 2, day: { used: 500, limit: 2500 }, month: { used: 500, limit: 50000 }, exhausted: false }],
    activity: async () => ({ users: [] }),
  };
  const manager = new SandboxManager({ runner, cfg, log: () => {}, llm });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  store.createUser('boss@example.com', hashPassword(PW));
  store.createUser('plain@example.com', hashPassword(PW));
  store.setAdmin('boss@example.com', true);
  store.addAudit({ event: 'admin.grant', userId: 1, detail: { via: 'cli' } });
  store.addAudit({ event: 'sandbox.start', userId: 1, detail: { resumed: true, ms: 3200 } });
  store.addAudit({ event: 'sandbox.refused', userId: 2, detail: { reason: 'capacity' } });
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
    await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();
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

test('the overview shows the seeded numbers, the chart gives the day on hover, and the table view has every number', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start();
  try {
    const page = await g.signIn('boss@example.com');
    await page.goto(`${g.base}/gw/admin`);
    const tile = (label) => page.locator('div', { hasText: new RegExp(`^${label}`) }).last();
    await page.getByText('Updated ').waitFor({ timeout: 10000 });
    const text = await page.locator('main').innerText();
    assert.match(text, /Users\s+2/);
    assert.match(text, /Running now\s+1 \/ 20|Running now\s+1/);
    assert.match(text, /Tokens today\s+2\.5K/);
    assert.match(text, /Storage\s+3\.0 GB/);
    assert.match(text, /Time to ready\s+3\.2 s/);
    assert.match(text, /7,500 tokens this month/);
    assert.match(text, /Shared daily budget: 2,500 of 10,000/);
    assert.match(text, /boss@example\.com\s+2,000 \/ 2\.5K tokens/, 'top users are named');
    assert.match(text, /Close to an allowance[\s\S]*boss@example\.com\s+80% of the day's allowance/);
    assert.match(text, /Refused \(why\)\s+capacity 1/);
    assert.match(text, /Workspace runner: ok/);
    assert.match(text, /median of 1 start in 7 days/, 'singular when there is one');
    assert.match(text, /Gateway data disk: unavailable/, 'a disk is not "not responding"');
    // The chart: one image with a summary, a day's numbers on hover, and a table with the same data.
    const chart = page.getByRole('img', { name: /Model tokens per day, last 4 days/ });
    await chart.waitFor();
    await page.locator('svg g[aria-label*="4,000 tokens"]').hover();
    assert.match(await page.getByRole('status').filter({ hasText: '4,000 tokens' }).innerText(), /4,000 tokens · 12 requests · 2 users/);
    await page.getByRole('button', { name: 'Show as table' }).click();
    const rows = await page.locator('table').first().innerText();
    assert.match(rows, /4,000\s+12\s+2/);
    await page.getByRole('button', { name: 'Show chart' }).click();
    await page.screenshot({ path: process.env.ADMIN_SHOT || '/tmp/admin-overview.png', fullPage: true });
    await page.context().close();
  } finally { g.close(); }
});

test('a source that is down is marked unavailable for its part and the rest of the overview still shows', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start({ runnerDown: true });
  try {
    const page = await g.signIn('boss@example.com');
    await page.goto(`${g.base}/gw/admin`);
    await page.getByText('Updated ').waitFor({ timeout: 10000 });
    const text = await page.locator('main').innerText();
    assert.match(text, /Unavailable right now \(runner down\)/);
    assert.match(text, /Workspace runner: not responding \(runner down\)/);
    assert.match(text, /Users\s+2/, 'the parts that work still show');
    assert.match(text, /Tokens today\s+2\.5K/);
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
