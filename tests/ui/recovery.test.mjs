// P5-8 in a real browser: "Forgot your password?" through to signing in with the new one, using the outbox provider (messages as files),
// and the admin invite form with the email box. The gateway runs in this process; no Docker, no network.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createGateway } from '../../gateway/src/server.js';
import { loadBrowser } from './browser.mjs';

let browser = null;
let why = '';
before(async () => {
  const b = await loadBrowser();
  if (b.available) browser = await b.launch(); else why = b.why;
});
after(async () => { await browser?.close(); });

const freePort = () => new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
const manager = { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: async () => ({}), status: () => ({}), limits: async () => null };

async function start(mail) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const outbox = mkdtempSync(join(tmpdir(), 'outbox-'));
  const cfg = loadConfig({ PUBLIC_URL: `${base}/`, RUNNER_URL: 'http://r:1', RUNNER_SECRET: 'runner-secret-0123456789', ...(mail ? { MAIL_PROVIDER: 'outbox', MAIL_OUTBOX_DIR: outbox, MAIL_FROM: 'dsh-cloud <noreply@mg.example.com>' } : {}) });
  const store = new Store(':memory:');
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const messages = () => readdirSync(outbox).map((f) => readFileSync(join(outbox, f), 'utf8'));
  return { base, store, server, messages, close: () => { server.closeAllConnections(); server.close(); } };
}

test('forgot password: ask, read the message, choose a new password, sign in with it', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start(true);
  try {
    g.store.createUser('ann@example.com', hashPassword('old-password-123'));
    const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
    await page.goto(`${g.base}/gw/login`);
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.getByRole('form', { name: 'Reset your password' }).getByLabel('Email').fill('ann@example.com');
    await page.getByRole('button', { name: 'Send the link' }).click();
    await page.getByRole('heading', { name: 'Check your email' }).waitFor();
    assert.match(await page.locator('body').innerText(), /If an account exists for that address/);
    await page.waitForTimeout(300); // delivery is in the background
    const [message] = g.messages();
    assert.match(message, /^To: ann@example\.com\nSubject: Reset your dsh-cloud password/);
    const link = /(http:\/\/\S+\/gw\/reset\?token=[\w-]+)/.exec(message)[1];
    await page.goto(link);
    const form = page.getByRole('form', { name: 'Choose a new password' });
    await form.getByLabel('New password', { exact: true }).fill('brand-new-password-456');
    await form.getByLabel('New password again').fill('brand-new-password-4567');
    await form.getByRole('button', { name: 'Change password' }).click();
    await page.getByText(/not the same/).waitFor(); // a typo is explained, and the form is still there
    await form.getByLabel('New password', { exact: true }).fill('brand-new-password-456');
    await form.getByLabel('New password again').fill('brand-new-password-456');
    await form.getByRole('button', { name: 'Change password' }).click();
    await page.waitForURL((u) => u.pathname === '/gw/login');
    await page.getByText(/Your password was changed/).waitFor();
    // the old password no longer works, the new one does
    const signIn = page.getByRole('form', { name: 'Sign in' });
    await signIn.getByLabel('Email').fill('ann@example.com');
    await signIn.getByLabel('Password').fill('old-password-123');
    await signIn.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Invalid email or password.').waitFor();
    await page.getByRole('form', { name: 'Sign in' }).getByLabel('Password').fill('brand-new-password-456');
    await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.getByRole('form', { name: 'Sign in' }).getByRole('button', { name: 'Sign in' }).click()]);
    // the link cannot be used again
    await page.goto(link);
    await page.getByText(/already been used/).waitFor();
    await page.context().close();
  } finally { g.close(); }
});

test('without mail the reset page says so plainly and the sign-in page does not offer it', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start(false);
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${g.base}/gw/login`);
    assert.equal(await page.getByRole('link', { name: 'Forgot your password?' }).count(), 0);
    await page.goto(`${g.base}/gw/forgot`);
    assert.match(await page.locator('body').innerText(), /not set up on this service/);
    await page.context().close();
  } finally { g.close(); }
});

test('a link that is not valid says so and offers a new one; the opt-out page asks before it does anything', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start(true);
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${g.base}/gw/reset?token=not-a-real-token`);
    await page.getByRole('heading', { name: 'This link does not work' }).waitFor();
    await page.getByRole('link', { name: 'Ask for a new link' }).click();
    await page.getByRole('form', { name: 'Reset your password' }).waitFor();
    await page.goto(`${g.base}/gw/mail/stop?u=1&t=forged`);
    assert.match(await page.locator('body').innerText(), /link is incomplete or was changed/);
    await page.context().close();
  } finally { g.close(); }
});

test('admin invites: with mail on the form has an email box, and an emailed invite is sent', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start(true);
  try {
    const admin = g.store.createUser('admin@example.com', hashPassword('a-long-password-1'));
    g.store.setAdmin('admin@example.com', true);
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await context.addCookies([{ name: 'gw_session', value: g.store.createSession(admin, 600), url: g.base }]);
    const page = await context.newPage();
    await page.goto(`${g.base}/gw/admin/invites`);
    const email = page.getByLabel('Email it to (optional)');
    await email.waitFor({ timeout: 15000 });
    await email.fill('new.person@example.com');
    assert.equal(await page.getByLabel('How many').isDisabled(), true, 'one invite per address');
    await page.getByRole('button', { name: 'Create invite links' }).click();
    await page.getByText(/on its way to new\.person@example\.com/).waitFor();
    await page.waitForTimeout(300);
    assert.match(g.messages()[0], /^To: new\.person@example\.com\nSubject: You are invited to dsh-cloud/);
    await context.close();
  } finally { g.close(); }
});

test('waitlist: a visitor joins from the sign-in page and confirms; an admin invites them from the Waitlist page', async (t) => {
  if (!browser) return t.skip(why);
  const g = await start(true);
  try {
    const page = await (await browser.newContext({ viewport: { width: 900, height: 800 } })).newPage();
    await page.goto(`${g.base}/gw/login`);
    await page.getByRole('link', { name: 'Join the waitlist' }).click();
    await page.getByRole('form', { name: 'Join the waitlist' }).getByLabel('Email').fill('hopeful@example.com');
    await page.getByRole('button', { name: 'Join the waitlist' }).click();
    await page.getByRole('heading', { name: 'You are on the list' }).waitFor();
    await page.waitForTimeout(300);
    const confirm = /(http:\/\/\S+\/gw\/waitlist\/confirm\?e=\S+&t=[\w-]+)/.exec(g.messages()[0])[1];
    await page.goto(confirm);
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('heading', { name: 'Thank you' }).waitFor();
    // the admin side
    const admin = g.store.createUser('admin@example.com', hashPassword('a-long-password-1'));
    g.store.setAdmin('admin@example.com', true);
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await context.addCookies([{ name: 'gw_session', value: g.store.createSession(admin, 600), url: g.base }]);
    const ap = await context.newPage();
    await ap.goto(`${g.base}/gw/admin/waitlist`);
    await ap.getByRole('cell', { name: 'hopeful@example.com' }).waitFor({ timeout: 15000 });
    assert.match(await ap.locator('tbody tr').first().innerText(), /confirmed/);
    await ap.getByRole('button', { name: 'Invite', exact: true }).click();
    await ap.getByText(/invitation to hopeful@example.com is on its way/).waitFor();
    await ap.waitForTimeout(300);
    assert.match(g.messages().at(-1), /^To: hopeful@example\.com\nSubject: You are invited to dsh-cloud/);
    assert.match(await ap.locator('tbody tr').first().innerText(), /invited/);
    await context.close();
  } finally { g.close(); }
});
