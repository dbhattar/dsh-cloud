// P5-9: the waiting room. When the service is full and nothing can be stopped to make room, a newcomer waits in line and is
// started by itself when a place frees, instead of being refused. A fake runner and short timers; no Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { SandboxProblem, problemFor } from '../../gateway/src/states.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(5); } throw new Error(`timed out: ${what}`); };

/** One slot, user 9 holds it. `running` is the set of running sandboxes; a start adds the user to it and then fails fast (no real harness). */
function world(extra = {}) {
  const cfg = { ...loadConfig({ ...base, MAX_RUNNING_SANDBOXES: '1', EVICT_AFTER_IDLE_SECONDS: '99999' }), waitQueueSeconds: 5, waitPollMs: 20, waitAbandonSeconds: 30, startTimeoutSeconds: 0.05, ...extra };
  const running = new Set([9]);
  const started = [];
  const audit = [];
  const gate = { startMs: 0, listMs: 3 };
  const runner = {
    // a little latency, like the real runner: without it, two checks can never overlap and a race could not show
    async list() { await sleep(gate.listMs); return [...running].map((userId) => ({ userId, running: true })); },
    async info(id) { return { running: running.has(id), startedAt: 'x', llmManaged: true }; },
    async create() {},
    async start(id) { started.push(id); running.add(id); await sleep(gate.startMs); },
    async stop(id) { running.delete(id); },
    async logs() { return ''; },
  };
  const m = new SandboxManager({ runner, cfg, log: () => {}, audit: { record: (event, d) => audit.push({ event, ...d }) } });
  m.touch(9); // the holder is active, so it cannot be evicted
  const ask = (id) => m.ensure(id).catch((e) => e); // a start here ends in an error after admission (no real harness); what counts is `started`
  return { m, running, started, audit, ask, cfg, gate };
}

test('full: the newcomer is not refused; it waits, is told its place, and starts as soon as a place frees', async () => {
  const w = world();
  const p = w.ask(2);
  await until(() => w.m.status(2).queue, 'a place in line');
  assert.deepEqual({ ...w.m.status(2).queue, waitedSeconds: undefined }, { position: 1, total: 1, waitedSeconds: undefined, maxSeconds: 5 });
  assert.equal(w.m.status(2).state, 'starting', 'still starting, not failed');
  assert.equal(w.m.status(2).problem, null);
  assert.deepEqual(w.started, []);
  w.running.delete(9); // the holder leaves
  await p;
  assert.deepEqual(w.started, [2]);
  assert.deepEqual(w.audit.filter((a) => /queued|dequeued|refused/.test(a.event)).map((a) => a.event), ['sandbox.queued', 'sandbox.dequeued']);
  assert.equal(w.m.status(2).queue, null, 'no longer in line');
});

test('first come, first served: three newcomers are started in the order they asked, each when one place frees', async () => {
  const w = world();
  const ps = [2, 3, 4].map((id) => w.ask(id));
  await until(() => w.m.status(4).queue, 'all in line');
  assert.deepEqual([2, 3, 4].map((id) => w.m.status(id).queue.position), [1, 2, 3]);
  assert.equal(w.m.status(4).queue.total, 3);
  for (const holder of [9, 2, 3]) {
    const before = w.started.length;
    w.running.delete(holder);
    await until(() => w.started.length === before + 1, `one start after ${holder} left`);
  }
  await Promise.all(ps);
  assert.deepEqual(w.started, [2, 3, 4]);
});

test('a stop wakes the first in line at once, without waiting for the next check', async () => {
  const w = world({ waitPollMs: 60_000 }); // checks would be a minute apart
  const p = w.ask(2);
  await until(() => w.m.status(2).queue, 'in line');
  const t0 = Date.now();
  await w.m.stop(9, 'idle');
  await p;
  assert.deepEqual(w.started, [2]);
  assert.ok(Date.now() - t0 < 1500, `started ${Date.now() - t0} ms after the stop`);
});

test('an idle sandbox is still stopped to make room, so nobody waits when room can be made', async () => {
  const w = world({ evictAfterIdleSeconds: 0 });
  w.m.lastSeen.set(9, Date.now() - 1000);
  await w.ask(2);
  assert.deepEqual(w.started, [2]);
  assert.ok(w.audit.some((a) => a.event === 'sandbox.evicted'));
  assert.ok(!w.audit.some((a) => a.event === 'sandbox.queued'));
});

test('no line while there is room: a status carries no queue, even for someone briefly behind a start in progress', async () => {
  const w = world();
  w.running.clear();
  w.gate.startMs = 300; // user 2's start takes a while
  const p2 = w.ask(2);
  await until(() => w.started.includes(2), 'user 2 starting');
  const p3 = w.ask(3);
  await until(() => w.m.admitting.length === 2, 'user 3 behind user 2 in the check');
  assert.equal(w.m.status(2).queue, null);
  assert.equal(w.m.status(3).queue, null, 'waiting a moment for the check is not a line');
  w.running.clear();
  await Promise.all([p2, p3]);
});

test('the line closes when the waiting room empties: the next newcomer, with room, is not shown a line', async () => {
  const w = world();
  const first = w.ask(2);
  await until(() => w.m.status(2).queue, 'a line');
  w.running.clear();
  await first;
  await until(() => w.m.admitting.length === 0, 'the waiting room to empty');
  assert.equal(w.m.lineOpen, false);
  w.running.clear();
  w.gate.startMs = 300;
  const p3 = w.ask(3);
  await until(() => w.started.includes(3), 'user 3 starting');
  const p4 = w.ask(4);
  await until(() => w.m.admitting.length === 2, 'user 4 behind user 3');
  assert.equal(w.m.status(4).queue, null, 'no line from an earlier rush');
  w.running.clear();
  await Promise.all([p3, p4]);
});

test('serialised: two newcomers never take the last place together, even when a place frees while both are checking', async () => {
  const w = world();
  w.gate.listMs = 25; // slow checks that start together stay together, so an overlap would show
  const ps = [2, 3].map((id) => w.ask(id));
  await until(() => w.m.status(3).queue, 'both in line');
  w.running.delete(9); // one place appears
  await until(() => w.started.length >= 1, 'one admitted');
  await sleep(120); // time for a second admission, if it were going to happen
  assert.deepEqual(w.started, [2], 'only one took the place');
  const drain = setInterval(() => w.running.delete(2), 10);
  await Promise.all(ps);
  clearInterval(drain);
  assert.deepEqual(w.started, [2, 3]);
});

test('the limit does not cut off a start that is already under way', async () => {
  const w = world({ waitQueueSeconds: 0.15 });
  w.running.clear();
  w.gate.startMs = 400; // admitted at once, but the start outlasts the waiting limit
  const e = await w.ask(2);
  assert.ok(!(e instanceof SandboxProblem), `was cancelled: ${e}`);
  assert.ok(!w.audit.some((a) => a.event === 'sandbox.refused'));
});

test('the limit: after WAIT_QUEUE_SECONDS the wait ends with the busy state, says how long it waited, and the next in line is not held up', async () => {
  const w = world({ waitQueueSeconds: 0.3 });
  const first = w.ask(2);
  await until(() => w.m.status(2).queue, 'in line');
  const e = await first;
  assert.ok(e instanceof SandboxProblem && e.code === 'capacity', String(e));
  assert.equal(w.m.status(2).state, 'error');
  assert.equal(w.m.status(2).problem.code, 'capacity');
  assert.equal(w.m.status(2).queue, null);
  assert.ok(w.audit.some((a) => a.event === 'sandbox.refused' && a.userId === 2 && a.reason === 'queue_timeout'));
  assert.deepEqual(w.started, []);
  // someone behind it is served when a place frees
  const second = w.ask(3);
  await until(() => w.m.status(3).queue, 'user 3 in line');
  w.running.delete(9);
  await second;
  assert.deepEqual(w.started, [3]);
});

test('a long wait is said plainly in the busy message; a short one keeps the usual text', () => {
  assert.match(problemFor('capacity', { waitedSeconds: 600 }).message, /none opened in the 10 minutes you waited/);
  assert.doesNotMatch(problemFor('capacity', {}).message, /waited/);
});

test('someone who stops looking leaves the line, with no error waiting for them when they come back; those behind move up', async () => {
  const w = world({ waitAbandonSeconds: 0.3 });
  const p2 = w.ask(2);
  const p3 = w.ask(3);
  await until(() => w.m.status(3).queue, 'both in line');
  // only user 3's page keeps asking
  const keep = setInterval(() => w.m.status(3), 50);
  const e = await p2;
  clearInterval(keep);
  assert.ok(e instanceof SandboxProblem && e.code === 'queue_left');
  assert.equal(w.m.status(2).state, 'stopped', 'not an error state');
  assert.equal(w.m.status(2).problem, null);
  assert.ok(w.audit.some((a) => a.event === 'sandbox.queue_left' && a.userId === 2));
  assert.equal(w.m.status(3).queue.position, 1, 'moved up');
  w.running.delete(9);
  await p3;
  assert.deepEqual(w.started, [3]);
  assert.ok(!w.started.includes(2), 'a place is never spent on someone who left');
});

test('the line is bounded: past MAX_WAITING a newcomer is refused at once, and it is audited as a full line', async () => {
  const w = world({ maxWaiting: 2 });
  const ps = [2, 3].map((id) => w.ask(id));
  await until(() => w.m.status(3).queue, 'two in line');
  const e = await w.ask(4);
  assert.ok(e instanceof SandboxProblem && e.code === 'capacity', String(e));
  assert.ok(w.audit.some((a) => a.event === 'sandbox.refused' && a.userId === 4 && a.reason === 'queue_full'));
  const drain = setInterval(() => w.running.clear(), 10); // every sandbox that starts (here it fails at once) is gone again
  await Promise.all(ps);
  clearInterval(drain);
  assert.deepEqual(w.started, [2, 3], 'the two in line were served, in order');
});

test('off (WAIT_QUEUE_SECONDS=0): the old behaviour, refused at once with the busy state', async () => {
  const w = world({ waitQueueSeconds: 0 });
  const e = await w.ask(2);
  assert.ok(e instanceof SandboxProblem && e.code === 'capacity');
  assert.equal(w.m.status(2).problem.code, 'capacity');
  assert.deepEqual(w.started, []);
  assert.ok(w.audit.some((a) => a.event === 'sandbox.refused' && a.reason === 'capacity'));
});

test('config: the waiting room is on by default with sensible numbers, and the settings parse', () => {
  const c = loadConfig(base);
  assert.deepEqual([c.waitQueueSeconds, c.maxWaiting, c.waitPollMs, c.waitAbandonSeconds], [600, 50, 2000, 30]);
  const d = loadConfig({ ...base, WAIT_QUEUE_SECONDS: '0', MAX_WAITING: '5' });
  assert.deepEqual([d.waitQueueSeconds, d.maxWaiting], [0, 5]);
});
