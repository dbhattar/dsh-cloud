// SEC-09 (docs/security-review.md): the gateway never attaches an account to a container or volumes that belong to another account with
// the same id, and charges disk only for the account's own volumes. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { RunnerClient } from '../../gateway/src/runner.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };

test('every new account gets its own random 16-character key, and accounts that predate keys have none', () => {
  const s = new Store(':memory:');
  const keys = [1, 2, 3, 4, 5].map((i) => s.volumeKey(s.createUser(`u${i}@example.com`, 'x')));
  for (const k of keys) assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(new Set(keys).size, 5, 'all different');
  s.db.prepare("INSERT INTO users (email, pw_hash, created_at, vol_key) VALUES ('old@example.com', 'x', 1, NULL)").run();
  assert.equal(s.volumeKey(Number(s.userByEmail('old@example.com').id)), '', 'a legacy account keeps the old volume names');
  assert.equal(s.volumeKey(999), '', 'and an unknown id has none');
});

test('a database made before keys existed is upgraded in place: the column appears and existing accounts stay on their old names', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gw-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO users (email, pw_hash, created_at) VALUES ('a@example.com', 'x', 1)");
  old.close();
  const s = new Store(file);
  assert.equal(s.volumeKey(1), '');
  assert.match(s.volumeKey(s.createUser('b@example.com', 'x')), /^[0-9a-f]{16}$/);
});

/** A manager over a fake runner whose container 1 is described by `existing`; a start fails fast after admission (there is no real harness). */
function world(existing, keyOf) {
  const calls = [];
  const state = { info: existing };
  const runner = {
    async info() { calls.push('info'); return state.info; },
    async create(id, token, volumeKey) { calls.push(`create:${volumeKey}`); state.info = { running: false, volumeKey, llmManaged: true, startedAt: 'x' }; },
    async remove() { calls.push('remove'); state.info = null; },
    async start() { calls.push('start'); },
    async list() { return []; },
    async logs() { return ''; },
  };
  const audit = [];
  const m = new SandboxManager({ runner, cfg: { ...loadConfig(base), startTimeoutSeconds: 0.05 }, log: () => {}, audit: { record: (e, d) => audit.push({ e, ...d }) }, volumeKeyOf: keyOf });
  return { m, calls, audit };
}

test('a container that mounts another account\'s volumes is removed and replaced, never reused', async () => {
  const w = world({ running: false, volumeKey: 'aaaaaaaaaaaaaaaa', llmManaged: true, startedAt: 'x' }, () => 'bbbbbbbbbbbbbbbb');
  await w.m.ensure(1).catch(() => {});
  assert.deepEqual(w.calls.filter((c) => c !== 'info').slice(0, 3), ['remove', 'create:bbbbbbbbbbbbbbbb', 'start'], 'removed, recreated with this account\'s key, then started');
  assert.ok(w.audit.some((a) => a.e === 'sandbox.recreate' && a.reason === 'volume_key'));
});

test('a container that matches the account is reused (the key, or none for an account that predates keys)', async () => {
  for (const key of ['bbbbbbbbbbbbbbbb', '']) {
    const w = world({ running: false, volumeKey: key, llmManaged: true, startedAt: 'x' }, () => key);
    await w.m.ensure(1).catch(() => {});
    assert.ok(!w.calls.includes('remove') && !w.calls.some((c) => c.startsWith('create')), `key ${JSON.stringify(key)}: nothing was removed or created`);
  }
});

test('a legacy container (no key) is not given to an account that has one, nor the reverse', async () => {
  const keyed = world({ running: false, volumeKey: '', llmManaged: true, startedAt: 'x' }, () => 'bbbbbbbbbbbbbbbb');
  await keyed.m.ensure(1).catch(() => {});
  assert.ok(keyed.calls.includes('remove'));
  const legacy = world({ running: false, volumeKey: 'aaaaaaaaaaaaaaaa', llmManaged: true, startedAt: 'x' }, () => '');
  await legacy.m.ensure(1).catch(() => {});
  assert.ok(legacy.calls.includes('remove'));
});

test('disk is charged only for the account\'s own volumes: a predecessor\'s leftovers do not count against a new account', async () => {
  const rows = [
    { userId: 1, key: 'aaaaaaaaaaaaaaaa', bytes: 5_000_000_000 }, // what the previous owner of id 1 left behind
    { userId: 1, key: 'bbbbbbbbbbbbbbbb', bytes: 100 },
    { userId: 2, key: '', bytes: 70 }, // a legacy account
    { userId: 3, key: 'cccccccccccccccc', bytes: 9 }, // an account this database does not have the key of
  ];
  const keys = { 1: 'bbbbbbbbbbbbbbbb', 2: '', 3: 'dddddddddddddddd' };
  const m = new SandboxManager({ runner: { diskUsage: async () => rows }, cfg: loadConfig(base), log: () => {}, volumeKeyOf: (id) => keys[id] });
  assert.deepEqual((await m.diskUsage()).sort((a, b) => a.userId - b.userId), [{ userId: 1, bytes: 100 }, { userId: 2, bytes: 70 }]);
});

test('the runner client sends the key on create and only then', async () => {
  const bodies = [];
  const client = new RunnerClient({ url: 'http://r', secret: 's', fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body ?? '{}')); return { ok: true, status: 201, json: async () => ({}) }; } });
  await client.create(1, 'tok', 'bbbbbbbbbbbbbbbb');
  await client.create(2, undefined, '');
  assert.deepEqual(bodies, [{ llmToken: 'tok', volumeKey: 'bbbbbbbbbbbbbbbb' }, {}]);
});
