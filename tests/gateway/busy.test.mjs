// P5-1: a sandbox whose agent is busy is not stopped for being idle while no browser is attached. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };

/** A manual clock: the manager reads Date.now(), so tests move it with t.mock. */
function setup(t, extra = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  const cfg = loadConfig({ ...base, IDLE_SECONDS: '100', MAX_BUSY_SECONDS: '1000', BUSY_CPU_PERCENT: '5', BUSY_SIGNAL_SECONDS: '60', ...extra });
  const state = { cpu: new Map(), llmUsers: [], llmFails: false, runnerFails: false, boxes: new Map([[1, true]]), stopped: [], audit: [] };
  const runner = {
    async list() { return [...state.boxes].map(([userId, running]) => ({ userId, running })); },
    async activity(id) { if (state.runnerFails) throw new Error('runner down'); return { cpuNs: state.cpu.get(id) ?? 0, memBytes: 1 }; },
    async stop(id) { state.stopped.push(id); state.boxes.set(id, false); },
    async info() { return { running: true, startedAt: 'x' }; },
  };
  const llm = { async activity() { if (state.llmFails) throw new Error('proxy down'); return { users: state.llmUsers }; } };
  const audit = { record: (event, d) => state.audit.push({ event, ...d }) };
  const logs = [];
  const m = new SandboxManager({ runner, cfg, log: (l) => logs.push(l), llm, audit });
  return { m, state, logs, tick: (s) => t.mock.timers.tick(s * 1000) };
}

/** Advance the clock and run one reap, adding `cpuSeconds` of CPU time to user 1 over that period. */
async function step(env, seconds, cpuSeconds = 0) {
  env.tick(seconds);
  env.state.cpu.set(1, (env.state.cpu.get(1) ?? 0) + cpuSeconds * 1e9);
  await env.m.reap();
}

test('config: busy handling is off by default and the settings parse', () => {
  const c = loadConfig(base);
  assert.equal(c.maxBusySeconds, 0);
  assert.equal(c.busyCpuPercent, 5);
  assert.equal(c.busySignalSeconds, 300);
  assert.equal(loadConfig({ ...base, MAX_BUSY_SECONDS: '7200' }).maxBusySeconds, 7200);
});

test('off: an idle sandbox is stopped after the idle limit even if the agent was busy (the old behaviour)', async (t) => {
  const env = setup(t, { MAX_BUSY_SECONDS: '0' });
  env.m.touch(1);
  env.state.llmUsers = [{ userId: 1, inflight: 1, lastAt: new Date().toISOString() }];
  await step(env, 150, 100);
  assert.deepEqual(env.state.stopped, [1]);
});

test('truly idle: with no model calls and no CPU use, the sandbox is stopped after the idle limit', async (t) => {
  const env = setup(t);
  env.m.touch(1);
  await step(env, 50, 0.1);
  assert.deepEqual(env.state.stopped, []);
  await step(env, 60, 0.1); // 110 s since the user: past the idle limit
  assert.deepEqual(env.state.stopped, [1]);
  assert.ok(!env.state.audit.some((a) => a.event === 'sandbox.kept_busy'), 'never kept');
  assert.deepEqual(env.state.audit.filter((a) => a.event === 'sandbox.stop').map((a) => a.by), ['idle']);
});

test('model traffic keeps it alive: a request in flight, or one a moment ago, counts as busy', async (t) => {
  const env = setup(t);
  env.m.touch(1);
  await step(env, 99, 0);
  env.state.llmUsers = [{ userId: 1, inflight: 1, lastAt: new Date().toISOString() }]; // a long streaming call
  await step(env, 30, 0);
  assert.deepEqual(env.state.stopped, []);
  assert.equal(env.state.audit.find((a) => a.event === 'sandbox.kept_busy')?.signal, 'model');
  env.state.llmUsers = [{ userId: 1, inflight: 0, lastAt: new Date().toISOString() }]; // finished just now
  await step(env, 30, 0);
  assert.deepEqual(env.state.stopped, []);
  env.state.llmUsers = []; // quiet from here
  await step(env, 70, 0); // the last signal is now older than busySignalSeconds (60)
  assert.deepEqual(env.state.stopped, [1], 'stopped once the busy signal went stale');
});

test('CPU use keeps it alive: a long build with no model calls counts, a quiet harness does not', async (t) => {
  const env = setup(t);
  env.m.touch(1);
  await step(env, 99, 0.2);
  await step(env, 30, 15); // 50% of a CPU over the interval
  assert.deepEqual(env.state.stopped, []);
  assert.equal(env.state.audit.find((a) => a.event === 'sandbox.kept_busy')?.signal, 'cpu');
  await step(env, 30, 0.3); // 1%: below the threshold
  assert.deepEqual(env.state.stopped, [], 'the last burst is still recent');
  await step(env, 40, 0.4);
  assert.deepEqual(env.state.stopped, [1]);
});

test('the cap: a busy sandbox is stopped MAX_BUSY_SECONDS after the user was last active, and says why', async (t) => {
  const env = setup(t);
  env.m.touch(1);
  let at = 0;
  while (env.state.stopped.length === 0 && at < 1500) {
    env.state.llmUsers = [{ userId: 1, inflight: 1, lastAt: new Date().toISOString() }]; // busy the whole time
    await step(env, 30, 0);
    at += 30;
  }
  assert.deepEqual(env.state.stopped, [1]);
  assert.ok(at > 1000 && at <= 1050, `stopped at ${at} s, cap is 1000`);
  assert.equal(env.state.audit.filter((a) => a.event === 'sandbox.kept_busy').length, 1, 'the keep is audited once, not every reap');
  assert.deepEqual(env.state.audit.filter((a) => a.event === 'sandbox.stop').map((a) => a.by), ['busy_cap']);
});

test('a browser tab resets the clock: activity from the user starts the idle and cap timers again', async (t) => {
  const env = setup(t);
  env.m.touch(1);
  env.state.llmUsers = [{ userId: 1, inflight: 1, lastAt: new Date().toISOString() }];
  await step(env, 900, 0);
  env.m.touch(1); // the user comes back
  await step(env, 900, 0);
  assert.deepEqual(env.state.stopped, []);
});

test('an open browser socket always keeps a sandbox, busy or not', async (t) => {
  const env = setup(t);
  env.m.touch(1);
  env.m.wsOpen(1);
  await step(env, 5000, 0);
  assert.deepEqual(env.state.stopped, []);
});

test('signal sources failing means no signal, not a crash or a stuck sandbox; the failure is logged once', async (t) => {
  const env = setup(t);
  env.m.touch(1);
  env.state.llmFails = true;
  env.state.runnerFails = true;
  await step(env, 150, 100);
  assert.deepEqual(env.state.stopped, [1], 'falls back to stopping an idle sandbox');
  assert.equal(env.logs.filter((l) => /unavailable/.test(l)).length, 1);
});

test('a busy sandbox is not evicted to make room for a newcomer; an idle one is', async (t) => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => res.writeHead(303, { 'set-cookie': 'dsh-auth-x=v1.tok; Path=/' }).end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    // Real timers are needed for the start sequence's sleeps, so this test does not mock the clock.
    const cfg = { ...loadConfig({ ...base, MAX_RUNNING_SANDBOXES: '2', EVICT_AFTER_IDLE_SECONDS: '1', MAX_BUSY_SECONDS: '1000', BUSY_SIGNAL_SECONDS: '60' }), sandboxPort: srv.address().port };
    const boxes = new Map([[1, { running: true }], [2, { running: true }], [3, { running: false }]]);
    const stopped = [];
    const runner = {
      async list() { return [...boxes].map(([userId, b]) => ({ userId, running: b.running })); },
      async info(id) { const b = boxes.get(id); return b ? { running: b.running, startedAt: 'x', llmManaged: true } : null; },
      async start(id) { boxes.get(id).running = true; },
      async stop(id) { stopped.push(id); boxes.get(id).running = false; },
      async logs() { return 'dsh web: https://localhost/?token=abc_DEF-123\n'; },
    };
    const m = new SandboxManager({ runner, cfg, log: () => {} });
    m.name = () => '127.0.0.1';
    m.lastSeen.set(1, Date.now() - 5000);
    m.lastSeen.set(2, Date.now() - 3000); // user 1 has been idle longer, so it would be the victim if it were not busy
    m.lastBusy.set(1, { at: Date.now(), signal: 'model' });
    await m.ensure(3);
    assert.deepEqual(stopped, [2], 'the idle sandbox was evicted, the busy one was kept');
  } finally { srv.close(); }
});
