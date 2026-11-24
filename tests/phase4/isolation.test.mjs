// Phase 4 adversarial suite, part 1 (tasks B1-C1): what a user with a shell inside their sandbox can reach.
// Needs Docker (Linux or Docker Desktop). Probes run inside the sandbox with node, as the agent's shell would.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNoDevData, compose, request, sh, signupUser, waitFor, waitSandboxUp } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc', // run the suite under gVisor with SANDBOX_RUNTIME=runsc
  ALLOW_SIGNUP: 'true', // the suites create accounts without invite codes
  UPSTREAM_API_KEY: 'phase4-placeholder',
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
};
const GATEWAY = 'dshcloud-gateway-1';
const RUNNER = 'dshcloud-sandbox-runner-1';
const run = randomBytes(3).toString('hex');
const users = {};
const sacrificial = [];
let owned = false;

const docker = (...a) => sh('docker', a).trim();
const tryDocker = (...a) => {
  try {
    return docker(...a);
  } catch {
    return '';
  }
};
const ipOn = (container, network) => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container);
const networksOf = (container) => docker('inspect', '-f', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}', container).split(' ').filter(Boolean);

/** TCP connect from inside a sandbox. Resolves 'open', or why it failed. Short timeout: blocked means no route. */
function connectFrom(u, host, port) {
  const script = `
    const s = require('net').connect({ host: process.argv[1], port: +process.argv[2], timeout: 3000 });
    s.on('connect', () => { console.log('open'); process.exit(); });
    s.on('timeout', () => { console.log('blocked'); process.exit(); });
    s.on('error', (e) => { console.log('blocked'); process.exit(); });`;
  return docker('exec', u.container, 'node', '-e', script, host, String(port));
}

before(async () => {
  assertNoDevData();
  owned = true;
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
  users.a = await signupUser('a', run);
  users.b = await signupUser('b', run);
  await Promise.all([waitSandboxUp(users.a), waitSandboxUp(users.b)]);
});

after(() => {
  if (!owned) return;
  for (const u of [...Object.values(users), ...sacrificial]) {
    tryDocker('rm', '-f', u.container);
    tryDocker('volume', 'rm', `dsh-data-${u.id}`, `dsh-ws-${u.id}`);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  compose(FILE, ['down', '-v'], ENV);
});

test('the gateway has no Docker socket; only sandbox-runner mounts it', () => {
  assert.ok(!docker('inspect', '-f', '{{json .Mounts}}', GATEWAY).includes('docker.sock'));
  assert.equal(tryDocker('exec', GATEWAY, 'sh', '-c', 'test -e /var/run/docker.sock && echo yes'), '');
  assert.ok(docker('inspect', '-f', '{{json .Mounts}}', RUNNER).includes('docker.sock'));
  const mounting = docker('ps', '-q', '--filter', 'name=dshcloud-').split('\n').filter((id) => docker('inspect', '-f', '{{json .Mounts}}', id).includes('docker.sock'));
  assert.equal(mounting.length, 1, 'exactly one container holds the socket');
});

test('every user has an internal network of their own, and their sandbox is on that one only', () => {
  for (const u of Object.values(users)) {
    const net = `dsh-net-${u.id}`;
    assert.equal(docker('network', 'inspect', '-f', '{{.Internal}}', net), 'true', `${net} has no route off the host`);
    assert.deepEqual(networksOf(u.container), [net]);
    const members = docker('network', 'inspect', '-f', '{{range .Containers}}{{.Name}} {{end}}', net).split(' ').filter(Boolean).sort();
    assert.deepEqual(members, [GATEWAY, 'dshcloud-llm-proxy-1', 'dshcloud-egress-proxy-1', u.container].sort(), 'only the shared services and this sandbox');
  }
});

test('shared services are reachable by name from /etc/hosts at fixed addresses (works under gVisor, which has no Docker DNS)', () => {
  for (const u of Object.values(users)) {
    const net = `dsh-net-${u.id}`;
    const ip = (container) => ipOn(container, net);
    const hosts = docker('exec', u.container, 'cat', '/etc/hosts');
    assert.match(hosts, new RegExp(`^${ip(GATEWAY).replaceAll('.', '\\.')}\\s+gateway$`, 'm'));
    assert.match(hosts, new RegExp(`^${ip('dshcloud-llm-proxy-1').replaceAll('.', '\\.')}\\s+llm-proxy$`, 'm'));
    // Top of the subnet, so a sandbox's own dynamic address (bottom) can never collide with them.
    assert.ok(Number(ip(GATEWAY).split('.').at(-1)) > 200 || ip(GATEWAY).endsWith('.254'));
    assert.notEqual(ip(u.container), ip(GATEWAY));
  }
});

test('sandbox A cannot reach sandbox B, by name or by address', () => {
  const b = users.b;
  assert.equal(connectFrom(users.a, b.container, 3080), 'blocked');
  assert.equal(connectFrom(users.a, ipOn(b.container, `dsh-net-${b.id}`), 3080), 'blocked');
  assert.equal(connectFrom(users.b, ipOn(users.a.container, `dsh-net-${users.a.id}`), 3080), 'blocked');
});

test('sandbox cannot reach the runner, the internet or cloud metadata', () => {
  const u = users.a;
  assert.equal(connectFrom(u, 'sandbox-runner', 8090), 'blocked');
  assert.equal(connectFrom(u, ipOn(RUNNER, 'dsh-sandboxes'), 8090), 'blocked');
  assert.equal(connectFrom(u, '1.1.1.1', 443), 'blocked');
  assert.equal(connectFrom(u, '169.254.169.254', 80), 'blocked');
  assert.equal(tryDocker('exec', u.container, 'sh', '-c', 'test -e /var/run/docker.sock && echo yes'), '', 'no Docker socket');
});

test('web access only through the egress proxy: public hosts work, private and metadata addresses are refused and logged', () => {
  const u = users.a;
  const fetchFrom = (url) =>
    tryDocker('exec', u.container, 'node', '-e', `fetch(process.argv[1],{signal:AbortSignal.timeout(15000)}).then(r=>console.log(r.status),()=>console.log('failed'))`, url) || 'failed';
  const reached = fetchFrom('http://example.com/');
  if (reached === 'failed') console.log('note: no internet from this host; skipping the public-host half of the egress check');
  else assert.equal(reached, '200');
  for (const url of ['http://169.254.169.254/latest/meta-data/', `http://${ipOn(users.b.container, `dsh-net-${users.b.id}`)}:3080/`, 'http://sandbox-runner:8090/healthz'])
    assert.equal(fetchFrom(url), 'failed', url);
  assert.equal(connectFrom(u, '93.184.216.34', 80), 'blocked', 'no direct route, proxy or not');
  const log = docker('logs', 'dshcloud-egress-proxy-1');
  assert.match(log, /egress deny .*169\.254\.169\.254/);
});

test('the agent shell is confined to /workspace (bwrap, the harness\'s own profile); only meaningful under gVisor', () => {
  const u = users.a;
  const runtime = docker('inspect', '-f', '{{.HostConfig.Runtime}}', u.container);
  if (runtime !== 'runsc') {
    console.log(`note: runtime is ${runtime}; bwrap needs unprivileged user namespaces, which hardened runc denies. Skipping.`);
    return;
  }
  const bwrap = 'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /workspace /workspace --';
  const run = (cmd) => tryDocker('exec', u.container, 'sh', '-c', `${bwrap} sh -c '${cmd} 2>&1; echo status=$?'`);
  assert.match(run('echo ok > /workspace/f1-probe && echo wrote'), /wrote/);
  assert.match(run('echo x > /data/dsh/f1-probe'), /Read-only file system|status=[1-9]/, 'DSH_HOME is not writable from the agent shell');
  assert.match(run('echo x > /etc/f1-probe'), /status=[1-9]/, 'nothing outside the workspace and /tmp is writable');
});

// ---- resource abuse: a hostile sandbox must stay inside its limits and not disturb the host or a neighbour ----
/** The abused user's own harness may exit under attack (for example when it cannot fork). That is acceptable: the gateway
 *  restarts the sandbox on the next request. The platform properties are that it recovers and that nobody else is affected. */
async function recover(u) {
  if (tryDocker('inspect', '-f', '{{.State.Running}}', u.container) !== 'true') console.log(`note: the harness in ${u.container} exited under abuse; the gateway restarts it`);
  await waitSandboxUp(u);
  assert.equal(docker('inspect', '-f', '{{.State.Running}}', u.container), 'true', 'the abused sandbox came back');
}
const timed = (fn) => { const t = Date.now(); const r = fn(); return { r, ms: Date.now() - t }; };

test('fork bomb: the process limit stops it, and the host and the other sandbox stay responsive', async () => {
  const script = `
    const { spawn } = require('child_process');
    let ok = 0, failed = 0;
    const kids = [];
    for (let i = 0; i < 700; i++) {
      try {
        const c = spawn('sleep', ['30'], { stdio: 'ignore' });
        c.on('error', () => { failed++; });
        kids.push(c);
      } catch { failed++; } // runc reports EAGAIN asynchronously, gVisor throws ENOMEM at once
    }
    setTimeout(() => { ok = kids.filter((k) => k.pid).length; console.log(JSON.stringify({ ok, failed })); kids.forEach((k) => k.kill()); process.exit(); }, 3000);`;
  const out = JSON.parse(docker('exec', users.a.container, 'node', '-e', script));
  assert.ok(out.failed > 0, `spawning was never refused: ${JSON.stringify(out)}`);
  assert.ok(out.ok <= Number(docker('inspect', '-f', '{{.HostConfig.PidsLimit}}', users.a.container)), `more processes than PidsLimit: ${JSON.stringify(out)}`);
  const { ms } = timed(() => docker('exec', users.b.container, 'true'));
  assert.ok(ms < 8000, `the neighbour's container took ${ms} ms to answer while the bomb ran`);
  await recover(users.a);
});

test('large writes are bounded: /tmp stops at its tmpfs size instead of filling memory or the host disk', async () => {
  const limitMb = Number(/size=(\d+)m/.exec(docker('inspect', '-f', '{{json .HostConfig.Tmpfs}}', users.a.container))[1]);
  tryDocker('exec', users.a.container, 'sh', '-c', `head -c ${(limitMb + 200) * 1024 * 1024} /dev/zero > /tmp/fill`);
  const bytes = Number(tryDocker('exec', users.a.container, 'sh', '-c', 'wc -c < /tmp/fill'));
  assert.ok(bytes > 0 && bytes <= limitMb * 1024 * 1024, `wrote ${bytes} bytes into a ${limitMb} MB tmpfs`);
  tryDocker('exec', users.a.container, 'rm', '-f', '/tmp/fill');
  assert.equal(tryDocker('exec', users.a.container, 'sh', '-c', 'echo x > /etc/f 2>&1 || echo denied').includes('denied'), true, 'root filesystem stays read-only');
  await recover(users.a);
});

test('CPU spin: CPU use is capped at the sandbox limit and the neighbour still answers quickly', async () => {
  const cpus = Number(docker('inspect', '-f', '{{.HostConfig.NanoCpus}}', users.a.container)) / 1e9;
  docker('exec', '-d', users.a.container, 'node', '-e', 'const end=Date.now()+12000; for (let i=0;i<4;i++) setTimeout(()=>{}, 0); const w=()=>{ while(Date.now()<end); }; require("child_process").spawn(process.execPath,["-e","const e=Date.now()+12000;while(Date.now()<e);"],{stdio:"ignore"}); require("child_process").spawn(process.execPath,["-e","const e=Date.now()+12000;while(Date.now()<e);"],{stdio:"ignore"}); require("child_process").spawn(process.execPath,["-e","const e=Date.now()+12000;while(Date.now()<e);"],{stdio:"ignore"}); w();');
  await new Promise((r) => setTimeout(r, 5000));
  const pct = Number(docker('stats', '--no-stream', '--format', '{{.CPUPerc}}', users.a.container).replace('%', ''));
  const { ms } = timed(() => docker('exec', users.b.container, 'true'));
  assert.ok(pct <= cpus * 100 * 1.25, `container used ${pct}% of a ${cpus}-CPU limit`);
  assert.ok(ms < 8000, `the neighbour took ${ms} ms to answer during the spin`);
  await new Promise((r) => setTimeout(r, 8000));
  await recover(users.a);
});

test('memory hog: it is killed at the memory limit (no swap) and does not take the neighbour down', async () => {
  const c = await signupUser('c', run); // sacrificial: an OOM kill may take its whole container
  sacrificial.push(c); // not in `users`: later tests iterate those
  await waitSandboxUp(c);
  const limit = Number(docker('inspect', '-f', '{{.HostConfig.Memory}}', c.container));
  assert.equal(Number(docker('inspect', '-f', '{{.HostConfig.MemorySwap}}', c.container)), limit, 'no swap');
  let status = 0;
  try {
    docker('exec', c.container, 'node', '-e', 'const a=[]; for(;;) a.push(Buffer.alloc(64*1024*1024, 1));');
  } catch (e) {
    status = e.status ?? 1;
  }
  assert.notEqual(status, 0, 'the allocation loop must not run to completion');
  assert.equal(docker('inspect', '-f', '{{.State.Running}}', users.b.container), 'true', "another user's sandbox is untouched");
  assert.equal(docker('exec', users.b.container, 'echo', 'alive'), 'alive');
});

test('what a sandbox does need still works: llm-proxy and the gateway', async () => {
  assert.equal(connectFrom(users.a, 'llm-proxy', 8081), 'open');
  const r = docker('exec', users.a.container, 'node', '-e',
    "fetch(process.env.LLM_BASE_URL + '/models', { headers: { authorization: 'Bearer ' + process.env.LLM_PROXY_TOKEN } }).then((r) => console.log(r.status))");
  assert.equal(r, '200');
  for (const u of Object.values(users)) assert.equal((await waitSandboxUp(u)).status, 200);
});

test('the llm-proxy admin API is not reachable from a sandbox, even with the real admin secret', () => {
  const u = users.a;
  const call = (path, method = 'GET') => docker('exec', '-e', `S=${ENV.LLM_ADMIN_SECRET}`, u.container, 'node', '-e',
    `fetch('http://llm-proxy:8081' + process.argv[1], { method: process.argv[2], headers: { authorization: 'Bearer ' + process.env.S } }).then((r) => console.log(r.status), () => console.log('error'))`, path, method);
  assert.equal(call('/admin/usage/1'), '404');
  assert.equal(call('/admin/usage'), '404');
  assert.equal(call('/admin/tokens/1', 'DELETE'), '404');
  // No other llm-proxy port is open to the sandbox either.
  for (const port of [8082, 8083, 8090, 9000]) assert.equal(connectFrom(u, 'llm-proxy', port), 'blocked', `port ${port}`);
  // The socket lives on a volume the sandbox does not mount.
  assert.equal(tryDocker('exec', u.container, 'sh', '-c', 'ls /run/llm-admin 2>/dev/null'), '');
  const mounters = docker('ps', '-aq', '--filter', 'volume=dshcloud_llm-admin').split('\n').filter(Boolean).map((id) => docker('inspect', '-f', '{{.Name}}', id)).sort();
  assert.deepEqual(mounters, ['/dshcloud-gateway-1', '/dshcloud-llm-proxy-1']);
});

test('the gateway still administers tokens over the socket (usage endpoint works)', async () => {
  const r = await request('/gw/api/usage', { headers: { cookie: users.a.cookie } });
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).userId, users.a.id);
});

test('the runner API is not reachable without its secret, even from the gateway network', async () => {
  const ip = ipOn(RUNNER, 'dsh-sandboxes');
  const status = (auth) => docker('exec', GATEWAY, 'node', '-e',
    `fetch('http://${ip}:8090/v1/sandboxes', { headers: ${auth ? `{ authorization: '${auth}' }` : '{}'} }).then((r) => console.log(r.status))`);
  assert.equal(status(''), '401');
  assert.equal(status('Bearer wrong-secret-0123456789'), '401');
});

test('recreating the gateway and llm-proxy re-attaches them to every user network at the same addresses', async () => {
  const before = Object.fromEntries(Object.values(users).map((u) => [u.id, [ipOn(GATEWAY, `dsh-net-${u.id}`), ipOn('dshcloud-llm-proxy-1', `dsh-net-${u.id}`)]]));
  compose(FILE, ['up', '-d', '--force-recreate', '--no-deps', 'gateway', 'llm-proxy'], ENV);
  for (const u of Object.values(users)) {
    await waitFor(
      async () => {
        const m = docker('network', 'inspect', '-f', '{{range .Containers}}{{.Name}} {{end}}', `dsh-net-${u.id}`);
        return m.includes(GATEWAY) && m.includes('dshcloud-llm-proxy-1');
      },
      { timeoutMs: 90000, what: `reconcile for dsh-net-${u.id}` },
    );
  }
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
  for (const u of Object.values(users)) assert.equal((await waitSandboxUp(u)).status, 200);
  for (const u of Object.values(users)) {
    assert.deepEqual([ipOn(GATEWAY, `dsh-net-${u.id}`), ipOn('dshcloud-llm-proxy-1', `dsh-net-${u.id}`)], before[u.id], 'same addresses, so /etc/hosts in running sandboxes stays valid');
  }
  // The still-running sandbox reaches the recreated llm-proxy without being restarted.
  await waitFor(async () => {
    try {
      return docker('exec', users.a.container, 'node', '-e',
        "fetch(process.env.LLM_BASE_URL + '/models', { headers: { authorization: 'Bearer ' + process.env.LLM_PROXY_TOKEN }, signal: AbortSignal.timeout(4000) }).then((r) => console.log(r.status), () => console.log('err'))") === '200';
    } catch {
      return false;
    }
  }, { timeoutMs: 60000, what: 'running sandbox reaching the recreated llm-proxy' });
});
