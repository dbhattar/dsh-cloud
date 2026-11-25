// llm-proxy unit tests: the real proxy server in-process against a fake upstream. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../llm-proxy/src/config.js';
import { UsageStore } from '../../llm-proxy/src/db.js';
import { Limiter } from '../../llm-proxy/src/limits.js';
import { windows } from '../../llm-proxy/src/quota.js';
import { createProxy } from '../../llm-proxy/src/server.js';
import { SseUsageScanner, usageOf } from '../../llm-proxy/src/usage-parse.js';

const REAL_KEY = 'sk-REAL-upstream-key-do-not-leak';
const ADMIN = 'admin-secret-0123456789';
const MODEL = 'test/model';

const baseEnv = (extra = {}) => ({
  UPSTREAM_API_KEY: REAL_KEY,
  ADMIN_SECRET: ADMIN,
  ALLOWED_MODELS: MODEL,
  ...extra,
});

/** Fake provider. `behavior(req, body)` returns {status, json} | {sse: [lines]} | {hang: true}. */
async function fakeUpstream(behavior) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    calls.push({ url: req.url, auth: req.headers.authorization, body });
    const r = behavior(req, body);
    if (r.hang) return; // never answers
    if (r.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const line of r.sse) res.write(line);
      return res.end();
    }
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.json));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.closeAllConnections() || srv.close() };
}

const ok = (p = 10, c = 20) => ({ json: { id: 'x', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: p, completion_tokens: c } } });

async function harness({ env = {}, upstream = () => ok(), now } = {}) {
  const up = await fakeUpstream(upstream);
  const logs = [];
  const cfg = loadConfig(baseEnv({ UPSTREAM_BASE_URL: up.url, ...env }));
  const store = new UsageStore(':memory:');
  const { user: server, admin } = createProxy({ cfg, store, log: (m) => logs.push(m), now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sockDir = mkdtempSync(join(tmpdir(), 'llm-admin-'));
  const socketPath = join(sockDir, 'admin.sock');
  await new Promise((r) => admin.listen(socketPath, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { token, method = 'POST', body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const chat = (token, extra = {}) => call('/v1/chat/completions', { token, body: { model: MODEL, messages: [{ role: 'user', content: 'hello' }], ...extra } });
  /** Admin API: only over the unix socket. Returns a fetch-like { status, json() }. */
  const adminCall = (path, method = 'GET', body, token = ADMIN) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ socketPath, path, method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject);
      req.end(data);
    });
  return {
    up, logs, cfg, store, call, chat, adminCall, socketPath,
    close: async () => {
      server.closeAllConnections();
      admin.closeAllConnections();
      await new Promise((r) => server.close(r));
      await new Promise((r) => admin.close(r));
      rmSync(sockDir, { recursive: true, force: true });
      up.close();
    },
  };
}

test('config: refuses to start without key, admin secret or model allowlist', () => {
  assert.throws(() => loadConfig({}), /UPSTREAM_API_KEY/);
  assert.throws(() => loadConfig({ UPSTREAM_API_KEY: 'k' }), /ADMIN_SECRET/);
  assert.throws(() => loadConfig({ UPSTREAM_API_KEY: 'k', ADMIN_SECRET: 'short' }), /16/);
  assert.throws(() => loadConfig({ UPSTREAM_API_KEY: 'k', ADMIN_SECRET: ADMIN }), /ALLOWED_MODELS/);
  assert.throws(() => loadConfig(baseEnv({ DAILY_TOKEN_QUOTA: '-5' })), /DAILY_TOKEN_QUOTA/);
  const c = loadConfig(baseEnv({ UPSTREAM_BASE_URL: 'https://x.example/v1///', ALLOWED_MODELS: 'a, b' }));
  assert.equal(c.upstreamBaseUrl, 'https://x.example/v1');
  assert.deepEqual(c.allowedModels, ['a', 'b']);
});

test('store: tokens are hashed, rotation and revocation invalidate, users never share', () => {
  const s = new UsageStore(':memory:');
  const t1 = s.issueToken(1);
  const t2 = s.issueToken(2);
  assert.equal(s.userByToken(t1), 1);
  assert.equal(s.userByToken(t2), 2);
  assert.equal(s.userByToken('nope'), null);
  assert.equal(s.userByToken(null), null);
  const rows = s.db.prepare('SELECT token_hash FROM tokens').all();
  assert.ok(rows.every((r) => r.token_hash !== t1 && r.token_hash !== t2 && !r.token_hash.includes(t1)), 'plaintext never stored');
  const t1b = s.issueToken(1);
  assert.equal(s.userByToken(t1), null, 'rotation invalidates the old token');
  assert.equal(s.userByToken(t1b), 1);
  s.revoke(1);
  assert.equal(s.userByToken(t1b), null);
  assert.equal(s.userByToken(t2), 2, 'revoking one user leaves others');
  assert.notEqual(s.issueToken(1), t1b, 'reissue after revoke works');
});

test('store: usage accumulates per user and rolls over at UTC day and month boundaries', () => {
  const s = new UsageStore(':memory:');
  const d1 = Date.UTC(2026, 0, 31, 23, 59, 0);
  s.record(1, { input: 5, output: 7 }, d1);
  s.record(1, { input: 1, output: 1 }, d1);
  s.record(2, { input: 100, output: 0 }, d1);
  assert.deepEqual(s.used(1, d1), { day: 14, month: 14 });
  assert.deepEqual(s.used(2, d1), { day: 100, month: 100 });
  const d2 = Date.UTC(2026, 1, 1, 0, 1, 0); // next day, next month
  assert.deepEqual(s.used(1, d2), { day: 0, month: 0 });
  s.record(1, { input: 3, output: 0 }, d2);
  assert.deepEqual(s.used(1, d2), { day: 3, month: 3 });
  const d3 = Date.UTC(2026, 0, 31, 12, 0, 0);
  assert.deepEqual(s.used(1, d3), { day: 14, month: 14 }, 'January is untouched');
  const w = windows(d1);
  assert.equal(w.dayResetsAt, Date.UTC(2026, 1, 1));
  assert.equal(w.monthResetsAt, Date.UTC(2026, 1, 1));
  assert.equal(windows(Date.UTC(2026, 11, 31, 1)).monthResetsAt, Date.UTC(2027, 0, 1), 'December rolls into next year');
});

test('Limiter: per-minute window, concurrency cap, release, and per-user isolation', () => {
  let t = 0;
  const l = new Limiter({ perMinute: 3, maxConcurrent: 2, now: () => t });
  const a = l.acquire(1);
  const b = l.acquire(1);
  assert.ok(a.ok && b.ok);
  const c = l.acquire(1);
  assert.equal(c.reason, 'concurrency');
  assert.ok(l.acquire(2).ok, 'other user unaffected');
  a.release();
  a.release(); // idempotent
  const d = l.acquire(1);
  assert.ok(d.ok);
  d.release();
  b.release();
  const e = l.acquire(1);
  assert.equal(e.ok, false);
  assert.equal(e.reason, 'rate');
  assert.ok(e.retryAfter >= 1 && e.retryAfter <= 60);
  t = 61_000;
  assert.ok(l.acquire(1).ok, 'window slides');
});

test('usage parsing: JSON shapes and SSE across chunk boundaries', () => {
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { input: 3, output: 4 });
  assert.deepEqual(usageOf({ usage: { input_tokens: 1, output_tokens: 2 } }), { input: 1, output: 2 });
  assert.equal(usageOf({}), null);
  assert.equal(usageOf({ usage: { prompt_tokens: -1, completion_tokens: 2 } }), null);
  assert.equal(usageOf({ usage: { prompt_tokens: 'x', completion_tokens: 2 } }), null);
  const sc = new SseUsageScanner();
  const text = 'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n: keep-alive\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":11}}\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += 7) sc.feed(bytes.subarray(i, i + 7)); // split mid-line and mid-token
  sc.end();
  assert.deepEqual(sc.usage, { input: 9, output: 11 });
});

test('auth: missing, malformed, unknown, revoked and admin-secret tokens are all refused', async () => {
  const h = await harness();
  try {
    const token = h.store.issueToken(1);
    assert.equal((await h.chat(undefined)).status, 401);
    assert.equal((await h.chat('garbage')).status, 401);
    assert.equal((await h.call('/v1/chat/completions', { headers: { authorization: token }, body: {} })).status, 401, 'needs Bearer scheme');
    assert.equal((await h.chat(ADMIN)).status, 401, 'admin secret is not a user token');
    assert.equal((await h.call('/v1/models', { method: 'GET' })).status, 401);
    assert.equal((await h.chat(token)).status, 200);
    h.store.revoke(1);
    const r = await h.chat(token);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'invalid_api_key');
    assert.equal(h.up.calls.length, 1, 'refused calls never reach the provider');
  } finally {
    await h.close();
  }
});

test('passthrough swaps in the real key, drops client headers, and never leaks the key back', async () => {
  const h = await harness();
  try {
    const token = h.store.issueToken(7);
    const r = await h.chat(token, { temperature: 0.2 });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.choices[0].message.content, 'hi');
    assert.equal(h.up.calls[0].auth, `Bearer ${REAL_KEY}`);
    assert.equal(h.up.calls[0].url, '/v1/chat/completions');
    assert.equal(h.up.calls[0].body.temperature, 0.2, 'other parameters pass through');
    assert.ok(![...r.headers.values()].some((v) => v.includes(REAL_KEY)));
    // Provider errors carry through; provider credential failures are masked.
    h.up.calls.length = 0;
  } finally {
    await h.close();
  }
});

test('upstream credential rejection and outages become generic gateway errors (no upstream detail)', async () => {
  let mode = 'auth';
  const h = await harness({ upstream: () => (mode === 'auth' ? { status: 401, json: { error: { message: `bad key ${REAL_KEY}` } } } : { status: 429, json: { error: { message: 'provider busy' } } }) });
  try {
    const token = h.store.issueToken(1);
    const r = await h.chat(token);
    assert.equal(r.status, 502);
    const text = await r.text();
    assert.ok(!text.includes(REAL_KEY));
    assert.match(text, /upstream_auth_failed/);
    mode = 'busy';
    const busy = await h.chat(token);
    assert.equal(busy.status, 429, 'provider rate limits are passed through');
    assert.equal(h.store.used(1).day, 0, 'failed calls are not charged');
  } finally {
    await h.close();
  }
  const down = await harness({ env: { UPSTREAM_BASE_URL: 'http://127.0.0.1:1/v1' } });
  try {
    const token = down.store.issueToken(1);
    const r = await down.chat(token);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'upstream_unavailable');
  } finally {
    await down.close();
  }
});

test('metering: JSON usage is charged to the calling user only', async () => {
  const h = await harness({ upstream: () => ok(10, 20) });
  try {
    const a = h.store.issueToken(1);
    const b = h.store.issueToken(2);
    await (await h.chat(a)).text();
    await (await h.chat(a)).text();
    await (await h.chat(b)).text();
    assert.equal(h.store.used(1).day, 60);
    assert.equal(h.store.used(2).day, 30);
    assert.equal(h.store.used(3).day, 0);
    const line = JSON.parse(h.logs.find((l) => l.includes('"ev":"llm"')));
    assert.deepEqual([line.user, line.model, line.status, line.input, line.output, line.estimated], [1, MODEL, 200, 10, 20, false]);
  } finally {
    await h.close();
  }
});

test('streaming: SSE is forwarded unchanged, include_usage is requested, usage is charged', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n',
    'data: [DONE]\n\n',
  ];
  const h = await harness({ upstream: () => ({ sse }) });
  try {
    const token = h.store.issueToken(1);
    const r = await h.chat(token, { stream: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    assert.equal(await r.text(), sse.join(''));
    assert.equal(h.up.calls[0].body.stream_options.include_usage, true);
    assert.equal(h.store.used(1).day, 46);
  } finally {
    await h.close();
  }
});

test('missing provider usage is charged a byte-based estimate, flagged as estimated', async () => {
  const h = await harness({ upstream: () => ({ json: { choices: [{ message: { content: 'x'.repeat(400) } }] } }) });
  try {
    const token = h.store.issueToken(1);
    await (await h.chat(token)).text();
    const used = h.store.used(1).day;
    assert.ok(used > 100, `estimate should be conservative, got ${used}`);
    assert.equal(JSON.parse(h.logs.find((l) => l.includes('"ev":"llm"'))).estimated, true);
  } finally {
    await h.close();
  }
});

test('client disconnect mid-stream aborts upstream and still records usage', async () => {
  const srvCalls = [];
  const up = http.createServer((req, res) => {
    srvCalls.push(1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // never ends
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cfg = loadConfig(baseEnv({ UPSTREAM_BASE_URL: `http://127.0.0.1:${up.address().port}/v1` }));
  const store = new UsageStore(':memory:');
  const logs = [];
  const { user: server } = createProxy({ cfg, store, log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const token = store.issueToken(1);
    const ctrl = new AbortController();
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [] }),
      signal: ctrl.signal,
    });
    const reader = r.body.getReader();
    await reader.read();
    ctrl.abort();
    const deadline = Date.now() + 5000;
    while (store.used(1).day === 0 && Date.now() < deadline) await new Promise((x) => setTimeout(x, 50));
    assert.ok(store.used(1).day > 0, 'partial output is charged');
  } finally {
    server.closeAllConnections();
    up.closeAllConnections();
    server.close();
    up.close();
  }
});

test('quota: daily cap blocks with 429 before any upstream call; other users and later days are fine', async () => {
  let t = Date.UTC(2026, 5, 10, 12, 0, 0);
  const h = await harness({ env: { DAILY_TOKEN_QUOTA: '100', MONTHLY_TOKEN_QUOTA: '0' }, upstream: () => ok(10, 20), now: () => t });
  try {
    const a = h.store.issueToken(1);
    const b = h.store.issueToken(2);
    for (let i = 0; i < 4; i++) assert.equal((await h.chat(a)).status, 200, `call ${i}`); // 120 tokens
    h.up.calls.length = 0;
    const blocked = await h.chat(a);
    assert.equal(blocked.status, 429);
    const err = (await blocked.json()).error;
    assert.equal(err.code, 'quota_exceeded');
    assert.match(err.message, /daily token allowance \(120 of 100\)/);
    assert.match(err.message, /resets at 2026-06-11T00:00:00\.000Z/);
    assert.equal(Number(blocked.headers.get('retry-after')), 12 * 3600);
    assert.equal(h.up.calls.length, 0, 'no provider call once the quota is exhausted');
    assert.equal((await h.chat(b)).status, 200, 'another user is unaffected');
    t += 13 * 3600 * 1000; // next UTC day
    assert.equal((await h.chat(a)).status, 200, 'quota resets with the day');
  } finally {
    await h.close();
  }
});

test('quota: monthly cap applies across days and 0 means unlimited', async () => {
  let t = Date.UTC(2026, 5, 10, 12, 0, 0);
  const h = await harness({ env: { DAILY_TOKEN_QUOTA: '0', MONTHLY_TOKEN_QUOTA: '50' }, upstream: () => ok(10, 20), now: () => t });
  try {
    const a = h.store.issueToken(1);
    assert.equal((await h.chat(a)).status, 200);
    assert.equal((await h.chat(a)).status, 200); // 60 >= 50
    t += 24 * 3600 * 1000;
    const r = await h.chat(a);
    assert.equal(r.status, 429);
    assert.match((await r.json()).error.message, /monthly token allowance/);
    t = Date.UTC(2026, 6, 1, 0, 0, 1);
    assert.equal((await h.chat(a)).status, 200, 'new month');
  } finally {
    await h.close();
  }
  const free = await harness({ env: { DAILY_TOKEN_QUOTA: '0', MONTHLY_TOKEN_QUOTA: '0' } });
  try {
    const a = free.store.issueToken(1);
    for (let i = 0; i < 5; i++) assert.equal((await free.chat(a)).status, 200);
  } finally {
    await free.close();
  }
});

test('rate limit: 429 with Retry-After, no provider call, not charged', async () => {
  const h = await harness({ env: { RATE_LIMIT_PER_MINUTE: '2' } });
  try {
    const a = h.store.issueToken(1);
    assert.equal((await h.chat(a)).status, 200);
    assert.equal((await h.chat(a)).status, 200);
    const r = await h.chat(a);
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.code, 'rate_limited');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(h.up.calls.length, 2);
    assert.equal(h.store.used(1).day, 60);
    assert.equal((await h.chat(h.store.issueToken(2))).status, 200, 'per-user limit');
  } finally {
    await h.close();
  }
});

test('concurrency limit: extra in-flight requests are refused while others are running', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const up = http.createServer(async (req, res) => {
    for await (const _ of req);
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ok().json));
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cfg = loadConfig(baseEnv({ UPSTREAM_BASE_URL: `http://127.0.0.1:${up.address().port}/v1`, MAX_CONCURRENT: '1' }));
  const store = new UsageStore(':memory:');
  const { user: server } = createProxy({ cfg, store, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = (token) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [] }),
    });
  try {
    const token = store.issueToken(1);
    const first = call(token);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await call(token)).status, 429);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await call(token)).status, 200, 'slot freed');
  } finally {
    release();
    server.closeAllConnections();
    up.closeAllConnections();
    server.close();
    up.close();
  }
});

test('guards: model allowlist, output-token clamp, body size, invalid JSON, unknown routes', async () => {
  const h = await harness({ env: { MAX_OUTPUT_TOKENS: '1000', MAX_BODY_BYTES: '2000' } });
  try {
    const a = h.store.issueToken(1);
    const wrong = await h.chat(a, { model: 'expensive/model' });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error.code, 'model_not_allowed');
    assert.equal(h.up.calls.length, 0);

    await (await h.chat(a)).text();
    assert.equal(h.up.calls.at(-1).body.max_tokens, 1000, 'cap is applied when absent');
    await (await h.chat(a, { max_tokens: 50 })).text();
    assert.equal(h.up.calls.at(-1).body.max_tokens, 50, 'smaller request is kept');
    await (await h.chat(a, { max_tokens: 999999 })).text();
    assert.equal(h.up.calls.at(-1).body.max_tokens, 1000, 'larger request is clamped');
    await (await h.chat(a, { max_completion_tokens: 999999 })).text();
    assert.equal(h.up.calls.at(-1).body.max_completion_tokens, 1000);

    const big = await h.call('/v1/chat/completions', { token: a, body: JSON.stringify({ model: MODEL, pad: 'x'.repeat(5000) }) });
    assert.equal(big.status, 413);
    assert.equal((await h.call('/v1/chat/completions', { token: a, body: '{not json' })).status, 400);
    assert.equal((await h.call('/v1/chat/completions', { token: a, body: '[]' })).status, 400);
    assert.equal((await h.call('/v1/embeddings', { token: a, body: {} })).status, 404, 'only chat and models are exposed');
    assert.equal((await h.call('/v1/chat/completions', { token: a, method: 'GET' })).status, 405);
    const models = await (await h.call('/v1/models', { token: a, method: 'GET' })).json();
    assert.deepEqual(models.data.map((m) => m.id), [MODEL]);
  } finally {
    await h.close();
  }
});

test('the user listener has no admin routes, even for a caller holding the admin secret; the admin socket is private', async () => {
  const h = await harness();
  try {
    const token = h.store.issueToken(1);
    for (const [method, path, body] of [['GET', '/admin/usage/1'], ['GET', '/admin/usage'], ['POST', '/admin/tokens', { userId: 1 }], ['DELETE', '/admin/tokens/1'], ['GET', '/admin']]) {
      for (const bearer of [ADMIN, token, undefined]) {
        const r = await h.call(path, { token: bearer, method, body });
        assert.equal(r.status, 404, `${method} ${path} with ${bearer === ADMIN ? 'admin secret' : bearer ? 'user token' : 'no auth'}`);
      }
    }
    assert.equal(h.store.userByToken(token), 1, 'a refused DELETE must not revoke anything');
    assert.equal(statSync(h.socketPath).isSocket(), true);
    // The admin server serves only admin routes: no model traffic and no healthz on it.
    assert.equal((await h.adminCall('/v1/models')).status, 404);
    assert.equal((await h.adminCall('/v1/chat/completions', 'POST', {})).status, 404);
  } finally {
    await h.close();
  }
});

test('config: the admin socket path is configurable and there is no admin TCP port setting', () => {
  assert.equal(loadConfig(baseEnv()).adminSocket, '/run/llm-admin/admin.sock');
  assert.equal(loadConfig(baseEnv({ ADMIN_SOCKET: '/tmp/x.sock' })).adminSocket, '/tmp/x.sock');
  assert.ok(!Object.keys(loadConfig(baseEnv())).some((k) => /adminPort|adminHost/i.test(k)));
});

test('admin API: requires the secret; issue, rotate, revoke and usage report', async () => {
  const h = await harness({ env: { DAILY_TOKEN_QUOTA: '100', MONTHLY_TOKEN_QUOTA: '1000' } });
  try {
    for (const bad of [null, 'wrong', 'x'.repeat(40)]) { // null = no Authorization header
      assert.equal((await h.adminCall('/admin/tokens', 'POST', { userId: 1 }, bad)).status, 401);
      assert.equal((await h.adminCall('/admin/usage/1', 'GET', undefined, bad)).status, 401);
      assert.equal((await h.adminCall('/admin/tokens/1', 'DELETE', undefined, bad)).status, 401);
    }
    const first = (await (await h.adminCall('/admin/tokens', 'POST', { userId: 5 })).json()).token;
    assert.match(first, /^dshu_/);
    assert.equal((await h.chat(first)).status, 200);
    const second = (await (await h.adminCall('/admin/tokens', 'POST', { userId: 5 })).json()).token;
    assert.notEqual(first, second);
    assert.equal((await h.chat(first)).status, 401, 'rotation revokes the old token');
    assert.equal((await h.chat(second)).status, 200);
    const usage = await (await h.adminCall('/admin/usage/5')).json();
    assert.equal(usage.userId, 5);
    assert.equal(usage.day.used, 60);
    assert.equal(usage.day.limit, 100);
    assert.equal(usage.month.limit, 1000);
    assert.equal(usage.exhausted, false);
    assert.equal((await (await h.adminCall('/admin/usage/6')).json()).day.used, 0);
    const all = await (await h.adminCall('/admin/usage')).json();
    assert.deepEqual(all.map((u) => u.userId), [5]);
    assert.equal((await h.adminCall('/admin/tokens/5', 'DELETE')).status, 204);
    assert.equal((await h.chat(second)).status, 401);
    assert.equal((await h.adminCall('/admin/tokens', 'POST', { userId: 'abc' })).status, 400);
    assert.equal((await h.adminCall('/admin/usage/abc')).status, 400);
    assert.equal((await h.adminCall('/admin/nope')).status, 404);
  } finally {
    await h.close();
  }
});

test('logs never contain the real key, user tokens, prompts or completions', async () => {
  const secretPrompt = 'PROMPT-SECRET-' + Math.random();
  const h = await harness({ upstream: () => ({ status: 401, json: { error: { message: REAL_KEY } } }) });
  try {
    const t = h.store.issueToken(1);
    await (await h.chat(t, { messages: [{ role: 'user', content: secretPrompt }] })).text();
    await (await h.chat('bad-token')).text();
    h.up.calls.length = 0;
    const joined = h.logs.join('\n');
    assert.ok(joined.length > 0);
    for (const needle of [REAL_KEY, t, secretPrompt, ADMIN]) assert.ok(!joined.includes(needle), `log leaked ${needle.slice(0, 12)}`);
  } finally {
    await h.close();
  }
});

test('global budget: once all users together use it up everyone gets 429 until the next UTC day; 0 disables it', async () => {
  let t = Date.UTC(2026, 5, 10, 12, 0, 0);
  const h = await harness({ env: { GLOBAL_DAILY_TOKEN_BUDGET: '90', DAILY_TOKEN_QUOTA: '0', MONTHLY_TOKEN_QUOTA: '0' }, upstream: () => ok(10, 20), now: () => t });
  try {
    const a = h.store.issueToken(1);
    const b = h.store.issueToken(2);
    const c = h.store.issueToken(3);
    assert.equal((await h.chat(a)).status, 200); // 30
    assert.equal((await h.chat(b)).status, 200); // 60
    assert.equal((await h.chat(c)).status, 200); // 90 reaches the budget
    h.up.calls.length = 0;
    for (const token of [a, b, c]) {
      const r = await h.chat(token);
      assert.equal(r.status, 429, 'every user, including one who used nothing yet');
      const err = (await r.json()).error;
      assert.equal(err.code, 'budget_exhausted');
      assert.match(err.message, /resets at 2026-06-11T00:00:00\.000Z/);
      assert.equal(Number(r.headers.get('retry-after')), 12 * 3600);
    }
    assert.equal(h.up.calls.length, 0, 'no provider call once the budget is gone');
    t += 13 * 3600 * 1000;
    assert.equal((await h.chat(a)).status, 200, 'budget resets with the day');
  } finally {
    await h.close();
  }
  const open = await harness({ env: { GLOBAL_DAILY_TOKEN_BUDGET: '0', DAILY_TOKEN_QUOTA: '0', MONTHLY_TOKEN_QUOTA: '0' }, upstream: () => ok(10, 20) });
  try {
    const a = open.store.issueToken(1);
    for (let i = 0; i < 5; i++) assert.equal((await open.chat(a)).status, 200);
  } finally {
    await open.close();
  }
});

test('audit: token issue/revoke, quota hits and budget hits are logged as JSON without content; repeats are throttled', async () => {
  let t = Date.UTC(2026, 5, 10, 12, 0, 0);
  const h = await harness({ env: { DAILY_TOKEN_QUOTA: '30', MONTHLY_TOKEN_QUOTA: '0', GLOBAL_DAILY_TOKEN_BUDGET: '1000' }, upstream: () => ok(10, 20), now: () => t });
  try {
    const issued = await (await h.adminCall('/admin/tokens', 'POST', { userId: 5 })).json();
    await h.adminCall('/admin/tokens/5', 'DELETE');
    const token = h.store.issueToken(6);
    assert.equal((await h.chat(token, { messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }] })).status, 200); // 30 = the quota
    for (let i = 0; i < 3; i++) assert.equal((await h.chat(token)).status, 429);
    const lines = h.logs.filter((l) => l.startsWith('audit ')).map((l) => JSON.parse(l.slice(6)));
    assert.deepEqual(lines.map((l) => l.event), ['token.issue', 'token.revoke', 'quota.hit'], 'three blocked requests, one audit line');
    assert.deepEqual({ userId: lines[2].userId, window: lines[2].window, used: lines[2].used, limit: lines[2].limit }, { userId: 6, window: 'day', used: 30, limit: 30 });
    const all = h.logs.join('\n');
    assert.ok(!all.includes(issued.token), 'token never logged');
    assert.ok(!all.includes('SECRET-PROMPT-TEXT'), 'prompt never logged');
    t += 11 * 60 * 1000; // past the throttle window, same UTC day
    await h.chat(token);
    assert.equal(h.logs.filter((l) => l.startsWith('audit ') && l.includes('quota.hit')).length, 2);
  } finally {
    await h.close();
  }
});

test('activity: the admin socket reports who has a model request in flight or finished recently; the user listener does not serve it', async () => {
  let t = Date.UTC(2026, 5, 10, 12, 0, 0);
  const h = await harness({ env: { DAILY_TOKEN_QUOTA: '0', MONTHLY_TOKEN_QUOTA: '0' }, upstream: () => ok(1, 1), now: () => t });
  try {
    const a = h.store.issueToken(1);
    const idle = await (await h.adminCall('/admin/activity')).json();
    assert.deepEqual(idle.users, [], 'nobody yet');
    assert.equal((await h.chat(a)).status, 200);
    const after = (await (await h.adminCall('/admin/activity')).json()).users;
    assert.equal(after.length, 1);
    assert.deepEqual({ userId: after[0].userId, inflight: after[0].inflight, lastAt: after[0].lastAt }, { userId: 1, inflight: 0, lastAt: new Date(t).toISOString() });
    t += 16 * 60 * 1000;
    assert.deepEqual((await (await h.adminCall('/admin/activity')).json()).users, [], 'forgotten after 15 minutes');
    assert.equal((await h.adminCall('/admin/activity', 'GET', undefined, null)).status, 401, 'needs the admin secret');
    assert.equal((await h.call('/admin/activity', { method: 'GET', token: a })).status, 404, 'not on the user listener');
  } finally {
    await h.close();
  }
});

test('activity: a request still waiting on the provider counts as in flight, and stops counting when it ends', async () => {
  const h = await harness({ env: { DAILY_TOKEN_QUOTA: '0', MONTHLY_TOKEN_QUOTA: '0' }, upstream: () => ({ hang: true }) });
  try {
    const a = h.store.issueToken(7);
    const pending = h.chat(a).catch(() => null);
    let inflight = 0;
    for (let i = 0; i < 50 && inflight === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      inflight = (await (await h.adminCall('/admin/activity')).json()).users.find((u) => u.userId === 7)?.inflight ?? 0;
    }
    assert.equal(inflight, 1);
    await h.close();
    await pending;
  } catch (e) {
    await h.close().catch(() => {});
    throw e;
  }
});

test('admin usage includes the service-wide budget state, or null when there is no budget', async () => {
  let t = Date.UTC(2026, 5, 10, 12, 0, 0);
  const h = await harness({ env: { GLOBAL_DAILY_TOKEN_BUDGET: '60', DAILY_TOKEN_QUOTA: '0', MONTHLY_TOKEN_QUOTA: '0' }, upstream: () => ok(10, 20), now: () => t });
  try {
    const a = h.store.issueToken(1);
    let u = await (await h.adminCall('/admin/usage/1')).json();
    assert.deepEqual(u.global, { used: 0, limit: 60, exhausted: false, resetsAt: '2026-06-11T00:00:00.000Z' });
    await h.chat(a);
    await h.chat(a); // 60 tokens
    u = await (await h.adminCall('/admin/usage/1')).json();
    assert.equal(u.global.used, 60);
    assert.equal(u.global.exhausted, true);
    assert.equal(u.exhausted, false, "the user's own quota is a separate fact");
  } finally {
    await h.close();
  }
  const open = await harness({ env: { GLOBAL_DAILY_TOKEN_BUDGET: '0' } });
  try {
    assert.equal((await (await open.adminCall('/admin/usage/1')).json()).global, null);
  } finally {
    await open.close();
  }
});
