// The service shows its own icon, not the DeepSeek whale or wordmark. Needs the pages built (cd gateway/web && npm run build). No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createGateway } from '../../gateway/src/server.js';
import { appShellPage, loginPage } from '../../gateway/src/pages.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };

async function serve() {
  const server = createGateway({ cfg: loadConfig(base), store: new Store(':memory:'), manager: { touch() {}, ready: async () => null, ensure: () => Promise.resolve(), status: () => ({}) }, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('the three icons are served as PNG files, publicly, with a short cache because their names are not hashed', async () => {
  const { server, url } = await serve();
  try {
    for (const name of ['brand-icon.png', 'favicon-32.png', 'apple-touch-icon.png']) {
      const res = await fetch(`${url}/gw/assets/${name}`);
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600', `${name} must not be cached for a year under an unhashed name`);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG', name);
    }
    // the built script keeps its year-long cache
    const js = readdirSync(join(ROOT, 'gateway/web/dist')).find((n) => n.endsWith('.js'));
    assert.match((await fetch(`${url}/gw/assets/${js}`)).headers.get('cache-control'), /immutable/);
    // nothing else of that kind is served
    assert.equal((await fetch(`${url}/gw/assets/nope.png`)).status, 404);
    assert.equal((await fetch(`${url}/gw/assets/..%2Fpackage.json`)).status, 404);
  } finally { server.close(); }
});

test('the pages carry the service name and icon links, and no DeepSeek name', () => {
  for (const html of [loginPage({}), appShellPage({ email: 'a@b.com', src: '/x' })]) {
    assert.match(html, /<link rel="icon"[^>]*favicon-32\.png/);
    assert.match(html, /<link rel="apple-touch-icon"[^>]*apple-touch-icon\.png/);
    assert.doesNotMatch(html, /deepseek/i);
  }
  assert.match(appShellPage({ email: 'a@b.com', src: '/x' }), /<title>dsh-cloud<\/title>/);
});

test('no DeepSeek mark remains in the page code: no wordmark artwork, no whale, no brand name (colour token names in CSS are not branding)', () => {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))); };
  walk(join(ROOT, 'gateway/web/src'));
  const code = files.filter((f) => /\.(tsx?|html)$/.test(f));
  assert.ok(code.length > 5, 'found the page code');
  for (const f of code) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /deepseek|whale/i, `${f} names DeepSeek or draws the whale`);
    assert.doesNotMatch(text, /<path d="M[\d.]+ /, `${f} contains vector artwork`);
  }
});

test('the sandbox patch switches the official brand plugin off, so the sidebar and home whales are not shown', () => {
  const sh = readFileSync(join(ROOT, 'sandbox/entrypoint.sh'), 'utf8');
  assert.match(sh, /echo "- id: ui-brand-official"\n\s*echo "  disabled: true"/);
});
