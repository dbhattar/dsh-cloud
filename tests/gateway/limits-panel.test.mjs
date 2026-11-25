// P5-3: what the usage panel gets (/gw/api/limits), and the Stop and Restart behaviour behind its buttons. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const MB = 1024 * 1024;
// START_TIMEOUT_SECONDS is short so the paths that really try to start a sandbox fail fast (there is nothing to answer in a unit test).
const cfgOf = (extra = {}) => loadConfig({ ...base, MAX_RUN_SECONDS: '3600', MAX_DISK_MB: '100', DISK_CHECK_SECONDS: '300', START_TIMEOUT_SECONDS: '1', ...extra });
const usage = (dayUsed) => ({ userId: 1, day: { used: dayUsed, limit: 1000, resetsAt: '2026-06-11T00:00:00.000Z' }, month: { used: 100, limit: 10000, resetsAt: '2026-07-01T00:00:00.000Z' }, exhausted: dayUsed >= 1000, blockedBy: dayUsed >= 1000 ? 'day' : null, global: { used: 5, limit: 9, exhausted: false, resetsAt: '2026-06-11T00:00:00.000Z' } });

function fakeRunner(state = {}) {
  const st = { running: true, bytes: 10 * MB, diskCalls: 0, stopped: [], started: [], ...state };
  return {
    st,
    async info() { return st.running ? { running: true, startedAt: new Date().toISOString(), llmManaged: true } : null; },
    async list() { return []; },
    async create() {}, async remove() {},
    async start(id) { st.started.push(id); st.running = true; },
    async stop(id) { st.stopped.push(id); st.running = false; },
    async logs() { return 'dsh web: https://localhost/?token=abc_DEF-123\n'; },
    async diskUsage() { st.diskCalls++; if (st.diskFails) throw new Error('docker busy'); return [{ userId: 1, bytes: st.bytes }]; },
  };
}
const manager = (runner, extra = {}, llm = { usage: async () => usage(100) }) => new SandboxManager({ runner, cfg: cfgOf(extra), log: () => {}, llm });

test('limits: tokens, storage, run time and workspace state in one payload; the shared budget is reduced', async () => {
  const m = manager(fakeRunner());
  m.cache.set(1, { cookie: 'c', startedAt: new Date(Date.now() - 600_000).toISOString(), checkedAt: Date.now() });
  const l = await m.limits(1);
  assert.equal(l.workspace.state, 'running');
  assert.equal(l.tokens.day.used, 100);
  assert.deepEqual(l.tokens.global, { exhausted: false, resetsAt: '2026-06-11T00:00:00.000Z' }, 'no shared totals');
  assert.deepEqual({ usedBytes: l.storage.usedBytes, limitBytes: l.storage.limitBytes }, { usedBytes: 10 * MB, limitBytes: 100 * MB });
  assert.equal(l.run.maxSeconds, 3600);
  assert.ok(Math.abs(l.run.secondsLeft - 3000) <= 2, `about 50 minutes left, got ${l.run.secondsLeft}`);
  assert.equal(l.problem, null);
  assert.deepEqual(l.warnings, []);
});

test('limits: warnings appear as limits near; an exhausted allowance is the problem, not a warning', async () => {
  const runner = fakeRunner({ bytes: 90 * MB });
  const m = manager(runner, {}, { usage: async () => usage(850) });
  m.cache.set(1, { cookie: 'c', startedAt: new Date(Date.now() - 3600_000 + 300_000).toISOString(), checkedAt: Date.now() });
  const l = await m.limits(1);
  assert.deepEqual(l.warnings.map((w) => w.code).sort(), ['run_time_low', 'storage_high', 'tokens_day_high']);
  const spent = await manager(fakeRunner(), {}, { usage: async () => usage(1000) }).limits(1);
  assert.equal(spent.problem.code, 'quota_day');
  assert.ok(!spent.warnings.some((w) => w.code.startsWith('tokens_day')));
});

test('limits: parts that cannot be known are null, and a failing source does not fail the call', async () => {
  const runner = fakeRunner({ diskFails: true });
  const m = manager(runner, { MAX_RUN_SECONDS: '0', MAX_DISK_MB: '0' }, { usage: async () => { throw new Error('proxy down'); } });
  const l = await m.limits(1);
  assert.equal(l.tokens, null);
  assert.equal(l.storage, null);
  assert.equal(l.run, null, 'not running here, and no run limit');
  assert.deepEqual(l.warnings, []);
  const noMetering = await new SandboxManager({ runner: fakeRunner(), cfg: cfgOf(), log: () => {} }).limits(1);
  assert.equal(noMetering.tokens, null, 'metering is off');
  assert.equal(noMetering.storage.limitBytes, 100 * MB, 'the other numbers still work');
});

test('limits: the storage lookup is cached for a minute, because Docker computes volume sizes on demand', async () => {
  const runner = fakeRunner();
  const m = manager(runner);
  await m.limits(1); await m.limits(1); await m.limits(1);
  assert.equal(runner.st.diskCalls, 1);
});

test('stopAndHold: the workspace stays stopped when the open page asks again; an explicit start, or visiting the app again, ends it', async () => {
  const runner = fakeRunner();
  const m = manager(runner);
  await m.stopAndHold(1);
  assert.deepEqual(runner.st.stopped, [1]);
  await assert.rejects(m.ensure(1), /You stopped your workspace/, 'a background request does not wake it');
  assert.equal(runner.st.started.length, 0);
  const s = m.status(1);
  assert.equal(s.problem.code, 'stopped_user');
  assert.equal(s.problem.action.kind, 'restart');
  assert.equal(s.problem.severity, 'info');
  m.releaseUserHold(1); // the user visits the app again
  assert.equal(m.status(1).problem, null);
  assert.equal(m.held.has(1), false);
});

test('stopAndHold then an explicit start works, and a limit hold is NOT released by visiting', async () => {
  const runner = fakeRunner();
  const m = manager(runner);
  await m.stopAndHold(1);
  m.held.set(2, 'limit'); m.problems.set(2, { code: 'stopped_run_time', params: {} });
  m.releaseUserHold(2);
  assert.equal(m.held.has(2), true, 'only a stop the user asked for is released');
  m.runner.info = async () => ({ running: false, startedAt: 'x', llmManaged: true });
  m.name = () => '127.0.0.1';
  const started = m.ensure(1, { explicit: true }).catch(() => {}); // there is no sandbox to answer in a unit test; what matters is that the hold was cleared
  assert.equal(m.held.has(1), false);
  await started;
});

test('restart: stops a running workspace, audits it, clears any hold and starts again', async () => {
  const events = [];
  const runner = fakeRunner();
  const m = new SandboxManager({ runner, cfg: cfgOf(), log: () => {}, llm: null, audit: { record: (e, d) => events.push({ e, ...d }) } });
  m.name = () => '127.0.0.1';
  m.held.set(1, 'You stopped your workspace.');
  const { done } = await m.restart(1);
  await done.catch(() => {}); // nothing answers in a unit test, so the start times out; the point is that it was asked for
  assert.deepEqual(runner.st.stopped, [1]);
  assert.ok(events.some((x) => x.e === 'sandbox.stop' && x.by === 'user_restart'));
  assert.ok(events.some((x) => x.e === 'sandbox.restart'));
  assert.equal(m.held.has(1), false);
  assert.ok(runner.st.started.includes(1), 'the start was asked for');
});

// ---- the HTTP surface ----
async function gateway(managerImpl) {
  const store = new Store(':memory:');
  const uid = store.createUser('u@example.com', 'x');
  const server = createGateway({ cfg: { ...cfgOf(), allowSignup: true }, store, manager: managerImpl, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cookie = `gw_session=${store.createSession(uid, 60)}`;
  const call = (path, init = {}, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...init, headers: { cookie, ...headers } });
  return { uid, call, close: () => { server.closeAllConnections(); server.close(); } };
}

test('HTTP: /gw/api/limits needs a session and returns the manager\'s payload for the caller only', async () => {
  const asked = [];
  const g = await gateway({ touch() {}, limits: async (id) => { asked.push(id); return { workspace: { state: 'running' }, warnings: [] }; } });
  try {
    const r = await g.call('/gw/api/limits');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { workspace: { state: 'running' }, warnings: [] });
    assert.deepEqual(asked, [g.uid], 'the user id comes from the session');
    const noCookie = await fetch(r.url);
    assert.equal(noCookie.status, 401);
  } finally { g.close(); }
});

test('HTTP: Stop with hold=1 holds, plain Stop does not, Restart restarts; visiting the app (a document navigation) releases a hold', async () => {
  const calls = [];
  const g = await gateway({
    touch() {},
    runner: { info: async () => ({ running: true }) },
    stop: async (id, by) => calls.push(['stop', id, by]),
    stopAndHold: async (id) => calls.push(['hold', id]),
    restart: async (id) => { calls.push(['restart', id]); return { done: Promise.resolve() }; },
    status: () => ({ state: 'starting' }),
    releaseUserHold: (id) => calls.push(['release', id]),
    ready: async () => null,
    ensure: () => Promise.resolve(),
  });
  try {
    assert.equal((await g.call('/gw/api/stop?hold=1', { method: 'POST' })).status, 200);
    assert.equal((await g.call('/gw/api/stop', { method: 'POST' })).status, 200);
    assert.equal((await g.call('/gw/api/restart', { method: 'POST' })).status, 202);
    await g.call('/some/page', {}, { 'sec-fetch-dest': 'document', accept: 'text/html' });
    await g.call('/some/page', {}, { 'sec-fetch-dest': 'iframe', accept: 'text/html' });
    assert.deepEqual(calls, [['hold', g.uid], ['stop', g.uid, 'user'], ['restart', g.uid], ['release', g.uid]], 'the iframe request did not release the hold');
  } finally { g.close(); }
});
