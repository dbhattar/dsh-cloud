// Gateway <-> llm-proxy wiring (no Docker): token lifecycle, sandbox spec, usage endpoint, admin client.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { LlmProxyClient } from '../../gateway/src/llm.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const REAL_KEY = 'sk-REAL-upstream-key-do-not-leak';
const cfgOf = (extra = {}) => ({
  ...loadConfig({ PUBLIC_URL: 'https://localhost/', LLM_ADMIN_SOCKET: '/run/llm-admin/admin.sock', LLM_ADMIN_SECRET: 'admin-secret-0123456789', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789', ...extra }),
  startTimeoutSeconds: 5,
});

test('config: proxy settings; the gateway has no field that could carry the real key', () => {
  const c = cfgOf({ UPSTREAM_API_KEY: REAL_KEY, OPENROUTER_API_KEY: REAL_KEY, LLM_API_KEY: REAL_KEY });
  assert.equal(c.llmAdminSocket, '/run/llm-admin/admin.sock');
  assert.ok(!JSON.stringify(c).includes(REAL_KEY), 'config never reads provider keys');
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789', LLM_ADMIN_SOCKET: '/x.sock' }), /LLM_ADMIN_SECRET/);
  assert.equal(loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' }).llmAdminSocket, '', 'metering is optional for non-model deployments');
});

/** Fake runner with enough state to observe create/remove/start and whether the container is proxy-managed. */
function fakeRunner({ existing = null, startFailsOnce = false } = {}) {
  const calls = [];
  let container = existing; // { token, llmManaged } or null
  let running = false;
  let failed = false;
  return {
    calls,
    get container() {
      return container;
    },
    async info() {
      return container ? { running, startedAt: 't1', llmManaged: container.llmManaged } : null;
    },
    async create(userId, token) {
      calls.push(['create', token]);
      container = { token, llmManaged: Boolean(token) };
    },
    async remove() {
      calls.push(['remove']);
      container = null;
      running = false;
    },
    async start() {
      calls.push(['start']);
      if (startFailsOnce && !failed) {
        failed = true;
        throw new Error('runner POST /1/start -> 409 stale_network');
      }
      running = true;
    },
    async logs() {
      return 'dsh web: https://localhost/?token=abc_DEF-123\n';
    },
  };
}

async function withCookieServer(fn) {
  const srv = http.createServer((req, res) => res.writeHead(303, { 'set-cookie': 'dsh-auth-x=v1.tok; Path=/; HttpOnly' }).end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn(srv.address().port);
  } finally {
    srv.close();
  }
}

function managerWith(runner, port) {
  let n = 0;
  const issued = [];
  const llm = { issueToken: async (id) => (issued.push(id), `tok-${id}-${++n}`) };
  const m = new SandboxManager({ runner, cfg: { ...cfgOf(), sandboxPort: port }, log: () => {}, llm });
  m.name = () => '127.0.0.1';
  return { m, issued };
}

test('first start issues one token; resuming an existing proxy-era container keeps its token', async () => {
  await withCookieServer(async (port) => {
    const d = fakeRunner();
    const { m, issued } = managerWith(d, port);
    await m.ensure(1);
    assert.deepEqual(issued, [1]);
    assert.deepEqual(d.calls[0], ['create', 'tok-1-1']);
    m.cache.clear();
    await m.ensure(1); // container exists, not running: plain start, no new token
    assert.deepEqual(issued, [1]);
    assert.equal(d.calls.filter((c) => c[0] === 'create').length, 1);
  });
});

test('a pre-proxy container (which may hold the real key) is replaced with a token-only one', async () => {
  await withCookieServer(async (port) => {
    const legacy = { token: null, llmManaged: false };
    const d = fakeRunner({ existing: legacy });
    const { m, issued } = managerWith(d, port);
    await m.ensure(1);
    assert.deepEqual(d.calls.slice(0, 2).map((c) => c[0]), ['remove', 'create']);
    assert.deepEqual(issued, [1]);
    assert.equal(d.container.token, 'tok-1-1', 'the replacement carries a proxy token');
    assert.equal(d.container.llmManaged, true);
  });
});

test('recreating after a stale network issues a fresh token for the new container', async () => {
  await withCookieServer(async (port) => {
    const d = fakeRunner({ startFailsOnce: true });
    const { m, issued } = managerWith(d, port);
    await m.ensure(1);
    assert.deepEqual(issued, [1, 1]);
    assert.equal(d.container.token, 'tok-1-2');
  });
});

test('if the proxy cannot issue a token, the start fails and no container is created', async () => {
  const d = fakeRunner();
  const m = new SandboxManager({ runner: d, cfg: cfgOf(), log: () => {}, llm: { issueToken: async () => { throw new Error('llm-proxy POST /admin/tokens -> 503'); } } });
  await assert.rejects(m.ensure(1), /503/);
  assert.equal(d.container, null);
  assert.equal(m.status(1).state, 'error');
});

test('LlmProxyClient sends the admin secret and maps the admin API', async () => {
  const seen = [];
  const requestImpl = async (method, path, headers, body) => {
    seen.push({ method, path, auth: headers.authorization, body });
    if (method === 'POST') return { status: 200, text: JSON.stringify({ token: 't' }) };
    if (method === 'DELETE') return { status: 204, text: '' };
    return { status: 200, text: JSON.stringify({ day: { used: 1 } }) };
  };
  const c = new LlmProxyClient({ socketPath: '/x.sock', adminSecret: 'S', requestImpl });
  assert.equal(await c.issueToken(4), 't');
  assert.equal(await c.revoke(4), null);
  assert.deepEqual(await c.usage(4), { day: { used: 1 } });
  assert.deepEqual(seen.map((s) => [s.method, s.path]), [['POST', '/admin/tokens'], ['DELETE', '/admin/tokens/4'], ['GET', '/admin/usage/4']]);
  assert.ok(seen.every((s) => s.auth === 'Bearer S'));
  assert.equal(JSON.parse(seen[0].body).userId, 4);
  const bad = new LlmProxyClient({ socketPath: '/x.sock', adminSecret: 'S', requestImpl: async () => ({ status: 401, text: 'no' }) });
  await assert.rejects(bad.usage(1), /401/);
});

test('/gw/api/usage: requires a session, returns only the caller\'s usage, hides proxy failures', async () => {
  const store = new Store(':memory:');
  const a = store.createUser('a@x.co', 'x');
  const b = store.createUser('b@x.co', 'x');
  const ta = store.createSession(a, 60);
  const tb = store.createSession(b, 60);
  const asked = [];
  let fail = false;
  const llm = {
    usage: async (id) => {
      asked.push(id);
      if (fail) throw new Error('llm-proxy GET /admin/usage/1 -> 500 secret-detail');
      return { userId: id, day: { used: id * 10 } };
    },
  };
  const manager = { llm, touch() {}, status: () => ({}) };
  const srv = createGateway({ cfg: cfgOf(), store, manager, log: () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const get = (cookie) => fetch(`http://127.0.0.1:${srv.address().port}/gw/api/usage`, { headers: cookie ? { cookie: `gw_session=${cookie}` } : {} });
  try {
    assert.equal((await get()).status, 401);
    assert.deepEqual(await (await get(ta)).json(), { userId: a, day: { used: a * 10 } });
    assert.deepEqual(await (await get(tb)).json(), { userId: b, day: { used: b * 10 } });
    assert.deepEqual(asked, [a, b], 'the user id comes from the session, never from the request');
    fail = true;
    const r = await get(ta);
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes('secret-detail'));
    manager.llm = null;
    assert.equal((await get(ta)).status, 404);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('the app shell bundle polls /gw/api/usage and explains an exhausted allowance', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dist = new URL('../../gateway/web/dist/', import.meta.url);
  const js = readdirSync(dist).find((f) => f.endsWith('.js'));
  const bundle = readFileSync(new URL(js, dist), 'utf8');
  assert.match(bundle, /\/gw\/api\/usage/);
  assert.match(bundle, /token allowance/);
});
