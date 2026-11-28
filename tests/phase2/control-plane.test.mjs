// Phase 2 regression: gateway + per-user sandboxes (infra/docker-compose.gateway.yml).
// Idle timeout is shortened so idle-stop/resume can be tested in under a minute.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, BASE, compose, cookieOf, removeUserVolumes, request, sh, sleep, userVolumes, waitFor, wsHandshake } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
// The stack needs a key and an admin secret to start llm-proxy; phase 2 never calls a model.
const ENV = { ALLOW_SIGNUP: 'true', IDLE_SECONDS: '25', REAP_INTERVAL_SECONDS: '5', UPSTREAM_API_KEY: 'phase2-placeholder', LLM_ADMIN_SECRET: randomBytes(16).toString('hex'), RUNNER_SECRET: randomBytes(16).toString('hex') };
const PW = 'test-password-123';
const run = randomBytes(3).toString('hex');
const users = {};

const docker = (...a) => sh('docker', a).trim();
const state = (name) => {
  try {
    return docker('inspect', '-f', '{{.State.Status}}', name);
  } catch {
    return 'missing';
  }
};

async function signup(label) {
  const email = `${label}-${run}@example.com`;
  const r = await request('/gw/signup', { method: 'POST', body: { email, password: PW } });
  assert.equal(r.status, 303, r.body.slice(0, 200));
  const cookie = cookieOf(r, 'gw_session');
  const me = JSON.parse((await request('/gw/api/me', { headers: { cookie } })).body);
  users[label] = { email, cookie, id: me.id, container: `dsh-sbx-${me.id}` };
  return users[label];
}

/** Hit / until the sandbox is up (launching page is 503, then the app is 200). */
async function waitUp(u) {
  return waitFor(
    async () => {
      const r = await request('/', { headers: { cookie: u.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
      return r.status === 200 ? r : null;
    },
    { timeoutMs: 150000, what: `sandbox for ${u.email}` },
  );
}

// Cleanup runs only once the guard has passed: `after` also runs when `before` throws.
let owned = false;

before(async () => {
  assertNoDevData();
  owned = true;
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
});
after(() => {
  if (!owned) return;
  for (const u of Object.values(users)) {
    try {
      docker('rm', '-f', u.container);
      removeUserVolumes(u.id);
      docker('network', 'rm', `dsh-net-${u.id}`);
    } catch {}
  }
  compose(FILE, ['down', '-v'], ENV);
});

test('unauthenticated access is refused', async () => {
  const page = await request('/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/gw/login?next=%2F', 'sent to sign in, and brought back here afterwards');
  assert.equal((await request('/api/anything')).status, 401);
  assert.notEqual((await wsHandshake('/api/remote.mux')).status, 101);
  assert.equal((await request('/gw/api/status')).status, 401);
});

test('signup validation, duplicate handling, login failure and success', async () => {
  assert.equal((await request('/gw/signup', { method: 'POST', body: { email: 'bad', password: PW } })).status, 400);
  assert.equal((await request('/gw/signup', { method: 'POST', body: { email: `x-${run}@example.com`, password: 'short' } })).status, 400);
  await signup('a');
  await signup('b');
  const dup = await request('/gw/signup', { method: 'POST', body: { email: users.a.email, password: PW } });
  assert.equal(dup.status, 400);
  const bad = await request('/gw/login', { method: 'POST', body: { email: users.a.email, password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  assert.equal(cookieOf(bad, 'gw_session'), null);
  const good = await request('/gw/login', { method: 'POST', body: { email: users.a.email, password: PW } });
  assert.equal(good.status, 303);
  assert.ok(cookieOf(good, 'gw_session'));
  assert.match([].concat(good.headers['set-cookie']).join(';'), /HttpOnly/);
});

test('cross-origin POST is rejected', async () => {
  const r = await request('/gw/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: { email: 'a@b.co', password: PW } });
  assert.equal(r.status, 403);
});

test('first visit launches a per-user sandbox; first response is the launching page', async () => {
  const a = users.a;
  const first = await request('/', { headers: { cookie: a.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
  assert.ok([503, 200].includes(first.status));
  if (first.status === 503) assert.match(first.body, /Starting your workspace/);
  const st = JSON.parse((await request('/gw/api/status', { headers: { cookie: a.cookie } })).body);
  assert.ok(['starting', 'running'].includes(st.state));
  assert.equal(st.stages.length, 4);
  assert.ok(st.stages.every((x) => x.key && x.label));
  await waitUp(a);
  assert.equal(JSON.parse((await request('/gw/api/status', { headers: { cookie: a.cookie } })).body).state, 'running');
  assert.equal(state(a.container), 'running');
});

test('two users get separate containers and volumes', async () => {
  await waitUp(users.b);
  assert.notEqual(users.a.container, users.b.container);
  assert.equal(state(users.b.container), 'running');
  const mounts = (c) => docker('inspect', '-f', '{{range .Mounts}}{{.Name}} {{end}}', c).split(' ').filter(Boolean).sort();
  const ma = mounts(users.a.container);
  const mb = mounts(users.b.container);
  assert.deepEqual(ma, userVolumes(users.a.id).sort(), 'exactly the account\'s own two volumes (their names carry its key)');
  assert.equal(ma.length, 2);
  assert.ok(ma.every((m) => !mb.includes(m)), 'no shared volume');
});

test('sandbox limits are applied', () => {
  const [mem, pids, caps] = docker('inspect', '-f', '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.CapDrop}}', users.a.container).split(' ');
  assert.ok(Number(mem) > 0);
  assert.ok(Number(pids) > 0);
  assert.match(caps, /ALL/);
});

test('sandbox credentials never reach the browser', async () => {
  const r = await request('/', { headers: { cookie: users.a.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['set-cookie'], undefined);
  const token = docker('logs', users.a.container).match(/token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token);
  assert.ok(!r.body.includes(token));
  // A browser-supplied dsh cookie or token query must not be what authenticates: the gateway cookie rules.
  const noSession = await request(`/?token=${token}`, { headers: { accept: 'text/html' } });
  assert.equal(noSession.status, 303);
  assert.match(noSession.headers.location, /^\/gw\/login(\?next=|$)/);
  assert.equal(noSession.headers['set-cookie'], undefined);
});

test('WebSocket proxies for the owner and is refused without a session', async () => {
  const ok = await wsHandshake('/api/remote.mux', { headers: { cookie: users.a.cookie } });
  assert.equal(ok.status, 101);
  ok.socket.destroy();
  const noAuth = await wsHandshake('/api/remote.mux');
  assert.equal(noAuth.status, 401);
  const evil = await wsHandshake('/api/remote.mux', { headers: { cookie: users.a.cookie, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('manual stop keeps data; restart resumes on the same volume', async () => {
  const a = users.a;
  docker('exec', a.container, 'sh', '-c', 'echo persisted > /data/dsh/marker && echo ws > /workspace/marker');
  const r = await request('/gw/api/stop', { method: 'POST', headers: { cookie: a.cookie } });
  assert.equal(r.status, 200);
  assert.equal(state(a.container), 'exited');
  await waitUp(a);
  assert.equal(state(a.container), 'running');
  assert.equal(docker('exec', a.container, 'cat', '/data/dsh/marker'), 'persisted');
  assert.equal(docker('exec', a.container, 'cat', '/workspace/marker'), 'ws');
});

test('idle sandbox is stopped, an active one is not, and resume works', async () => {
  const { a, b } = users;
  await waitUp(b);
  // Keep user A active (open WebSocket) while B idles past IDLE_SECONDS.
  const ws = await wsHandshake('/api/remote.mux', { headers: { cookie: a.cookie } });
  assert.equal(ws.status, 101);
  await waitFor(() => state(b.container) === 'exited', { timeoutMs: 90000, everyMs: 2000, what: 'idle stop of B' });
  assert.equal(state(a.container), 'running', 'user with open socket stays up');
  ws.socket.destroy();
  // B resumes transparently.
  await waitUp(b);
  assert.equal(state(b.container), 'running');
});

test('gateway is on each user network and sandbox-runner re-attaches it when it is dropped', async () => {
  // Regression: compose recreating the gateway (or llm-proxy) detaches it from every user network, which
  // showed up as "getaddrinfo ENOTFOUND dsh-sbx-<id>" on the launching page.
  const gw = 'dshcloud-gateway-1';
  const net = `dsh-net-${users.a.id}`;
  const members = () => docker('network', 'inspect', '-f', '{{range .Containers}}{{.Name}} {{end}}', net);
  assert.match(members(), /dshcloud-gateway-1/);
  docker('network', 'disconnect', net, gw);
  assert.doesNotMatch(members(), /dshcloud-gateway-1/);
  await waitFor(async () => /dshcloud-gateway-1/.test(members()), { timeoutMs: 60000, what: 'runner reconcile re-attaching the gateway' });
  await waitUp(users.a); // sandbox reachable again by name
});

test('top-level navigation gets the account shell; the iframe gets the harness; framing is limited to same origin', async () => {
  const doc = await request('/some/deep/link?x=1', { headers: { cookie: users.a.cookie, accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(doc.status, 200);
  // The shell is a React page: the server embeds its data and the client renders the iframe and the sign-out form.
  const boot = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(doc.body)[1]);
  assert.deepEqual(boot, { page: 'shell', email: users.a.email, src: '/some/deep/link?x=1', workspaceName: 'Workspace' });
  assert.match(doc.headers['content-security-policy'], /frame-ancestors 'self'/);
  // protocol-relative paths must not turn into an external iframe src
  const evil = await request('//evil.example/x', { headers: { cookie: users.a.cookie, 'sec-fetch-dest': 'document' } });
  assert.ok(!evil.body.includes('evil.example'));
  const frame = await request('/', { headers: { cookie: users.a.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
  assert.equal(frame.status, 200);
  assert.ok(!frame.body.includes('id="app"'), 'iframe content is the harness, not the shell');
  assert.match(frame.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(frame.headers['x-frame-options'], 'SAMEORIGIN');
  // logged-out document navigation goes to login, not to a shell
  const anon = await request('/', { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(anon.headers.location, '/gw/login?next=%2F');
});

test('logout invalidates the session', async () => {
  const c = users.b.cookie;
  const out = await request('/gw/logout', { method: 'POST', headers: { cookie: c } });
  assert.equal(out.status, 303);
  assert.equal((await request('/gw/api/me', { headers: { cookie: c } })).status, 401);
});
