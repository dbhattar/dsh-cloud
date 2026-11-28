// P5-9 in a real browser: what a person in line sees on the launching page, and that it changes in place as their place moves.
// The gateway runs in this process with a fake sandbox manager whose status we control; no Docker.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { STAGES } from '../../gateway/src/sandbox.js';
import { problemFor } from '../../gateway/src/states.js';
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

test('in line: the page says so, with the place, the time waited and the limit, and updates as the place moves; at the limit it shows the busy state', async (t) => {
  if (!browser) return t.skip(why);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cfg = loadConfig({ PUBLIC_URL: `${base}/`, RUNNER_URL: 'http://r:1', RUNNER_SECRET: 'runner-secret-0123456789' });
  const store = new Store(':memory:');
  let snapshot = { state: 'starting', stages: STAGES, stage: 1, resumed: false, elapsedMs: 5000, error: undefined, problem: null, notice: null, queue: { position: 3, total: 4, waitedSeconds: 75, maxSeconds: 600 } };
  const manager = { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: async () => ({}), status: () => snapshot, limits: async () => null };
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const uid = store.createUser('wait@example.com', hashPassword('a-long-password-1'));
    store.markWelcomed(uid);
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await context.addCookies([{ name: 'gw_session', value: store.createSession(uid, 600), url: base }]);
    const page = await context.newPage();
    await page.goto(`${base}/`);
    const frame = page.frameLocator('iframe[title="Workspace"]');
    await frame.getByRole('heading', { name: 'Waiting for a place' }).waitFor({ timeout: 15000 });
    const text = await frame.locator('body').innerText();
    assert.match(text, /You are number 3 of 4 in line/);
    assert.match(text, /starts by itself as soon as a place is free/);
    assert.match(text, /Waiting 1 min 15 s · we stop waiting after 10 min/);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/waiting.png` }); // for looking at; not part of the assertions
    // the place moves
    snapshot = { ...snapshot, queue: { position: 1, total: 4, waitedSeconds: 130, maxSeconds: 600 } };
    await frame.getByText(/You are number 1 of 4 in line/).waitFor({ timeout: 10000 });
    assert.match(await frame.locator('body').innerText(), /Waiting 2 min 10 s/);
    // the wait ran out: the usual busy state, now saying how long
    snapshot = { ...snapshot, state: 'error', queue: null, error: 'the service is at capacity right now; try again in a few minutes', problem: problemFor('capacity', { waitedSeconds: 600 }) };
    await frame.getByRole('heading', { name: 'The service is busy right now' }).waitFor({ timeout: 10000 });
    assert.match(await frame.locator('body').innerText(), /none opened in the 10 minutes you waited/);
    await frame.getByRole('button', { name: 'Try again' }).waitFor();
    await context.close();
  } finally { server.closeAllConnections(); server.close(); }
});
