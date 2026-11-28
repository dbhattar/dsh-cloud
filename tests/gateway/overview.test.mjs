// P5-12: the numbers on the admin overview, from a seeded database and fake runner and llm-proxy. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createOverview, foldActivity, percentile } from '../../gateway/src/stats.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const NOW = Date.UTC(2026, 10, 26, 12);
const H = 3_600_000;
const D = 24 * H;

function world({ llm = true, runnerDown = false, llmDown = false, extra = {} } = {}) {
  const store = new Store(':memory:');
  const cfg = loadConfig({ ...base, MAX_RUNNING_SANDBOXES: '20', MAX_DISK_MB: '2048', ...extra });
  const runner = {
    list: async () => { if (runnerDown) throw new Error('runner down'); return [{ userId: 1, running: true }, { userId: 2, running: false }, { userId: 3, running: true }]; },
    diskUsage: async () => { if (runnerDown) throw new Error('runner down'); return [{ userId: 1, bytes: 3 * 1024 ** 3 }, { userId: 2, bytes: 100 }, { userId: 3, bytes: 5000 }]; },
  };
  const day = (n) => new Date(NOW - n * D).toISOString().slice(0, 10);
  const proxy = {
    stats: async () => { if (llmDown) throw new Error('proxy down'); return { days: [{ day: day(1), tokens: 500, requests: 5, users: 2 }, { day: day(0), tokens: 1200, requests: 9, users: 2 }], global: { used: 1200, limit: 5000, exhausted: false, resetsAt: 'x' } }; },
    usageAll: async () => [
      { userId: 1, day: { used: 900, limit: 1000 }, month: { used: 4000, limit: 10000 }, exhausted: false },
      { userId: 2, day: { used: 300, limit: 1000 }, month: { used: 300, limit: 10000 }, exhausted: false },
      { userId: 3, day: { used: 1000, limit: 1000 }, month: { used: 1000, limit: 10000 }, exhausted: true },
    ],
    activity: async () => { if (llmDown) throw new Error('proxy down'); return { users: [] }; },
  };
  const manager = { runner, llm: llm ? proxy : null, diskUsage: () => runner.diskUsage() };
  const overview = createOverview({ store, manager, cfg, now: () => NOW, dataDir: '.' });
  return { store, overview };
}

test('percentile: nearest rank, empty list is null', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
});

test('foldActivity: counts by kind, with the reasons for stops and refusals', () => {
  const f = foldActivity([
    { event: 'sandbox.start', why: null, n: 4 },
    { event: 'sandbox.stop', why: 'idle', n: 3 },
    { event: 'sandbox.stop', why: 'busy_cap', n: 1 },
    { event: 'sandbox.refused', why: 'capacity', n: 2 },
    { event: 'sandbox.crashed', why: null, n: 1 },
    { event: 'login.fail', why: 'bad_credentials', n: 5 },
    { event: 'login.fail', why: 'rate_limited', n: 2 },
  ]);
  assert.deepEqual(f.stops, { idle: 3, busy_cap: 1 });
  assert.deepEqual(f.refused, { capacity: 2 });
  assert.deepEqual([f.starts, f.crashes, f.loginFailures, f.signups], [4, 1, 7, 0]);
});

test('store aggregates: user counts, who was active, audit counts and start times', () => {
  const s = new Store(':memory:');
  const t = (n) => NOW - n;
  s.db.prepare('INSERT INTO users (email, pw_hash, created_at) VALUES (?, ?, ?)').run('old@example.com', 'x', t(30 * D));
  s.db.prepare('INSERT INTO users (email, pw_hash, created_at) VALUES (?, ?, ?)').run('new@example.com', 'x', t(2 * H));
  s.setAdmin('old@example.com', true);
  const c = s.userCounts([NOW - D, NOW - 7 * D]);
  assert.deepEqual([c.total, c.admins, ...c.created], [2, 1, 1, 1]);
  s.addAudit({ ts: t(1 * H), event: 'login.ok', userId: 1 });
  s.addAudit({ ts: t(2 * H), event: 'sandbox.start', userId: 1, detail: { resumed: true, ms: 4000 } });
  s.addAudit({ ts: t(3 * D), event: 'sandbox.start', userId: 2, detail: { resumed: false, ms: 9000 } });
  s.addAudit({ ts: t(1 * H), event: 'sandbox.stop', userId: 1, detail: { by: 'idle' } });
  s.addAudit({ ts: t(1 * H), event: 'sandbox.refused', userId: 1, detail: { reason: 'capacity' } });
  s.addAudit({ ts: t(1 * H), event: 'admin.denied', userId: 2, detail: { path: '/gw/admin' } });
  assert.equal(s.activeUsers(NOW - D), 1, 'one user active in a day; an admin.denied row is not activity');
  assert.equal(s.activeUsers(NOW - 7 * D), 2);
  const counts = s.auditCounts(NOW - D);
  assert.deepEqual(counts.find((x) => x.event === 'sandbox.stop'), { event: 'sandbox.stop', why: 'idle', n: 1 });
  assert.deepEqual(counts.find((x) => x.event === 'sandbox.refused'), { event: 'sandbox.refused', why: 'capacity', n: 1 });
  assert.deepEqual(s.startTimes(NOW - 7 * D).map((x) => [x.ms, x.resumed]).sort((p, q) => p[0] - q[0]), [[4000, true], [9000, false]]);
  assert.deepEqual(s.startTimes(NOW - D).map((x) => x.ms), [4000], 'only the starts inside the window');
  assert.deepEqual(s.feedbackCounts(), { total: 0, unread: 0 });
});

test('overview: every section from seeded data', async () => {
  const w = world();
  const uid = (e) => w.store.createUser(e, 'x');
  const [a, b, c] = ['ann@example.com', 'bob@example.com', 'cy@example.com'].map(uid);
  w.store.db.prepare('UPDATE users SET created_at = ?').run(NOW - 30 * D);
  w.store.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(NOW - 2 * H, c);
  w.store.setAdmin('ann@example.com', true);
  w.store.addAudit({ ts: NOW - H, event: 'login.ok', userId: a });
  w.store.addAudit({ ts: NOW - 2 * D, event: 'sandbox.start', userId: b, detail: { resumed: false, ms: 8000 } });
  w.store.addAudit({ ts: NOW - H, event: 'sandbox.start', userId: a, detail: { resumed: true, ms: 3000 } });
  w.store.addAudit({ ts: NOW - H, event: 'sandbox.crashed', userId: a, detail: { exitCode: 137 } });
  w.store.addAudit({ ts: NOW - H, event: 'sandbox.refused', userId: b, detail: { reason: 'capacity' } });
  const o = await w.overview();
  assert.equal(o.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(o.users, { ok: true, total: 3, admins: 1, newDay: 1, newWeek: 1, activeDay: 1, activeWeek: 2 });
  assert.deepEqual(o.sandboxes, { ok: true, running: 2, total: 3, capacity: 20 });
  assert.equal(o.tokens.metering, true);
  assert.deepEqual(o.tokens.today, { tokens: 1200, requests: 9, users: 2 });
  assert.equal(o.tokens.monthTokens, 5300, 'the month is the sum of every user\'s month, not of the days charted');
  assert.equal(o.tokens.series.length, 2);
  assert.deepEqual(o.tokens.budget, { used: 1200, limit: 5000, exhausted: false });
  assert.deepEqual(o.tokens.topToday.map((u) => [u.email, u.used]), [['cy@example.com', 1000], ['ann@example.com', 900], ['bob@example.com', 300]]);
  assert.deepEqual(o.tokens.topMonth[0], { userId: a, email: 'ann@example.com', used: 4000, limit: 10000 });
  assert.deepEqual(o.tokens.nearLimit.map((u) => [u.email, u.percent, u.window]), [['cy@example.com', 100, 'day'], ['ann@example.com', 90, 'day']]);
  assert.equal(o.tokens.exhaustedUsers, 1);
  assert.equal(o.storage.totalBytes, 3 * 1024 ** 3 + 5100);
  assert.equal(o.storage.overLimit, 1, 'one user is over the 2 GB limit');
  assert.equal(o.storage.top[0].email, 'ann@example.com');
  assert.equal(o.activity.day.crashes, 1);
  assert.deepEqual(o.activity.day.refused, { capacity: 1 });
  assert.equal(o.activity.week.starts, 2);
  assert.deepEqual([o.readiness.all.samples, o.readiness.all.medianMs, o.readiness.resumed.medianMs, o.readiness.fresh.medianMs], [2, 3000, 3000, 8000]);
  assert.equal(o.health.runner.ok, true);
  assert.equal(o.health.llmProxy.ok, true);
  assert.equal(o.health.dataDisk.ok, true);
  assert.ok(o.health.dataDisk.freeBytes > 0);
});

test('overview: a source that is down shows as unavailable for its part, and the rest still works', async () => {
  const w = world({ runnerDown: true, llmDown: true });
  w.store.createUser('ann@example.com', 'x');
  const o = await w.overview();
  assert.deepEqual(o.sandboxes, { ok: false, error: 'runner down' });
  assert.deepEqual(o.storage, { ok: false, error: 'runner down' });
  assert.deepEqual(o.tokens, { ok: false, error: 'proxy down' });
  assert.equal(o.health.runner.ok, false);
  assert.equal(o.health.llmProxy.ok, false);
  assert.equal(o.users.ok, true);
  assert.equal(o.users.total, 1);
  assert.equal(o.activity.ok, true);
});

test('overview: with metering off the token section says so; an empty stack has zeros and no NaN or undefined', async () => {
  const w = world({ llm: false });
  const o = await w.overview();
  assert.deepEqual(o.tokens, { ok: true, metering: false });
  assert.equal(o.health.llmProxy, null);
  assert.equal(o.users.total, 0);
  assert.equal(o.readiness.all.medianMs, null, 'no starts: no median, not zero');
  assert.deepEqual(o.activity.day.stops, {});
  assert.ok(!/NaN|undefined/.test(JSON.stringify(o)), JSON.stringify(o));
});

test('overview: no capacity limit is null, and the output carries no password hashes or content', async () => {
  const w = world({ extra: { MAX_RUNNING_SANDBOXES: '0' } });
  w.store.createUser('ann@example.com', 'secret-hash-value');
  w.store.addFeedback(1, 'bug', 'a private message from the user', { source: 'x' });
  const o = await w.overview();
  assert.equal(o.sandboxes.capacity, null);
  assert.deepEqual(o.feedback, { total: 1, unread: 1 });
  const text = JSON.stringify(o);
  assert.ok(!text.includes('secret-hash-value'));
  assert.ok(!text.includes('a private message'));
});
