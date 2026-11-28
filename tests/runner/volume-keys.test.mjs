// SEC-09 (docs/security-review.md): volume names carry a per-account key, so a reused user id can never mount a previous owner's volumes.
// No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../runner/src/config.js';
import { createRunner } from '../../runner/src/server.js';
import { buildSpec, volumeNames } from '../../runner/src/spec.js';

const SECRET = 'runner-secret-0123456789';
const cfg = loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_SECRET: SECRET, LLM_PROXY_URL: 'http://llm-proxy:8081/' });
const KEY_A = '0123456789abcdef';
const KEY_B = 'fedcba9876543210';

test('names: with a key the id is not enough; without one (accounts that predate keys) the old names are kept', () => {
  assert.deepEqual(volumeNames(7, KEY_A), { data: `dsh-data-7-${KEY_A}`, ws: `dsh-ws-7-${KEY_A}` });
  assert.deepEqual(volumeNames(7), { data: 'dsh-data-7', ws: 'dsh-ws-7' });
  assert.deepEqual(volumeNames(7, ''), { data: 'dsh-data-7', ws: 'dsh-ws-7' });
});

test('two accounts with the same id (a new or older database reused it) never share a volume, and neither touches the legacy volumes', () => {
  const old = buildSpec(cfg, 1, undefined, {}, KEY_A).HostConfig.Binds;
  const fresh = buildSpec(cfg, 1, undefined, {}, KEY_B).HostConfig.Binds;
  const legacy = buildSpec(cfg, 1).HostConfig.Binds;
  const volume = (b) => b.map((x) => x.split(':')[0]);
  for (const [x, y] of [[old, fresh], [old, legacy], [fresh, legacy]]) assert.ok(volume(x).every((v) => !volume(y).includes(v)), `${x} vs ${y}`);
  assert.deepEqual(fresh, [`dsh-data-1-${KEY_B}:/data/dsh`, `dsh-ws-1-${KEY_B}:/workspace`]);
});

test('the key is recorded on the container, so the gateway can tell whose volumes it mounts', () => {
  assert.equal(buildSpec(cfg, 2, undefined, {}, KEY_A).Labels['dsh-cloud.vkey'], KEY_A);
  assert.equal(buildSpec(cfg, 2).Labels['dsh-cloud.vkey'], undefined);
});

function fakeDocker() {
  const created = [];
  return {
    created,
    async inspect() { return created.length ? { State: { Running: false }, Config: { Labels: created.at(-1).spec.Labels }, HostConfig: { Runtime: created.at(-1).spec.HostConfig.Runtime } } : null; },
    async create(name, spec) { created.push({ name, spec }); },
    async inspectNetwork() { return null; },
    async createInternalNetwork() { return { Id: 'n1' }; },
    async listNetworks() { return []; },
    async list() { return []; },
    async volumes() { return []; },
    async connectNetwork() {},
    async removeNetwork() {},
  };
}

async function withRunner(docker, fn) {
  const server = createRunner({ cfg, docker, log: () => {}, networks: { ensure: async () => ({}), attachShared: async () => {}, remove: async () => {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = (path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...init, headers: { authorization: `Bearer ${SECRET}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  try { await fn(call, docker); } finally { server.closeAllConnections(); server.close(); }
}

test('create takes a volume key, refuses anything that is not 16 hex characters, and info reports it back', async () => {
  await withRunner(fakeDocker(), async (call, docker) => {
    for (const bad of ['short', 'ZZZZZZZZZZZZZZZZ', `${KEY_A}00`, '../../etc', 42, ['a']]) {
      const r = await call('/v1/sandboxes/1', { method: 'POST', body: JSON.stringify({ volumeKey: bad }) });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(docker.created.length, 0, 'nothing was created for a bad key');
    assert.equal((await call('/v1/sandboxes/1', { method: 'POST', body: JSON.stringify({ volumeKey: KEY_A }) })).status, 201);
    assert.deepEqual(docker.created[0].spec.HostConfig.Binds, [`dsh-data-1-${KEY_A}:/data/dsh`, `dsh-ws-1-${KEY_A}:/workspace`]);
    assert.equal((await (await call('/v1/sandboxes/1')).json()).volumeKey, KEY_A);
  });
  await withRunner(fakeDocker(), async (call) => {
    assert.equal((await call('/v1/sandboxes/1', { method: 'POST', body: JSON.stringify({}) })).status, 201, 'no key: an account that predates keys');
    assert.equal((await (await call('/v1/sandboxes/1')).json()).volumeKey, '');
  });
});

test('usage is one row per account volume set, so two accounts with the same id are charged separately', async () => {
  const docker = fakeDocker();
  docker.volumes = async () => [
    { Name: 'dsh-data-1', Size: 10 }, { Name: 'dsh-ws-1', Size: 20 },
    { Name: `dsh-data-1-${KEY_A}`, Size: 100 }, { Name: `dsh-ws-1-${KEY_A}`, Size: 200 },
    { Name: `dsh-ws-2-${KEY_B}`, Size: 7 }, { Name: 'dsh-ws-3-short', Size: 9 }, { Name: 'dshcloud_llm-admin', Size: 5000 },
  ];
  await withRunner(docker, async (call) => {
    const rows = (await (await call('/v1/usage')).json()).sort((a, b) => a.userId - b.userId || a.key.localeCompare(b.key));
    assert.deepEqual(rows, [{ userId: 1, key: '', bytes: 30 }, { userId: 1, key: KEY_A, bytes: 300 }, { userId: 2, key: KEY_B, bytes: 7 }]);
  });
});
