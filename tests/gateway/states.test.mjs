// P5-2: every reason a workspace is unavailable or model access is paused is one designed state. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { RUN_WARN_SECONDS, SandboxProblem, classifyFailure, noticeFor, percentOf, problemFor, shapeUsage, spanText, usageProblem, usageWarnings } from '../../gateway/src/states.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const cfg = loadConfig({ ...base, MAX_RUN_SECONDS: '28800', MAX_DISK_MB: '2048', DISK_CHECK_SECONDS: '300', IDLE_SECONDS: '1800', MAX_BUSY_SECONDS: '7200' });

test('spanText reads like a person would say it', () => {
  assert.equal(spanText(60), '1 minute');
  assert.equal(spanText(1800), '30 minutes');
  assert.equal(spanText(3600), '1 hour');
  assert.equal(spanText(5400), '1.5 hours');
  assert.equal(spanText(28800), '8 hours');
});

const ALL = [
  ['capacity', {}],
  ['stopped_run_time', { maxRunSeconds: 28800 }],
  ['stopped_disk', { usedMb: 3000, limitMb: 2048, checkSeconds: 300 }],
  ['stopped_user', {}],
  ['start_timeout', {}], ['harness_exited', {}], ['service_unavailable', {}], ['model_unavailable', {}],
  ['sandbox_unreachable', {}], ['start_failed', {}],
  ['quota_day', { used: 500000, limit: 500000, resetsAt: '2026-06-11T00:00:00.000Z' }],
  ['quota_month', { used: 5000000, limit: 5000000, resetsAt: '2026-07-01T00:00:00.000Z' }],
  ['budget', { resetsAt: '2026-06-11T00:00:00.000Z' }],
];

test('every state has a plain title, an explanation, a severity and an action, and none leaks internals', () => {
  for (const [code, params] of ALL) {
    const p = problemFor(code, params, cfg);
    assert.equal(p.code, code);
    assert.ok(['info', 'warning', 'error'].includes(p.severity), code);
    assert.ok(p.title.length > 10 && p.message.length > 40, code);
    assert.ok(['retry', 'restart', 'none'].includes(p.action.kind), code);
    assert.ok(p.action.kind === 'none' || p.action.label.length > 0, `${code} has a button label`);
    assert.ok(!/undefined|NaN|null|\[object|ECONN|ENOTFOUND|docker|runner|llm-proxy|sandbox-runner|container|stack|Error:/i.test(`${p.title} ${p.message}`), `${code} text: ${p.title} / ${p.message}`);
    assert.match(p.message, /[.!]$/, `${code} ends as a sentence`);
  }
});

test('the numbers and times in a state come from the limit that caused it', () => {
  assert.match(problemFor('stopped_run_time', { maxRunSeconds: 3600 }, cfg).message, /1 hour at a time/);
  const disk = problemFor('stopped_disk', { usedMb: 3000, limitMb: 2048, checkSeconds: 300 }, cfg).message;
  assert.match(disk, /3,000 MB of the 2,048 MB/);
  assert.match(disk, /every 5 minutes/);
  assert.match(problemFor('quota_day', { used: 500000, limit: 500000, resetsAt: '2026-06-11T00:00:00.000Z' }).message, /500,000 of 500,000 tokens today.*2026-06-11 00:00 UTC/);
  assert.match(problemFor('budget', { resetsAt: '2026-06-11T00:00:00.000Z' }).message, /not about your own usage.*2026-06-11 00:00 UTC/);
});

test('an unknown code falls back to the generic start failure, never to nothing', () => {
  const p = problemFor('something_new', {});
  assert.equal(p.code, 'start_failed');
  assert.ok(p.title && p.message);
});

test('untyped failures are classified by their message, most specific first', () => {
  const cases = {
    'the service is at capacity right now; try again in a few minutes': 'capacity',
    'sandbox container exited during startup': 'harness_exited',
    'timed out waiting for dsh to start': 'start_timeout',
    'llm-proxy POST /admin/tokens -> 503': 'model_unavailable',
    'runner POST /1 (create) -> 502': 'service_unavailable',
    'runner POST /1/start -> 409 stale_network': 'service_unavailable',
    'fetch failed': 'sandbox_unreachable',
    'getaddrinfo ENOTFOUND dsh-sbx-1': 'sandbox_unreachable',
    'connect ECONNREFUSED 172.19.0.5:3080': 'sandbox_unreachable',
    'token exchange returned 500 without auth cookie': 'sandbox_unreachable',
    'something nobody anticipated': 'start_failed',
    '': 'start_failed',
  };
  for (const [message, code] of Object.entries(cases)) assert.equal(classifyFailure(message), code, message);
});

test('notices explain unrequested stops and nothing else', () => {
  assert.match(noticeFor('idle', cfg).message, /paused after 30 minutes without activity/);
  assert.match(noticeFor('busy_cap', cfg).message, /kept working for 2 hours after you left/);
  assert.match(noticeFor('evicted', cfg).message, /free a slot/);
  for (const by of ['user', 'limit:run_time', 'limit:disk', undefined]) assert.equal(noticeFor(by, cfg), null, String(by));
  assert.equal(noticeFor('idle', cfg).severity, 'info');
});

test('usageProblem: the shared budget takes priority over a personal quota, the month and day are told apart, none when fine', () => {
  const day = { used: 10, limit: 10, resetsAt: '2026-06-11T00:00:00.000Z' };
  const month = { used: 50, limit: 100, resetsAt: '2026-07-01T00:00:00.000Z' };
  assert.equal(usageProblem(null), null);
  assert.equal(usageProblem({ exhausted: false, blockedBy: null, day, month, global: null }), null);
  assert.equal(usageProblem({ exhausted: true, blockedBy: 'day', day, month, global: null }).code, 'quota_day');
  assert.equal(usageProblem({ exhausted: true, blockedBy: 'month', day, month: { ...month, used: 100 }, global: null }).code, 'quota_month');
  assert.equal(usageProblem({ exhausted: true, blockedBy: 'day', day, month, global: { exhausted: true, resetsAt: day.resetsAt } }).code, 'budget');
  assert.equal(usageProblem({ exhausted: false, blockedBy: null, day, month, global: { exhausted: false, resetsAt: day.resetsAt } }), null);
});

// ---- the manager wires them into status() ----
function fakeRunner(extra = {}) {
  return { async info() { return null; }, async list() { return []; }, async create() {}, async start() {}, async stop() {}, async logs() { return ''; }, ...extra };
}

test('status: a failed start carries the designed state and keeps the raw message for the details disclosure', async () => {
  const m = new SandboxManager({ runner: fakeRunner({ async create() { throw new Error('runner POST /1 (create) -> 502'); } }), cfg, log: () => {} });
  await assert.rejects(m.ensure(1));
  const s = m.status(1);
  assert.equal(s.state, 'error');
  assert.equal(s.problem.code, 'service_unavailable');
  assert.match(s.error, /runner POST/);
  assert.equal(s.notice, null);
  // a retry starts clean: no stale problem during the next attempt
  const retry = m.ensure(1).catch(() => {});
  assert.equal(m.status(1).problem, null);
  await retry;
});

test('status: a typed capacity refusal is the capacity state', async () => {
  const m = new SandboxManager({ runner: fakeRunner(), cfg: { ...cfg, maxRunningSandboxes: 1, evictAfterIdleSeconds: 99999 }, log: () => {} });
  m.runner.list = async () => [{ userId: 9, running: true }];
  m.runner.info = async (id) => (id === 2 ? { running: false, startedAt: null, llmManaged: true } : null);
  m.lastSeen.set(9, Date.now());
  await assert.rejects(m.ensure(2), (e) => e instanceof SandboxProblem && e.code === 'capacity');
  assert.equal(m.status(2).problem.code, 'capacity');
  assert.equal(m.status(2).problem.action.kind, 'retry');
});

test('status: limit stops carry their numbers, and an unrequested stop explains itself on return', async () => {
  const runner = fakeRunner({
    async list() { return [{ userId: 1, running: true }, { userId: 2, running: true }]; },
    async info(id) { return { running: true, startedAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString(), llmManaged: true }; },
    async diskUsage() { return []; },
  });
  const m = new SandboxManager({ runner, cfg: { ...cfg, maxRunSeconds: 28800 }, log: () => {} });
  m.touch(1); m.touch(2);
  await m.enforceLimits(await runner.list());
  assert.equal(m.status(1).problem.code, 'stopped_run_time');
  assert.match(m.status(1).problem.message, /8 hours at a time/);
  // an idle stop leaves a notice for the next start
  await m.stop(3, 'idle');
  assert.equal(m.status(3).notice.code, 'resumed_idle');
  await m.stop(4, 'user');
  assert.equal(m.status(4).notice, null);
});

// ---- early warnings (P5-3) ----
const day = (used) => ({ used, limit: 1000, resetsAt: '2026-06-11T00:00:00.000Z' });
const month = (used) => ({ used, limit: 10000, resetsAt: '2026-07-01T00:00:00.000Z' });
const MB = 1024 * 1024;

test('percentOf: a share, or null when there is no limit', () => {
  assert.equal(percentOf(50, 200), 25);
  assert.equal(percentOf(5, 0), null);
  assert.equal(percentOf(5, null), null);
});

test('token warnings: none below 80%, "used N%" from 80%, "almost used" from 95%, left to the problem at 100%', () => {
  assert.deepEqual(usageWarnings({ tokens: { day: day(790), month: month(100) } }, cfg), []);
  const high = usageWarnings({ tokens: { day: day(800), month: month(100) } }, cfg);
  assert.equal(high.length, 1);
  assert.equal(high[0].code, 'tokens_day_high');
  assert.equal(high[0].severity, 'warning');
  assert.match(high[0].title, /You have used 80% of today's model allowance/);
  assert.match(high[0].message, /800 of 1,000 tokens.*2026-06-11 00:00 UTC.*workspace keeps working/);
  const crit = usageWarnings({ tokens: { day: day(960), month: month(100) } }, cfg)[0];
  assert.equal(crit.code, 'tokens_day_critical');
  assert.equal(crit.severity, 'error');
  assert.match(crit.title, /almost used today's/);
  assert.deepEqual(usageWarnings({ tokens: { day: day(1000), month: month(100) } }, cfg), [], 'at the limit it is a problem, not a warning');
  assert.equal(usageWarnings({ tokens: { day: { used: 5, limit: null, resetsAt: 'x' }, month: month(0) } }, cfg).length, 0, 'no limit, no warning');
});

test('storage warnings: 80%, 95%, and over the limit (still a warning: the stop happens at the next check)', () => {
  const at = (usedMb) => usageWarnings({ storage: { usedBytes: usedMb * MB, limitBytes: 100 * MB } }, cfg);
  assert.deepEqual(at(79), []);
  assert.equal(at(85)[0].code, 'storage_high');
  assert.match(at(85)[0].title, /Your storage is 85% full/);
  assert.equal(at(97)[0].code, 'storage_critical');
  assert.equal(at(97)[0].severity, 'error');
  const over = at(130)[0];
  assert.equal(over.code, 'storage_over');
  assert.match(over.message, /130 MB of 100 MB.*stopped at the next storage check.*every 5 minutes/);
  assert.deepEqual(usageWarnings({ storage: { usedBytes: 500 * MB, limitBytes: null } }, cfg), [], 'no limit configured');
});

test('run-time warning: in the last 15 minutes, urgent in the last five', () => {
  const run = (left) => usageWarnings({ run: { maxSeconds: 28800, secondsLeft: left } }, cfg);
  assert.deepEqual(run(RUN_WARN_SECONDS + 60), []);
  const w = run(12 * 60)[0];
  assert.equal(w.code, 'run_time_low');
  assert.equal(w.severity, 'warning');
  assert.match(w.title, /Your workspace will stop in 12 minutes/);
  assert.match(w.message, /8 hours at a time.*start it again right away/);
  assert.equal(run(200)[0].severity, 'error');
  assert.match(run(30)[0].title, /under a minute/);
  assert.deepEqual(usageWarnings({ run: { maxSeconds: 28800, secondsLeft: 60 } }, { ...cfg, maxRunSeconds: 0 }), [], 'no run limit configured');
});

test('warnings are ordered most urgent first and never leak internals', () => {
  const all = usageWarnings({
    tokens: { day: day(850), month: month(9900) },
    storage: { usedBytes: 60 * MB, limitBytes: 100 * MB },
    run: { maxSeconds: 28800, secondsLeft: 100 },
  }, cfg);
  // errors before warnings; among errors, the one closest to its limit first (the run ends in 100 s, the month is at 99%)
  assert.deepEqual(all.map((w) => w.code), ['run_time_low', 'tokens_month_critical', 'tokens_day_high']);
  for (const w of all) assert.ok(!/undefined|NaN|null|\[object|docker|runner|llm-proxy|container/i.test(`${w.title} ${w.message}`), w.code);
});

test('shapeUsage reduces the shared budget to exhausted and resetsAt', () => {
  const shaped = shapeUsage({ userId: 1, global: { used: 9, limit: 10, exhausted: true, resetsAt: 'r' } });
  assert.deepEqual(shaped.global, { exhausted: true, resetsAt: 'r' });
  assert.equal(shapeUsage(null), null);
  assert.equal(shapeUsage({ userId: 1 }).global, null);
});
