// Phase 3 acceptance: LLM proxy with per-user metering and quotas (infra/docker-compose.gateway.yml).
// A fake provider stands in for the model API so the tests control usage numbers and can see exactly what
// the provider receives. Quota is shortened to 100 tokens/day; the fake charges 30 tokens per call.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoDevData, compose, request, sh, signupUser, waitFor, waitSandboxUp } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const REAL_KEY = `sk-real-${randomBytes(16).toString('hex')}`;
const ADMIN = randomBytes(16).toString('hex');
const MODEL = 'test/model';
const GATEWAY = 'dshcloud-gateway-1';
const PROXY = 'dshcloud-llm-proxy-1';
const FAKE = 'fake-llm';
const ENV = {
  ALLOW_SIGNUP: 'true', // the suites create accounts without invite codes
  UPSTREAM_API_KEY: REAL_KEY,
  UPSTREAM_BASE_URL: `http://${FAKE}:9000/v1`,
  LLM_ADMIN_SECRET: ADMIN,
  RUNNER_SECRET: randomBytes(16).toString('hex'),
  DEFAULT_MODEL: MODEL,
  ALLOWED_MODELS: MODEL,
  DAILY_TOKEN_QUOTA: '100',
  MONTHLY_TOKEN_QUOTA: '0',
  RATE_LIMIT_PER_MINUTE: '600',
};
const users = {};
let fakeUrl;

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const msg = (content) => JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }] });

/** Run a request from inside a sandbox container, the way the agent would: its own env, its own network. */
function fromSandbox(container, { path = '/chat/completions', url, method = 'POST', body, token = 'env' } = {}) {
  const script = `
    const [url, method, token, body] = process.argv.slice(1);
    const auth = token === 'env' ? 'Bearer ' + process.env.LLM_PROXY_TOKEN : token === 'none' ? undefined : 'Bearer ' + token;
    fetch(url === 'env' ? process.env.LLM_BASE_URL + ${JSON.stringify(path)} : url, { method, headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' }, body: body || undefined })
      .then(async (r) => console.log(JSON.stringify({ status: r.status, retryAfter: r.headers.get('retry-after'), text: await r.text() })))
      .catch((e) => console.log(JSON.stringify({ status: 0, text: String(e) })));`;
  const out = docker('exec', container, 'node', '-e', script, url ?? 'env', method, token, body ?? '');
  return JSON.parse(out);
}
const chatFrom = (u, content = 'hello', extra = {}) => fromSandbox(u.container, { body: msg(content), ...extra });
const providerCalls = async () => (await fetch(`${fakeUrl}/__calls`)).json();
const usageOf = async (u) => JSON.parse((await request('/gw/api/usage', { headers: { cookie: u.cookie } })).body);

// Cleanup runs only once the guard has passed: `after` also runs when `before` throws.
let owned = false;

before(async () => {
  assertNoDevData();
  owned = true;
  try {
    docker('rm', '-f', FAKE);
  } catch {}
  compose(FILE, ['up', '-d', '--build'], ENV);
  // The fake provider joins the compose network (where llm-proxy lives; sandboxes are never on it) under the name llm-proxy resolves.
  docker('run', '-d', '--name', FAKE, '--network', 'dsh-sandboxes', '-e', `REAL_KEY=${REAL_KEY}`, '-p', '127.0.0.1::9000',
    '-v', `${join(dirname(fileURLToPath(import.meta.url)), 'fake-upstream.mjs')}:/app/fake-upstream.mjs:ro`, 'node:24-slim', 'node', '/app/fake-upstream.mjs');
  fakeUrl = `http://${docker('port', FAKE, '9000').split('\n')[0]}`;
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
  await waitFor(async () => (await fetch(`${fakeUrl}/__calls`)).ok, { what: 'fake provider' });
  users.a = await signupUser('a', run);
  users.b = await signupUser('b', run);
  await Promise.all([waitSandboxUp(users.a), waitSandboxUp(users.b)]);
});

after(() => {
  if (!owned) return;
  for (const u of Object.values(users)) {
    try {
      docker('rm', '-f', u.container);
      docker('volume', 'rm', `dsh-data-${u.id}`, `dsh-ws-${u.id}`);
      docker('network', 'rm', `dsh-net-${u.id}`);
    } catch {}
  }
  try {
    docker('rm', '-f', FAKE);
  } catch {}
  compose(FILE, ['down', '-v'], ENV);
});

test('the real provider key is nowhere in the gateway or any sandbox: env, inspect output, filesystem', () => {
  // Positive control first: the check below would pass vacuously if it could not see the key where it lives.
  assert.ok(docker('inspect', PROXY).includes(REAL_KEY), 'control: llm-proxy is configured with the real key');
  assert.ok(docker('exec', PROXY, 'env').includes(REAL_KEY), 'control: the key is visible in the proxy env');

  assert.ok(!docker('inspect', GATEWAY).includes(REAL_KEY), 'gateway container never receives the key');
  assert.ok(!docker('exec', GATEWAY, 'env').includes(REAL_KEY));
  for (const u of Object.values(users)) {
    assert.ok(!docker('inspect', u.container).includes(REAL_KEY), `inspect ${u.container}`);
    assert.ok(!docker('exec', u.container, 'env').includes(REAL_KEY), `env ${u.container}`);
    assert.ok(!docker('exec', u.container, 'sh', '-c', 'cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n"').includes(REAL_KEY), `process environments in ${u.container}`);
    let hits = '';
    try {
      hits = docker('exec', u.container, 'grep', '-rIslF', REAL_KEY, '/', '--exclude-dir=proc', '--exclude-dir=sys', '--exclude-dir=dev', '--exclude-dir=opt', '--exclude-dir=usr', '--exclude-dir=lib');
    } catch (e) {
      // Exit 1 = no match. Exit 2 = no match but some paths were unreadable (it happens under gVisor); a hit would have
      // printed its file name, which is what is asserted below.
      assert.ok([1, 2].includes(e.status), `grep failed unexpectedly: ${e.message}`);
      hits = String(e.stdout ?? '').trim();
    }
    assert.equal(hits, '', `key found in files of ${u.container}: ${hits}`);
  }
});

test('sandboxes hold a per-user proxy token and the harness is configured to use the proxy', () => {
  const tokens = Object.values(users).map((u) => {
    const env = docker('exec', u.container, 'env').split('\n');
    const token = env.find((e) => e.startsWith('LLM_PROXY_TOKEN='))?.slice('LLM_PROXY_TOKEN='.length);
    assert.match(token, /^dshu_[\w-]{40,}$/);
    assert.ok(env.includes('LLM_BASE_URL=http://llm-proxy:8081/v1'));
    const patch = docker('exec', u.container, 'cat', '/tmp/dsh-cloud-patch.yml');
    assert.match(patch, /apiKeyEnv: LLM_PROXY_TOKEN/);
    assert.match(patch, /baseURL: "http:\/\/llm-proxy:8081\/v1"/);
    assert.ok(!patch.includes(token), 'the harness config references the variable, not the value');
    return token;
  });
  assert.notEqual(tokens[0], tokens[1], 'every user has their own token');
});

test('the proxy is not reachable from outside the sandbox network', async () => {
  assert.equal(docker('port', PROXY), '', 'no published ports');
  const r = await request('/v1/chat/completions', { method: 'POST', body: msg('hi') });
  assert.equal(r.status, 401, 'port 443 serves the gateway, which wants a session');
  assert.equal(JSON.parse(r.body).error, 'unauthenticated');
  assert.equal((await request('/admin/usage/1', { headers: { authorization: `Bearer ${ADMIN}` } })).status, 401);
});

test('a model call from the sandbox reaches the provider with the real key, never the user token', async () => {
  const before = (await providerCalls()).length;
  const r = chatFrom(users.a);
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(r.text).choices[0].message.content, 'hello');
  const calls = await providerCalls();
  assert.equal(calls.length, before + 1);
  const call = calls.at(-1);
  assert.deepEqual([call.authOk, call.authLooksLikeUserToken, call.model], [true, false, MODEL]);
  assert.ok(call.maxTokens > 0, 'output cap applied');
  assert.ok(!r.text.includes(REAL_KEY));
  const models = fromSandbox(users.a.container, { path: '/models', method: 'GET' });
  assert.equal(models.status, 200);
  assert.deepEqual(JSON.parse(models.text).data.map((m) => m.id), [MODEL]);
});

test('streaming works end to end and is metered', async () => {
  const r = chatFrom(users.b, 'stream please', {
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'stream please' }] }),
  });
  assert.equal(r.status, 200);
  assert.match(r.text, /"content":"hel"/);
  assert.match(r.text, /"content":"lo"/);
  assert.match(r.text, /\[DONE\]/);
  const call = (await providerCalls()).at(-1);
  assert.deepEqual([call.stream, call.includeUsage], [true, true]);
});

test('usage is attributed to the calling user only and shown through the gateway', async () => {
  const [a, b] = [await usageOf(users.a), await usageOf(users.b)];
  assert.equal(a.userId, users.a.id);
  assert.equal(a.day.used, 30);
  assert.equal(a.day.limit, 100);
  assert.equal(a.month.limit, null, '0 means unlimited');
  assert.equal(b.userId, users.b.id);
  assert.equal(b.day.used, 30, 'streaming usage came from the provider final chunk');
  assert.equal(a.exhausted, false);
  assert.equal((await request('/gw/api/usage')).status, 401, 'usage needs a session');
});

test('an exhausted quota stops that user\'s model calls (no provider request) and no one else\'s', async () => {
  const a = users.a;
  for (const total of [60, 90, 120]) assert.equal(chatFrom(a).status, 200, `call reaching ${total}`);
  const used = (await usageOf(a)).day.used;
  assert.equal(used, 120);
  const callsBefore = (await providerCalls()).length;
  const blocked = chatFrom(a);
  assert.equal(blocked.status, 429);
  const err = JSON.parse(blocked.text).error;
  assert.equal(err.code, 'quota_exceeded');
  assert.match(err.message, /daily token allowance \(120 of 100\)/);
  assert.ok(Number(blocked.retryAfter) > 0);
  assert.equal((await providerCalls()).length, callsBefore, 'provider was not called');
  assert.equal((await usageOf(a)).day.used, 120, 'blocked calls cost nothing');
  const status = await usageOf(a);
  assert.deepEqual([status.exhausted, status.blockedBy], [true, 'day']);

  assert.equal(chatFrom(users.b).status, 200, 'user B is unaffected');
  assert.equal((await usageOf(users.b)).day.used, 60);
  assert.equal((await usageOf(users.b)).exhausted, false);
});

test('model allowlist and tokens: a sandbox cannot use other models, admin routes, or another identity', async () => {
  const b = users.b;
  const other = chatFrom(b, 'x', { body: JSON.stringify({ model: 'expensive/model', messages: [] }) });
  assert.equal(other.status, 400);
  assert.equal(JSON.parse(other.text).error.code, 'model_not_allowed');

  const proxy = 'http://llm-proxy:8081';
  const ownToken = (url, method = 'GET', body = '') => fromSandbox(b.container, { url, method, body });
  // The network listener has no admin routes at all (the admin API is a unix socket), so 404 whatever the credential.
  assert.equal(ownToken(`${proxy}/admin/usage/${users.a.id}`).status, 404, 'a user token is not an admin credential');
  assert.equal(ownToken(`${proxy}/admin/usage`).status, 404);
  assert.equal(ownToken(`${proxy}/admin/tokens`, 'POST', JSON.stringify({ userId: users.a.id })).status, 404, 'cannot mint tokens');
  assert.equal(fromSandbox(b.container, { url: `${proxy}/admin/usage/1`, token: 'none' }).status, 404);
  assert.equal(fromSandbox(b.container, { url: `${proxy}/admin/usage/1`, token: 'guess' }).status, 404);
  assert.equal(fromSandbox(b.container, { url: `${proxy}/admin/usage/1`, token: ADMIN }).status, 404, 'even the real admin secret gets nothing here');
  assert.equal(fromSandbox(b.container, { token: 'none', body: msg('x') }).status, 401, 'no token, no model');
  assert.equal(fromSandbox(b.container, { token: 'dshu_forged', body: msg('x') }).status, 401);
});

test('usage and tokens survive an llm-proxy restart', async () => {
  const before = (await usageOf(users.a)).day.used;
  docker('restart', PROXY);
  await waitFor(() => docker('inspect', '-f', '{{.State.Health.Status}}', PROXY) === 'healthy', { timeoutMs: 60000, what: 'proxy healthy' });
  assert.equal((await usageOf(users.a)).day.used, before);
  assert.equal(chatFrom(users.a).status, 429, 'A is still blocked');
  assert.equal(chatFrom(users.b).status, 200, 'B\'s token still valid');
});

test('revoking a token cuts off model access; recreating the sandbox restores it with a new token and the same data', async () => {
  const b = users.b;
  docker('exec', b.container, 'sh', '-c', 'echo keep > /workspace/marker');
  const oldToken = docker('exec', b.container, 'printenv', 'LLM_PROXY_TOKEN');
  const revoke = docker('exec', GATEWAY, 'node', '-e',
    `require('http').request({ socketPath: process.env.LLM_ADMIN_SOCKET, path: '/admin/tokens/${b.id}', method: 'DELETE', headers: { authorization: 'Bearer ' + process.env.LLM_ADMIN_SECRET } }, (r) => { r.resume(); console.log(r.statusCode); }).end()`);
  assert.equal(revoke, '204');
  const calls = (await providerCalls()).length;
  const refused = chatFrom(b);
  assert.equal(refused.status, 401);
  assert.equal(JSON.parse(refused.text).error.code, 'invalid_api_key');
  assert.equal((await providerCalls()).length, calls, 'revoked token never reaches the provider');

  // Removing the container makes the gateway create a new one (new token) on the next visit; volumes persist.
  docker('rm', '-f', b.container);
  await waitSandboxUp(b);
  const newToken = docker('exec', b.container, 'printenv', 'LLM_PROXY_TOKEN');
  assert.notEqual(newToken, oldToken);
  assert.equal(docker('exec', b.container, 'cat', '/workspace/marker'), 'keep');
  assert.equal(chatFrom(b).status, 200);
  assert.equal(fromSandbox(b.container, { token: oldToken, body: msg('x') }).status, 401, 'the old token stays dead');
});

test('the gateway recreates a pre-proxy sandbox that could hold the real key', async () => {
  // Simulate an upgrade: a container from before metering, carrying the real key in its env and no proxy label.
  const a = users.a;
  docker('rm', '-f', a.container);
  docker('create', '--name', a.container, '--label', `dsh-cloud.user=${a.id}`, '--network', `dsh-net-${a.id}`,
    '-e', `OPENROUTER_API_KEY=${REAL_KEY}`, '-e', 'DSH_PUBLIC_URL=https://localhost/', '-e', 'DSH_TRUSTED_HOST=localhost',
    '-v', `dsh-data-${a.id}:/data/dsh`, '-v', `dsh-ws-${a.id}:/workspace`, 'dsh-sandbox:latest');
  assert.ok(docker('inspect', a.container).includes(REAL_KEY), 'control: the legacy container exposes the key');
  await waitSandboxUp(a);
  assert.ok(!docker('inspect', a.container).includes(REAL_KEY), 'replacement has no real key');
  assert.ok(!docker('exec', a.container, 'env').includes(REAL_KEY));
  assert.match(docker('exec', a.container, 'printenv', 'LLM_PROXY_TOKEN'), /^dshu_/);
  assert.equal((await usageOf(a)).day.used, 120, 'usage history is kept (keyed by user, not token)');
});
