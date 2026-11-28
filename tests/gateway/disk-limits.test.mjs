// SEC-08 (docs/security-review.md): the disk check fails closed, runs more often near the limit, and a total cap holds new starts. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { SandboxProblem } from '../../gateway/src/states.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const MB = 1024 * 1024;

function world(t, env = {}, keyOf = () => '') {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  const cfg = { ...loadConfig({ ...base, MAX_DISK_MB: '1000', DISK_CHECK_SECONDS: '300', ...env }), startTimeoutSeconds: 0.05 };
  const st = { fail: false, calls: 0, rows: [], boxes: new Map([[1, true]]), stopped: [], started: [] };
  const runner = {
    async diskUsage() { st.calls++; if (st.fail) throw new Error('docker busy'); return st.rows; },
    async list() { return [...st.boxes].map(([userId, running]) => ({ userId, running })); },
    async info(id) { return st.boxes.has(id) ? { running: st.boxes.get(id), startedAt: 'x', llmManaged: true, volumeKey: '' } : null; },
    async create(id) { st.boxes.set(id, false); },
    async start(id) { st.started.push(id); },
    async stop(id) { st.stopped.push(id); st.boxes.set(id, false); },
    async logs() { return ''; },
  };
  const audit = [];
  const m = new SandboxManager({ runner, cfg, log: () => {}, audit: { record: (e, d) => audit.push({ e, ...d }) }, volumeKeyOf: keyOf });
  const tick = async (seconds) => { t.mock.timers.tick(seconds * 1000); await m.enforceLimits(await runner.list()); };
  return { m, st, audit, tick, cfg };
}

test('a failed measurement is not "under the limit": after three in a row no new workspace is started; a success clears it', async (t) => {
  const w = world(t);
  w.st.fail = true;
  await w.tick(301); await w.tick(301);
  await w.m.ensure(2).catch(() => {}); // two failures: noise, a start still goes ahead
  assert.deepEqual(w.st.started, [2]);
  await w.tick(301); // third
  assert.ok(w.audit.some((a) => a.e === 'disk.blind'));
  const refused = await w.m.ensure(3).catch((e) => e);
  assert.ok(refused instanceof SandboxProblem && refused.code === 'service_unavailable', String(refused));
  assert.equal(w.m.status(3).problem.code, 'service_unavailable');
  assert.deepEqual(w.st.started, [2], 'user 3 was not started');
  assert.equal(w.m.state(1), 'stopped'); // (running ones are untouched: nothing here stopped them)
  assert.deepEqual(w.st.stopped, []);
  w.st.fail = false;
  await w.tick(301);
  assert.ok(w.audit.some((a) => a.e === 'disk.check_recovered'));
  await w.m.ensure(3).catch(() => {});
  assert.deepEqual(w.st.started, [2, 3], 'started again once the check works');
  assert.equal(w.audit.filter((a) => a.e === 'disk.check_failed').length, 1, 'the first failure is recorded once, not every time');
});

test('the check is skipped when the limit is off, and a failure then is not held against anyone', async (t) => {
  const w = world(t, { MAX_DISK_MB: '0' });
  w.st.fail = true;
  for (let i = 0; i < 4; i++) await w.tick(301);
  assert.equal(w.st.calls, 0);
  await w.m.ensure(2).catch(() => {});
  assert.deepEqual(w.st.started, [2]);
});

test('someone within 20% of the limit is checked every 30 seconds, not every 5 minutes; when they are not, back to the usual interval', async (t) => {
  const w = world(t);
  w.st.rows = [{ userId: 1, key: '', bytes: 900 * MB }]; // 90%
  await w.tick(301);
  assert.equal(w.st.calls, 1);
  await w.tick(29);
  assert.equal(w.st.calls, 1, 'not yet');
  await w.tick(2);
  assert.equal(w.st.calls, 2, '30 seconds later, because the user is close');
  w.st.rows = [{ userId: 1, key: '', bytes: 100 * MB }];
  await w.tick(31);
  assert.equal(w.st.calls, 3);
  await w.tick(100);
  assert.equal(w.st.calls, 3, 'the usual 300 seconds again');
  await w.tick(201);
  assert.equal(w.st.calls, 4);
});

test('over the limit still stops the user, and only for their own volumes', async (t) => {
  const w = world(t, {}, (id) => (id === 1 ? 'bbbbbbbbbbbbbbbb' : ''));
  w.st.rows = [{ userId: 1, key: 'aaaaaaaaaaaaaaaa', bytes: 5000 * MB }, { userId: 1, key: 'bbbbbbbbbbbbbbbb', bytes: 10 * MB }];
  await w.tick(301);
  assert.deepEqual(w.st.stopped, [], 'the predecessor\'s 5 GB is not this account\'s');
  w.st.rows = [{ userId: 1, key: 'bbbbbbbbbbbbbbbb', bytes: 1200 * MB }];
  await w.tick(301);
  assert.deepEqual(w.st.stopped, [1]);
});

test('the total cap: at or over it no new workspace starts (orphaned volumes count), under it they do', async (t) => {
  const w = world(t, { MAX_TOTAL_DISK_MB: '2000', MAX_DISK_MB: '5000' }, (id) => (id === 1 ? 'bbbbbbbbbbbbbbbb' : ''));
  w.st.rows = [{ userId: 1, key: 'bbbbbbbbbbbbbbbb', bytes: 500 * MB }, { userId: 9, key: 'cccccccccccccccc', bytes: 1600 * MB }]; // 2100 MB with an orphan
  await w.tick(301);
  assert.ok(w.audit.some((a) => a.e === 'disk.full' && a.capMb === 2000));
  const refused = await w.m.ensure(2).catch((e) => e);
  assert.ok(refused instanceof SandboxProblem && /storage on the server is full/.test(refused.message), String(refused));
  assert.deepEqual(w.st.started, []);
  w.st.rows = [{ userId: 1, key: 'bbbbbbbbbbbbbbbb', bytes: 500 * MB }];
  await w.tick(301);
  await w.m.ensure(2).catch(() => {});
  assert.deepEqual(w.st.started, [2]);
});

test('the total cap works with no per-user limit, and is off by default', async (t) => {
  const off = world(t, { MAX_DISK_MB: '0' });
  off.st.rows = [{ userId: 1, key: '', bytes: 99999 * MB }];
  await off.tick(301);
  assert.equal(off.st.calls, 0, 'nothing is measured when both are off');
  t.mock.timers.reset(); // world() starts a fresh clock
  const capOnly = world(t, { MAX_DISK_MB: '0', MAX_TOTAL_DISK_MB: '100' });
  capOnly.st.rows = [{ userId: 1, key: '', bytes: 200 * MB }];
  await capOnly.tick(301);
  assert.equal(capOnly.m.diskFull, true);
  assert.deepEqual(capOnly.st.stopped, [], 'it holds new starts only; nobody running is stopped for it');
});
