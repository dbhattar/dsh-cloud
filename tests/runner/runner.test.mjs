// sandbox-runner: container spec, narrow API, auth and input validation (fake Docker, no daemon needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../runner/src/config.js';
import { buildSpec } from '../../runner/src/spec.js';
import { createRunner } from '../../runner/src/server.js';
import { Networks, pinnedAddress } from '../../runner/src/network.js';
import { RunnerClient } from '../../gateway/src/runner.js';

const SECRET = 'runner-secret-0123456789';
const REAL_KEY = 'sk-REAL-upstream-key-do-not-leak';
const cfgOf = (extra = {}) =>
  loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_SECRET: SECRET, LLM_PROXY_URL: 'http://llm-proxy:8081/', ...extra });

test('config: requires PUBLIC_URL and a strong RUNNER_SECRET', () => {
  assert.throws(() => loadConfig({ RUNNER_SECRET: SECRET }), /PUBLIC_URL/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://localhost/' }), /RUNNER_SECRET/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_SECRET: 'short' }), /RUNNER_SECRET/);
});

test('spec: per-user volumes, limits, dropped caps; users never share volumes', () => {
  const a = buildSpec(cfgOf(), 1);
  const b = buildSpec(cfgOf(), 2);
  assert.deepEqual(a.HostConfig.Binds, ['dsh-data-1:/data/dsh', 'dsh-ws-1:/workspace']);
  assert.ok(a.HostConfig.Binds.every((x) => !b.HostConfig.Binds.includes(x)));
  assert.deepEqual(a.HostConfig.CapDrop, ['ALL']);
  assert.ok(a.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.ok(a.HostConfig.Memory > 0 && a.HostConfig.PidsLimit > 0 && a.HostConfig.NanoCpus > 0);
  assert.ok(!a.HostConfig.Privileged, 'never privileged');
  assert.ok(!a.Env.some((e) => /API_KEY|LLM_PROXY_TOKEN/.test(e)), 'no key or token without a proxy token');
});

test('spec hardening: read-only rootfs, tmpfs /tmp, no swap, nofile cap, default seccomp, no extra privileges', () => {
  const { HostConfig: h } = buildSpec(cfgOf(), 1);
  assert.equal(h.ReadonlyRootfs, true);
  assert.match(h.Tmpfs['/tmp'], /nosuid/);
  assert.match(h.Tmpfs['/tmp'], /\bexec\b/, 'the harness loads its native binding from /tmp');
  assert.equal(h.MemorySwap, h.Memory);
  assert.deepEqual(h.Ulimits, [{ Name: 'nofile', Soft: 4096, Hard: 4096 }]);
  assert.ok(!h.Ulimits.some((u) => u.Name === 'nproc'), 'nproc is per host UID, shared by all sandboxes');
  assert.ok(!h.SecurityOpt.some((o) => /seccomp|apparmor/.test(o)), 'keep Docker default profiles');
  for (const k of ['Privileged', 'CapAdd', 'Devices', 'PidMode', 'IpcMode', 'UsernsMode', 'CgroupnsMode']) assert.equal(h[k], undefined, k);
  assert.equal(h.Runtime, 'runc');
  // Only the two per-user volumes are mounted.
  assert.equal(h.Binds.length, 2);
});

test('runtime is configurable (runsc in production), validated, and may be left to the daemon default', () => {
  assert.equal(buildSpec(cfgOf({ SANDBOX_RUNTIME: 'runsc' }), 1).HostConfig.Runtime, 'runsc');
  assert.equal(buildSpec(cfgOf({ SANDBOX_RUNTIME: '' }), 1).HostConfig.Runtime, undefined);
  for (const bad of ['runsc --privileged', '../x', 'RUNC', 'a'.repeat(40)]) {
    assert.throws(() => cfgOf({ SANDBOX_RUNTIME: bad }), /SANDBOX_RUNTIME/, bad);
  }
});

test('spec with a proxy token: token + proxy URL, labelled, still no provider key', () => {
  const spec = buildSpec(cfgOf({ UPSTREAM_API_KEY: REAL_KEY, OPENROUTER_API_KEY: REAL_KEY }), 3, 'dshu_tok');
  assert.ok(spec.Env.includes('LLM_PROXY_TOKEN=dshu_tok'));
  assert.ok(spec.Env.includes('LLM_BASE_URL=http://llm-proxy:8081/v1'));
  assert.equal(spec.Labels['dsh-cloud.llm'], 'proxy-v1');
  assert.ok(!JSON.stringify(spec).includes(REAL_KEY));
  assert.ok(!spec.Env.some((e) => /^(OPENROUTER_API_KEY|LLM_API_KEY|UPSTREAM_API_KEY|DEEPSEEK_API_KEY)=/.test(e)));
});

/** Fake Docker keeping one container's state; records the specs it is asked to create. */
function fakeDocker() {
  const created = [];
  const state = {
    exists: false,
    running: false,
    startError: null,
    nets: {},
    subnet: '172.19.0.0/16', // what the next created network gets
    roles: { gateway: [{ Id: 'gw1', State: 'running' }], 'llm-proxy': [{ Id: 'llm1', State: 'running' }] },
  };
  return {
    created,
    state,
    async inspect(name) {
      return state.exists ? { Name: name, State: { Running: state.running, StartedAt: 't1', ExitCode: state.exitCode ?? 0, OOMKilled: Boolean(state.oomKilled) }, Config: { Labels: created.at(-1)?.spec.Labels } } : null;
    },
    async create(name, spec) {
      created.push({ name, spec });
      state.exists = true;
    },
    async start() {
      if (state.startError) throw new Error(state.startError);
      state.running = true;
    },
    async stop() {
      state.running = false;
    },
    async remove() {
      state.exists = false;
      state.running = false;
    },
    async logs() {
      return 'dsh web: https://localhost/?token=abc\n';
    },
    async list(label) {
      if (label.startsWith('dsh-cloud.role=')) return state.roles[label.split('=')[1]] ?? [];
      return state.exists ? [{ Labels: { 'dsh-cloud.user': '1' }, State: state.running ? 'running' : 'exited' }] : [];
    },
    // networks: name -> { Internal, Labels, Containers: { id: aliases } }
    async inspectNetwork(name) {
      const n = state.nets[name];
      if (!n) return null;
      return {
        Name: name,
        Internal: n.Internal,
        IPAM: { Config: [{ Subnet: n.subnet, Gateway: n.subnet.replace(/\.0\/\d+$/, '.1') }] },
        Containers: Object.fromEntries(Object.entries(n.Containers).map(([id, c]) => [id, { IPv4Address: `${c.ip}/16` }])),
      };
    },
    async createInternalNetwork(name, labels) {
      state.nets[name] = { Internal: true, Labels: labels, Containers: {}, subnet: state.subnet };
    },
    async listNetworks() {
      return Object.keys(state.nets).map((Name) => ({ Name }));
    },
    async connect(name, id, { aliases = [], ipv4 } = {}) {
      state.nets[name].Containers[id] = { aliases, ip: ipv4 ?? '172.19.0.2' }; // no pin: Docker's low dynamic address
    },
    async disconnect(name, id) {
      delete state.nets[name].Containers[id];
    },
    async removeNetwork(name) {
      delete state.nets[name];
    },
  };
}

async function withRunner(fn, cfg = cfgOf()) {
  const docker = fakeDocker();
  const networks = new Networks({ docker, cfg, log: () => {} });
  const srv = createRunner({ cfg, docker, networks, log: () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn({ docker, networks, url, client: new RunnerClient({ url, secret: SECRET }) });
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
}

const raw = (url, path, { method = 'GET', body, secret = SECRET } = {}) =>
  fetch(url + path, {
    method,
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
  });

test('lifecycle through the client: create, start, info, logs, list, stop, remove', async () => {
  await withRunner(async ({ client, docker }) => {
    assert.equal(await client.info(1), null);
    await client.create(1, 'dshu_abc');
    assert.equal(docker.created[0].name, 'dsh-sbx-1');
    assert.ok(docker.created[0].spec.Env.includes('LLM_PROXY_TOKEN=dshu_abc'));
    await client.start(1);
    assert.deepEqual(await client.info(1), { running: true, startedAt: 't1', llmManaged: true, exitCode: null, oomKilled: false });
    assert.match(await client.logs(1), /token=abc/);
    assert.deepEqual(await client.list(), [{ userId: 1, running: true }]);
    await client.stop(1);
    assert.equal((await client.info(1)).running, false);
    await client.remove(1);
    assert.equal(await client.info(1), null);
  });
});

test('info says why a stopped sandbox is not running (exit code, out of memory), for the crash watchdog', async () => {
  await withRunner(async ({ client, docker }) => {
    await client.create(1, 'dshu_abc');
    await client.start(1);
    docker.state.running = false;
    docker.state.exitCode = 137;
    docker.state.oomKilled = true;
    assert.deepEqual(await client.info(1), { running: false, startedAt: 't1', llmManaged: true, exitCode: 137, oomKilled: true });
  });
});

test('start on a stale network surfaces as stale_network', async () => {
  await withRunner(async ({ client, docker }) => {
    await client.create(1);
    docker.state.startError = 'docker POST start -> 404: network 8f2 not found';
    await assert.rejects(client.start(1), /stale_network/);
  });
});

test('auth: no token, wrong token and wrong scheme are refused; /healthz is open', async () => {
  await withRunner(async ({ url, docker }) => {
    assert.equal((await raw(url, '/v1/sandboxes', { secret: null })).status, 401);
    assert.equal((await raw(url, '/v1/sandboxes', { secret: 'x'.repeat(SECRET.length) })).status, 401);
    assert.equal((await raw(url, '/v1/sandboxes', { secret: SECRET.slice(0, -1) })).status, 401);
    const basic = await fetch(`${url}/v1/sandboxes`, { headers: { authorization: `Basic ${SECRET}` } });
    assert.equal(basic.status, 401);
    assert.equal((await raw(url, '/v1/sandboxes/1', { method: 'POST', body: {}, secret: null })).status, 401);
    assert.equal(docker.created.length, 0, 'unauthenticated calls never reach Docker');
    assert.equal((await raw(url, '/healthz', { secret: null })).status, 200);
  });
});

test('callers cannot choose binds, capabilities, image or privileged mode', async () => {
  await withRunner(async ({ url, docker }) => {
    const evil = {
      llmToken: 'dshu_abc',
      Image: 'alpine',
      HostConfig: { Privileged: true, Binds: ['/:/host'], CapAdd: ['SYS_ADMIN'] },
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    };
    const res = await raw(url, '/v1/sandboxes/1', { method: 'POST', body: evil });
    assert.equal(res.status, 201);
    const { spec } = docker.created[0];
    assert.equal(spec.Image, 'dsh-sandbox:latest');
    assert.deepEqual(spec.HostConfig.Binds, ['dsh-data-1:/data/dsh', 'dsh-ws-1:/workspace']);
    assert.ok(!spec.HostConfig.Privileged && !spec.HostConfig.CapAdd);
    assert.ok(!JSON.stringify(spec).includes('docker.sock'));
  });
});

test('input validation: user ids, tokens and bodies', async () => {
  await withRunner(async ({ url, docker }) => {
    for (const id of ['0', '01', 'abc', '1;rm', '..%2Fx', '1.5', '-1', '9'.repeat(17)]) {
      const r = await raw(url, `/v1/sandboxes/${id}`, { method: 'POST', body: {} });
      assert.ok([400, 404].includes(r.status), `id ${id} -> ${r.status}`);
    }
    for (const llmToken of ['a b', 'x\ny', 'a'.repeat(201), '', 5, ['t'], { a: 1 }, 'LLM=1\nFOO=2']) {
      const r = await raw(url, '/v1/sandboxes/1', { method: 'POST', body: { llmToken } });
      assert.equal(r.status, 400, `token ${JSON.stringify(llmToken)}`);
    }
    assert.equal((await raw(url, '/v1/sandboxes/1', { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await raw(url, '/v1/sandboxes/1', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
    assert.equal(docker.created.length, 0);
  });
});

test('a token is refused when no llm proxy is configured; creating twice conflicts', async () => {
  await withRunner(async ({ url }) => {
    assert.equal((await raw(url, '/v1/sandboxes/1', { method: 'POST', body: { llmToken: 'dshu_abc' } })).status, 400);
  }, cfgOf({ LLM_PROXY_URL: '' }));
  await withRunner(async ({ url }) => {
    assert.equal((await raw(url, '/v1/sandboxes/1', { method: 'POST', body: {} })).status, 201);
    assert.equal((await raw(url, '/v1/sandboxes/1', { method: 'POST', body: {} })).status, 409);
  });
});

test('only the narrow routes exist', async () => {
  await withRunner(async ({ url }) => {
    for (const [method, path] of [
      ['GET', '/containers/json'],
      ['POST', '/v1/containers/create'],
      ['POST', '/v1/sandboxes/1/exec'],
      ['PUT', '/v1/sandboxes/1'],
      ['POST', '/v1/sandboxes'],
      ['DELETE', '/v1/sandboxes'],
      ['GET', '/v1/sandboxes/1/start'],
    ]) {
      const r = await raw(url, path, { method });
      assert.ok([404, 405].includes(r.status), `${method} ${path} -> ${r.status}`);
    }
  });
});

test('docker failures are reported without leaking daemon details', async () => {
  await withRunner(async ({ url, docker }) => {
    docker.create = async () => {
      throw new Error('docker POST /containers/create -> 500: secret-daemon-detail');
    };
    const r = await raw(url, '/v1/sandboxes/1', { method: 'POST', body: {} });
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes('secret-daemon-detail'));
  });
});

test('each user gets their own internal network; the sandbox joins only that one', async () => {
  await withRunner(async ({ client, docker }) => {
    await client.create(1, 'dshu_a');
    docker.state.exists = false; // the fake models one container at a time
    await client.create(7, 'dshu_b');
    assert.deepEqual(Object.keys(docker.state.nets).sort(), ['dsh-net-1', 'dsh-net-7']);
    assert.ok(Object.values(docker.state.nets).every((n) => n.Internal), 'no default route');
    assert.equal(docker.created[0].spec.HostConfig.NetworkMode, 'dsh-net-1');
    assert.equal(docker.created[1].spec.HostConfig.NetworkMode, 'dsh-net-7');
  });
});

test('gateway and llm-proxy are attached to the user network under their role as DNS alias', async () => {
  await withRunner(async ({ client, docker }) => {
    await client.create(1, 'dshu_a');
    assert.deepEqual(docker.state.nets['dsh-net-1'].Containers, {
      gw1: { aliases: ['gateway'], ip: '172.19.255.254' },
      llm1: { aliases: ['llm-proxy'], ip: '172.19.255.253' },
    });
  });
});

test('re-attaches a recreated gateway/llm-proxy on start and on reconcile, and never twice', async () => {
  await withRunner(async ({ client, docker, networks }) => {
    await client.create(1, 'dshu_a');
    // compose recreated both services: new container ids, old ones detached by Docker
    docker.state.nets['dsh-net-1'].Containers = {};
    docker.state.roles = { gateway: [{ Id: 'gw2', State: 'running' }], 'llm-proxy': [{ Id: 'llm2', State: 'running' }] };
    await client.start(1);
    assert.deepEqual(Object.keys(docker.state.nets['dsh-net-1'].Containers).sort(), ['gw2', 'llm2']);
    docker.state.nets['dsh-net-1'].Containers = {};
    await networks.reconcile();
    assert.deepEqual(Object.keys(docker.state.nets['dsh-net-1'].Containers).sort(), ['gw2', 'llm2']);
    let connects = 0;
    const orig = docker.connect;
    docker.connect = async (...a) => (connects++, orig(...a));
    await networks.reconcile();
    assert.equal(connects, 0, 'already attached: nothing to do');
  });
});

test('a stopped or missing shared service is skipped without failing the start', async () => {
  await withRunner(async ({ client, docker }) => {
    docker.state.roles = { gateway: [{ Id: 'gw1', State: 'exited' }], 'llm-proxy': [] };
    await client.create(1, 'dshu_a');
    assert.deepEqual(docker.state.nets['dsh-net-1'].Containers, {});
  });
});

test('DELETE keeps the user network; DELETE ?network=1 removes it', async () => {
  await withRunner(async ({ client, docker, url }) => {
    await client.create(1, 'dshu_a');
    await client.remove(1);
    assert.ok(docker.state.nets['dsh-net-1'], 'recreating a container must not drop the network');
    await client.create(1, 'dshu_a');
    await client.remove(1, { network: true });
    assert.equal(docker.state.nets['dsh-net-1'], undefined);
    assert.equal((await raw(url, '/v1/sandboxes/1?network=1', { method: 'DELETE', secret: null })).status, 401);
  });
});

test('config: shared roles are configurable', () => {
  assert.deepEqual(cfgOf().sharedRoles, ['gateway', 'llm-proxy']);
  assert.deepEqual(cfgOf({ SHARED_ROLES: 'gateway, egress ,' }).sharedRoles, ['gateway', 'egress']);
});

test('pinned addresses: the top usable addresses of the subnet, counting down, one per role', () => {
  assert.equal(pinnedAddress('172.19.0.0/16', 0), '172.19.255.254');
  assert.equal(pinnedAddress('172.19.0.0/16', 1), '172.19.255.253');
  assert.equal(pinnedAddress('10.200.0.16/28', 0), '10.200.0.30');
  assert.equal(pinnedAddress('10.200.0.16/28', 2), '10.200.0.28');
  assert.equal(pinnedAddress('192.168.0.0/24', 0), '192.168.0.254');
  assert.equal(pinnedAddress('172.30.0.0/29', 0), '172.30.0.6');
  // Never the network's gateway (.1) or the bottom where Docker hands out sandbox addresses.
  for (const p of ['172.19.0.0/16', '10.200.0.16/28', '192.168.0.0/24']) assert.ok(!/\.(0|1|2)$/.test(pinnedAddress(p, 2)), p);
  // Too small, not IPv4, or garbage: no pinning rather than a wrong address.
  for (const bad of ['172.30.0.0/30', '172.30.0.0/31', 'fd00::/64', '', null, undefined, 'x', '1.2.3.4/33x']) assert.equal(pinnedAddress(bad, 0), null, String(bad));
});

test('the sandbox gets the shared services as ExtraHosts at their fixed addresses (gVisor cannot use Docker DNS)', async () => {
  await withRunner(async ({ client, docker }) => {
    await client.create(1, 'dshu_a');
    assert.deepEqual(docker.created[0].spec.HostConfig.ExtraHosts, ['gateway:172.19.255.254', 'llm-proxy:172.19.255.253']);
    // The address in /etc/hosts is the one the service really has on that network.
    const net = docker.state.nets['dsh-net-1'].Containers;
    assert.equal(net.gw1.ip, '172.19.255.254');
    assert.equal(net.llm1.ip, '172.19.255.253');
  });
});

test('addresses follow the network subnet, whatever Docker allocated', async () => {
  await withRunner(async ({ client, docker }) => {
    docker.state.subnet = '10.200.0.16/28';
    await client.create(1, 'dshu_a');
    assert.deepEqual(docker.created[0].spec.HostConfig.ExtraHosts, ['gateway:10.200.0.30', 'llm-proxy:10.200.0.29']);
  });
});

test('a recreated service comes back at the same address, so running sandboxes keep a valid /etc/hosts', async () => {
  await withRunner(async ({ client, docker, networks }) => {
    await client.create(1, 'dshu_a');
    docker.state.nets['dsh-net-1'].Containers = {};
    docker.state.roles = { gateway: [{ Id: 'gw9', State: 'running' }], 'llm-proxy': [{ Id: 'llm9', State: 'running' }] };
    await networks.reconcile();
    const c = docker.state.nets['dsh-net-1'].Containers;
    assert.equal(c.gw9.ip, '172.19.255.254');
    assert.equal(c.llm9.ip, '172.19.255.253');
  });
});

test('a service attached earlier at a dynamic address is moved to its fixed one; one already right is left alone', async () => {
  await withRunner(async ({ client, docker, networks }) => {
    await client.create(1, 'dshu_a');
    docker.state.nets['dsh-net-1'].Containers.gw1 = { aliases: ['gateway'], ip: '172.19.0.3' }; // attached before pinning existed
    const calls = [];
    const [c, d] = [docker.connect, docker.disconnect];
    docker.connect = async (...a) => (calls.push(['connect', a[1]]), c(...a));
    docker.disconnect = async (...a) => (calls.push(['disconnect', a[1]]), d(...a));
    await networks.reconcile();
    assert.deepEqual(calls, [['disconnect', 'gw1'], ['connect', 'gw1']], 'only the misplaced one moves');
    assert.equal(docker.state.nets['dsh-net-1'].Containers.gw1.ip, '172.19.255.254');
    await networks.reconcile();
    assert.equal(calls.length, 2, 'second pass is a no-op');
  });
});

test('a subnet too small to pin gets no ExtraHosts and no fixed addresses, and the start still works', async () => {
  await withRunner(async ({ client, docker }) => {
    docker.state.subnet = '172.30.0.0/30';
    await client.create(1, 'dshu_a');
    assert.deepEqual(docker.created[0].spec.HostConfig.ExtraHosts, []);
  });
});

test('ExtraHosts are computed by the runner; a caller cannot add hosts', async () => {
  await withRunner(async ({ url, docker }) => {
    const r = await raw(url, '/v1/sandboxes/1', { method: 'POST', body: { llmToken: 'dshu_a', ExtraHosts: ['evil:1.2.3.4'], hosts: { evil: '1.2.3.4' } } });
    assert.equal(r.status, 201);
    assert.ok(!JSON.stringify(docker.created[0].spec).includes('evil'));
  });
});

test('egress proxy: sandbox gets proxy env only when configured; internal services bypass it', () => {
  const off = buildSpec(cfgOf(), 1);
  assert.ok(!off.Env.some((e) => /PROXY/i.test(e.split('=')[0]) && !e.startsWith('LLM_')), 'no proxy env by default');
  const cfg = cfgOf({ EGRESS_PROXY_URL: 'http://egress-proxy:3128/', SHARED_ROLES: 'gateway,llm-proxy,egress-proxy' });
  const env = Object.fromEntries(buildSpec(cfg, 1, 'tok', { 'egress-proxy': '172.19.255.252' }).Env.map((e) => e.split(/=(.*)/s).slice(0, 2)));
  assert.equal(env.HTTP_PROXY, 'http://egress-proxy:3128');
  assert.equal(env.HTTPS_PROXY, 'http://egress-proxy:3128');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,gateway,llm-proxy');
  const hosts = buildSpec(cfg, 1, 'tok', { 'egress-proxy': '172.19.255.252' }).HostConfig.ExtraHosts;
  assert.deepEqual(hosts, ['egress-proxy:172.19.255.252']);
});

test('GET /v1/usage: bytes per user over both volumes; ignores other volumes and uncomputed sizes; needs the secret', async () => {
  const docker = fakeDocker();
  docker.volumes = async () => [
    { Name: 'dsh-data-1', Size: 100 }, { Name: 'dsh-ws-1', Size: 400 }, { Name: 'dsh-ws-2', Size: 7 },
    { Name: 'dsh-ws-3', Size: -1 }, { Name: 'dshcloud_llm-admin', Size: 5000 }, { Name: 'dsh-ws-x', Size: 9 },
  ];
  const server = createRunner({ cfg: cfgOf(), docker, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/usage`;
    assert.equal((await fetch(url)).status, 401);
    const r = await fetch(url, { headers: { authorization: `Bearer ${SECRET}` } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).sort((a, b) => a.userId - b.userId), [{ userId: 1, bytes: 500 }, { userId: 2, bytes: 7 }]);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } })).status, 405);
  } finally {
    server.close();
  }
});

test('GET /v1/sandboxes/:id/activity: cumulative CPU and memory of the running container; 404 for none; needs the secret', async () => {
  const docker = fakeDocker();
  docker.stats = async (name) => (name === 'dsh-sbx-5' ? { cpuNs: 123456789, memBytes: 2048 } : null);
  const server = createRunner({ cfg: cfgOf(), docker, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = (id) => `http://127.0.0.1:${server.address().port}/v1/sandboxes/${id}/activity`;
    const auth = { headers: { authorization: `Bearer ${SECRET}` } };
    assert.equal((await fetch(url(5))).status, 401);
    const ok = await fetch(url(5), auth);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { cpuNs: 123456789, memBytes: 2048 });
    assert.equal((await fetch(url(6), auth)).status, 404);
    assert.equal((await fetch(url('abc'), auth)).status, 400, 'ids are validated');
    assert.equal((await fetch(url(5), { ...auth, method: 'POST' })).status, 404, 'read-only route');
  } finally {
    server.close();
  }
});

test('RunnerClient.activity returns the sample and fails with the status on an error', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.authorization }); return url.endsWith('/9/activity') ? new Response('{"error":"no such sandbox"}', { status: 404 }) : new Response('{"cpuNs":42,"memBytes":7}', { status: 200 }); };
  const c = new RunnerClient({ url: 'http://runner:8090/', secret: SECRET, fetchImpl });
  assert.deepEqual(await c.activity(4), { cpuNs: 42, memBytes: 7 });
  assert.equal(calls[0].url, 'http://runner:8090/v1/sandboxes/4/activity');
  await assert.rejects(c.activity(9), /404/);
});

test('runtime warning: plain runc (or the daemon default) warns that the shell tool will not work; gVisor and others do not', async () => {
  const { runtimeWarning } = await import('../../runner/src/config.js');
  for (const rt of ['runc', '']) assert.match(runtimeWarning(cfgOf({ SANDBOX_RUNTIME: rt })), /runc.*shell tool will not work.*SANDBOX_RUNTIME=runsc/s, JSON.stringify(rt));
  assert.equal(runtimeWarning(cfgOf({})) !== null, true, 'the default is runc, so it warns');
  for (const rt of ['runsc', 'kata']) assert.equal(runtimeWarning(cfgOf({ SANDBOX_RUNTIME: rt })), null, rt);
});

test('model output limit: defaults to 16384 (the proxy cap), is configurable, and reaches the sandbox environment', () => {
  assert.equal(cfgOf().modelMaxOutputTokens, 16384);
  assert.equal(cfgOf({ MODEL_MAX_OUTPUT_TOKENS: '' }).modelMaxOutputTokens, 16384, 'empty means default (compose passes a default anyway)');
  assert.equal(cfgOf({ MODEL_MAX_OUTPUT_TOKENS: '8192' }).modelMaxOutputTokens, 8192);
  assert.ok(buildSpec(cfgOf(), 1).Env.includes('DSH_MODEL_MAX_TOKENS=16384'));
  assert.ok(buildSpec(cfgOf({ MODEL_MAX_OUTPUT_TOKENS: '8192' }), 1).Env.includes('DSH_MODEL_MAX_TOKENS=8192'));
});

test('model display name: a friendly default for the free router, an override, validation, and it reaches the sandbox environment', () => {
  assert.equal(cfgOf().modelDisplayName, 'Free models (automatic)');
  assert.equal(cfgOf({ MODEL_DISPLAY_NAME: '' }).modelDisplayName, 'Free models (automatic)', 'empty means default (compose passes an empty value)');
  assert.equal(cfgOf({ MODEL_DISPLAY_NAME: 'Team model' }).modelDisplayName, 'Team model');
  assert.equal(cfgOf({ DEFAULT_MODEL: 'deepseek/deepseek-chat' }).modelDisplayName, '', 'no invented name for other models');
  for (const bad of ['a"b', 'x\ny', '- id: z', '$(id)', 'x'.repeat(61)]) assert.throws(() => cfgOf({ MODEL_DISPLAY_NAME: bad }), /MODEL_DISPLAY_NAME/, bad);
  assert.ok(buildSpec(cfgOf(), 1).Env.includes('DSH_MODEL_NAME=Free models (automatic)'));
  assert.ok(!buildSpec(cfgOf({ DEFAULT_MODEL: 'other/model' }), 1).Env.some((e) => e.startsWith('DSH_MODEL_NAME=')));
});
