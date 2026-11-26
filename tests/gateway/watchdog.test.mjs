// P5-10: the crash watchdog. A sandbox that exits on its own is restarted at once while the user is around, explained, and
// held when it keeps happening. No Docker needed: a fake runner stands in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { classifyFailure, crashNotice, noticeFor, problemFor } from '../../gateway/src/states.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };

function setup(t, extra = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  const cfg = loadConfig({ ...base, IDLE_SECONDS: '100', ...extra });
  const state = { running: true, exit: { exitCode: 2, oomKilled: false }, starts: 0, audit: [], stopped: [] };
  const runner = {
    async list() { return [{ userId: 1, running: state.running }]; },
    async info() { return { running: state.running, startedAt: String(state.starts), llmManaged: true, ...(state.running ? {} : state.exit) }; },
    async start() { state.starts += 1; state.running = true; },
    async stop() { state.running = false; state.stopped.push(1); },
    async logs() { return 'http://x/?token=abc'; },
  };
  const audit = { record: (event, d) => state.audit.push({ event, ...d }) };
  const m = new SandboxManager({ runner, cfg, log() {}, audit });
  m.cache.set(1, { cookie: 'c', startedAt: '0', checkedAt: Date.now(), host: 'h', port: 1 });
  m.touch(1);
  // The restart itself needs a real sandbox to answer the token exchange; stub it so the test is about the decision.
  const ensured = [];
  m.ensure = (id) => { ensured.push(id); m.cache.set(id, { cookie: 'c', startedAt: String(state.starts), checkedAt: Date.now() }); state.running = true; return Promise.resolve(); };
  return { m, state, ensured, tick: (s) => t.mock.timers.tick(s * 1000) };
}
const crash = (env, exit) => { env.state.running = false; if (exit) env.state.exit = exit; };
const events = (env, name) => env.state.audit.filter((a) => a.event === name);

test('config: the watchdog defaults', () => {
  const c = loadConfig(base);
  assert.deepEqual([c.watchdogSeconds, c.crashMaxRestarts, c.crashWindowSeconds], [5, 3, 600]);
  assert.equal(loadConfig({ ...base, WATCHDOG_SECONDS: '0' }).watchdogSeconds, 0);
});

test('a running sandbox is left alone', async (t) => {
  const env = setup(t);
  await env.m.watch();
  assert.deepEqual(env.ensured, []);
  assert.equal(events(env, 'sandbox.crashed').length, 0);
});

test('a crash while the user is around is recorded and the sandbox is started again at once', async (t) => {
  const env = setup(t);
  crash(env);
  await env.m.watch();
  assert.deepEqual(env.ensured, [1]);
  assert.deepEqual(events(env, 'sandbox.crashed').map((a) => [a.exitCode, a.oom]), [[2, false]]);
  assert.equal(events(env, 'sandbox.auto_restart').length, 1);
  await env.m.watch(); // the same exit is not handled twice
  assert.equal(events(env, 'sandbox.crashed').length, 1);
});

test('the user is told after the restart, for a while, and an out-of-memory exit says so', async (t) => {
  const env = setup(t);
  env.m.llm = null;
  crash(env, { exitCode: 137, oomKilled: true });
  await env.m.watch();
  const w = (await env.m.limits(1)).warnings;
  assert.equal(w[0].code, 'restarted_after_crash');
  assert.match(w[0].title, /ran out of memory/);
  assert.match(w[0].message, /send your message again/);
  env.tick(16 * 60);
  assert.ok(!(await env.m.limits(1)).warnings.some((x) => x.code === 'restarted_after_crash'), 'the notice expires');
});

test('a user who left is not restarted for; the next visit explains it', async (t) => {
  const env = setup(t);
  env.tick(150); // past IDLE_SECONDS with nobody attached
  crash(env);
  await env.m.watch();
  assert.deepEqual(env.ensured, []);
  assert.equal(events(env, 'sandbox.crashed').length, 1);
  assert.equal(env.m.lastStop.get(1).by, 'crashed');
  assert.match(noticeFor('crashed').message, /stopped unexpectedly while you were away/);
});

test('an open browser keeps the user "around" even when nothing was requested for a long time', async (t) => {
  const env = setup(t);
  env.m.wsOpen(1);
  env.tick(500);
  crash(env);
  await env.m.watch();
  assert.deepEqual(env.ensured, [1]);
});

test('a deliberate stop is not a crash', async (t) => {
  const env = setup(t);
  await env.m.stop(1, 'idle');
  await env.m.watch();
  assert.equal(events(env, 'sandbox.crashed').length, 0);
  assert.deepEqual(env.ensured, []);
});

test('a crash loop is held instead of restarted forever, and an explicit restart gives a fresh count', async (t) => {
  const env = setup(t);
  for (let i = 0; i < 3; i++) {
    crash(env);
    await env.m.watch();
    env.tick(30);
  }
  assert.equal(env.ensured.length, 3, 'three restarts are allowed');
  crash(env);
  await env.m.watch(); // the fourth exit within the window
  assert.equal(env.ensured.length, 3, 'no fourth restart');
  assert.equal(env.m.held.has(1), true);
  assert.equal(env.m.problems.get(1).code, 'crash_loop');
  assert.equal(events(env, 'sandbox.crash_loop').length, 1);
  const p = problemFor('crash_loop', env.m.problems.get(1).params);
  assert.equal(p.action.kind, 'restart');
  assert.match(p.message, /4 times in 10 minutes/);
});

test('exits spread over more than the window do not count as a loop', async (t) => {
  const env = setup(t);
  env.m.wsOpen(1); // the user stays
  for (let i = 0; i < 6; i++) {
    crash(env);
    await env.m.watch();
    env.tick(400);
  }
  assert.equal(env.ensured.length, 6);
  assert.equal(env.m.held.has(1), false);
});

test('a request that finds its container gone also counts as the crash (the watchdog may not have run yet)', async (t) => {
  const env = setup(t);
  env.tick(10); // past the 3 s freshness of the cached check
  crash(env);
  assert.equal(await env.m.ready(1), null);
  assert.equal(events(env, 'sandbox.crashed').length, 1);
  assert.deepEqual(env.ensured, [1]);
});

test('a failed proxied request to a dead container is recorded as the crash and restarts it; to a live one it is only forgotten', async (t) => {
  const env = setup(t);
  env.m.invalidate(1); // the container is still running: a transient error
  await new Promise((r) => setImmediate(r));
  assert.equal(events(env, 'sandbox.crashed').length, 0);
  assert.equal(env.m.cache.has(1), false);
  env.m.cache.set(1, { cookie: 'c', startedAt: '0', checkedAt: Date.now() });
  crash(env, { exitCode: 2, oomKilled: false });
  env.m.invalidate(1);
  env.m.invalidate(1); // a second error from the same dead container changes nothing
  await new Promise((r) => setImmediate(r));
  assert.equal(events(env, 'sandbox.crashed').length, 1);
  assert.deepEqual(env.ensured, [1]);
});

test('the crash-loop state has a plain title and the out-of-memory hint', () => {
  const p = problemFor('crash_loop', { count: 4, windowSeconds: 600, oom: true });
  assert.equal(p.title, 'Your workspace keeps stopping');
  assert.match(p.message, /ran out of memory/);
  assert.equal(crashNotice().severity, 'info');
  assert.equal(classifyFailure('x'), 'start_failed');
});
