// P5-6 in a real browser, without the harness: the welcome text and the curation of the harness page. The welcome sentences and the
// curation module are TypeScript in gateway/web; Node strips the types so the same code runs here and in the page.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';
import { loadBrowser } from './browser.mjs';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../gateway/web/src/${p}`, import.meta.url)), 'utf8');
const strip = (p) => stripTypeScriptTypes(read(p));
const textModule = strip('pages/welcome-text.ts');
const curateModule = strip('curate.ts');

let browser = null;
let why = '';
before(async () => {
  const b = await loadBrowser();
  if (b.available) browser = await b.launch(); else why = b.why;
});
after(async () => { await browser?.close(); });

/** Evaluate a stripped module in the page and return its exports as window.<ns>. */
const load = (page, ns, source) => page.evaluate(`window.${ns} = (() => { const exports = {}; ${source.replace(/export (async )?function /g, '$1function ').replace(/export interface [^;]*;?/g, '')} return { ${[...source.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]).join(', ')} }; })()`);

test('welcome sentences: only the limits that are set are mentioned, in plain words', async (t) => {
  if (!browser) return t.skip(why);
  const page = await (await browser.newContext()).newPage();
  await load(page, 'W', textModule);
  const r = await page.evaluate(() => ({
    all: W.limitsSentence({ idleSeconds: 1800, maxBusySeconds: 7200, maxRunSeconds: 28800, maxDiskMb: 2048 }, { day: { limit: 500000 }, month: { limit: 5000000 } }),
    none: W.limitsSentence({ idleSeconds: 0, maxBusySeconds: 0, maxRunSeconds: 0, maxDiskMb: 0 }, { day: { limit: null }, month: { limit: null } }),
    some: W.limitsSentence({ idleSeconds: 0, maxBusySeconds: 0, maxRunSeconds: 0, maxDiskMb: 512 }, null),
    pause: W.pauseSentence({ idleSeconds: 1800, maxBusySeconds: 7200, maxRunSeconds: 0, maxDiskMb: 0 }),
    pauseNoBusy: W.pauseSentence({ idleSeconds: 600, maxBusySeconds: 0, maxRunSeconds: 0, maxDiskMb: 0 }),
    pauseOff: W.pauseSentence({ idleSeconds: 0, maxBusySeconds: 0, maxRunSeconds: 0, maxDiskMb: 0 }),
  }));
  assert.equal(r.all, 'Your account has model use of 500,000 tokens a day (5,000,000 a month), 2 GB of storage and up to 8 hours of running time at a stretch.');
  assert.equal(r.none, 'There are no usage limits on your account at the moment.');
  assert.equal(r.some, 'Your account has 512 MB of storage.');
  assert.match(r.pause, /pauses after 30 minutes without activity, or after up to 2 hours if the agent is still busy working, and starts again when you come back/);
  assert.ok(!/busy/.test(r.pauseNoBusy));
  assert.equal(r.pauseOff, 'Your files, sessions and settings are kept between visits.');
  for (const s of Object.values(r)) assert.ok(!/undefined|NaN|null/.test(s), s);
  await page.context().close();
});

const MOCK = `
<div class="a1_brand"><span class="a1_localBuildBrand"><span class="a1_localBuildTitle">DSH Local Build</span><span class="a1_buildVersion">0.2.2-rc.5-2e39e70</span></span></div>
<div class="b2_titleGroup"><span>Into the Unknown</span><span class="b2_previewBadge">Preview</span></div>
<div class="c3_panelRow"><span>Plugins</span></div>`;

test('curation: the build label is renamed, the build id and Preview badge are hidden, the headline is friendlier, the rest is untouched', async (t) => {
  if (!browser) return t.skip(why);
  const page = await (await browser.newContext()).newPage();
  await page.setContent(`<!doctype html><html><head></head><body>${MOCK}</body></html>`);
  await load(page, 'C', curateModule);
  await page.evaluate(() => C.curate(document, { workspaceName: 'Workspace', headline: 'What would you like to build?' }));
  const visible = () => page.evaluate(() => document.body.innerText);
  let text = await visible();
  assert.match(text, /Workspace/);
  assert.match(text, /What would you like to build\?/);
  assert.match(text, /Plugins/, 'everything else is untouched');
  for (const gone of [/DSH Local Build/, /0\.2\.2-rc/, /Preview/, /Into the Unknown/]) assert.doesNotMatch(text, gone);
  // the harness re-renders: new nodes appear and are curated too, and the observer does not loop
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div class="b2_titleGroup"><span>Into the Unknown</span><span class="b2_previewBadge">Preview</span></div><span class="a1_localBuildTitle">DSH Local Build</span>'); });
  await page.waitForTimeout(150);
  text = await visible();
  assert.doesNotMatch(text, /Into the Unknown|DSH Local Build|Preview/);
  assert.equal((await page.evaluate(() => document.querySelectorAll('#gw-curation').length)), 1);
  await page.evaluate(() => C.curate(document, { workspaceName: 'Other', headline: 'x' }));
  assert.equal((await page.evaluate(() => document.querySelectorAll('#gw-curation').length)), 1, 'applying twice does not stack');
  assert.match(await visible(), /Workspace/, 'the first curation stays in force');
  // a headline the user's session already changed is not overwritten
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div class="b2_titleGroup"><span>My project</span></div>'); });
  await page.waitForTimeout(100);
  assert.match(await visible(), /My project/);
  await page.context().close();
});

// ---- the welcome screen in the app shell, against a gateway started in this process ----
test('welcome: shown once to a new user with the real limits, closes with Got it, stays away on reload, and can be reopened', async (t) => {
  if (!browser) return t.skip(why);
  const port = await new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const store = new Store(':memory:');
  const cfg = loadConfig({ PUBLIC_URL: `${base}/`, RUNNER_URL: 'http://r:1', RUNNER_SECRET: 'runner-secret-0123456789', IDLE_SECONDS: '1800', MAX_BUSY_SECONDS: '7200', MAX_RUN_SECONDS: '28800', MAX_DISK_MB: '2048', WORKSPACE_NAME: 'Workspace' });
  const manager = new SandboxManager({ runner: { diskUsage: async () => [], info: async () => null, list: async () => [] }, cfg, log: () => {} });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    store.createUser('new@example.com', hashPassword('a-long-password-1'));
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
    await page.goto(`${base}/gw/login`);
    await page.getByRole('form', { name: 'Sign in' }).getByLabel('Email').fill('new@example.com');
    await page.getByRole('form', { name: 'Sign in' }).getByLabel('Password').fill('a-long-password-1');
    await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.getByRole('form', { name: 'Sign in' }).getByRole('button', { name: 'Sign in' }).click()]);
    const dialog = page.getByRole('dialog', { name: 'Welcome to your workspace' });
    await dialog.waitFor({ timeout: 15000 });
    const text = await dialog.innerText();
    assert.match(text, /private workspace with an AI coding agent/);
    assert.match(text, /pauses after 30 minutes without activity, or after up to 2 hours/);
    assert.match(text, /2 GB of storage/);
    assert.match(text, /8 hours of running time/);
    assert.match(text, /Getting your work out/);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Got it', 'focus starts on the button');
    await dialog.getByRole('button', { name: 'Got it' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.reload();
    await page.getByRole('button', { name: /Usage/ }).waitFor({ timeout: 15000 });
    assert.equal(await page.getByRole('dialog', { name: 'Welcome to your workspace' }).count(), 0, 'not shown again');
    assert.notEqual(store.welcomedAt(1), null, 'the server remembers it');
    await page.getByRole('button', { name: /Usage/ }).click();
    await page.getByRole('button', { name: 'About this workspace' }).click();
    await page.getByRole('dialog', { name: 'Welcome to your workspace' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Welcome to your workspace' }).waitFor({ state: 'detached' });
    await page.context().close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- the first load of the workspace frame: the case where the frame's first page reuses its initial window ----
test('curation applies to the harness page on the frame\'s first load, not only after a reload', async (t) => {
  if (!browser) return t.skip(why);
  const http = await import('node:http');
  // A stand-in for the harness that serves a page with the labels the harness uses.
  const harness = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>DSH Local Build</title></head><body>
    <span class="a1_localBuildTitle">DSH Local Build</span><span class="a1_buildVersion">0.2.2-rc.5-2e39e70</span>
    <div class="b2_titleGroup"><span>Into the Unknown</span><span class="b2_previewBadge">Preview</span></div><p>Plugins</p></body></html>`));
  await new Promise((r) => harness.listen(0, '127.0.0.1', r));
  const port = await new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const store = new Store(':memory:');
  const cfg = loadConfig({ PUBLIC_URL: `${base}/`, RUNNER_URL: 'http://r:1', RUNNER_SECRET: 'runner-secret-0123456789', WORKSPACE_NAME: 'Studio' });
  // The sandbox is already running, so the very first thing the frame loads is the harness itself.
  const manager = { touch() {}, releaseUserHold() {}, ready: async () => ({ host: '127.0.0.1', port: harness.address().port, cookie: 'k=v' }), ensure: async () => ({}), status: () => ({}), limits: async () => ({ workspace: { state: 'running' }, tokens: null, storage: null, run: null, problem: null, warnings: [] }) };
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const uid = store.createUser('first@example.com', hashPassword('a-long-password-1'));
    store.markWelcomed(uid);
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    await context.addCookies([{ name: 'gw_session', value: store.createSession(uid, 600), url: base }]);
    const page = await context.newPage();
    await page.goto(`${base}/`);
    const frame = page.frameLocator('iframe[title="DeepSeek Harness"]');
    await frame.getByText('Plugins').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    const text = await frame.locator('body').innerText();
    assert.match(text, /Studio/, 'renamed to the configured name');
    assert.match(text, /What would you like to build\?/);
    for (const gone of [/DSH Local Build/, /0\.2\.2-rc/, /Preview/, /Into the Unknown/]) assert.doesNotMatch(text, gone);
    await context.close();
  } finally {
    server.closeAllConnections(); server.close(); harness.closeAllConnections(); harness.close();
  }
});
