import { statfsSync } from 'node:fs';

/**
 * The numbers on the admin overview, from what is already recorded: the gateway's accounts and audit table, the llm-proxy's usage
 * counters, and the runner's list and disk figures. Counts and totals only; nothing here reads a workspace, a session or a prompt.
 *
 * Every section is gathered on its own, so a source that is down (the runner, the proxy) shows as "unavailable" for its part and
 * the rest of the page still works.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Nearest-rank percentile of a list of numbers (p in 0..100), or null for an empty list. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Audit counts folded into the figures the page shows. `counts` is the store's auditCounts() for one window. */
export function foldActivity(counts) {
  const sum = (pred) => counts.filter(pred).reduce((n, c) => n + c.n, 0);
  const by = (event) => Object.fromEntries(counts.filter((c) => c.event === event && c.why).map((c) => [c.why, c.n]));
  return {
    starts: sum((c) => c.event === 'sandbox.start'),
    stops: by('sandbox.stop'),
    refused: by('sandbox.refused'),
    startFailures: sum((c) => c.event === 'sandbox.start_failed'),
    crashes: sum((c) => c.event === 'sandbox.crashed'),
    crashLoops: sum((c) => c.event === 'sandbox.crash_loop'),
    loginsOk: sum((c) => c.event === 'login.ok'),
    loginFailures: sum((c) => c.event === 'login.fail'),
    signups: sum((c) => c.event === 'signup.ok'),
    signupFailures: sum((c) => c.event === 'signup.fail'),
  };
}

const message = (e) => String(e?.message ?? e).slice(0, 120);

/** Run a section; a failure becomes { ok: false, error } instead of failing the whole overview. */
async function section(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export function createOverview({ store, manager, cfg, now = () => Date.now(), dataDir = cfg.dataDir }) {
  let disk = { at: 0, rows: [] };
  const diskUsage = async () => {
    if (now() - disk.at > 60_000) disk = { at: now(), rows: await manager.runner.diskUsage() };
    return disk.rows;
  };

  return async function overview() {
    const t = now();
    const emails = store.emailsById();
    const who = (userId) => ({ userId, email: emails.get(userId) ?? `user ${userId}` });

    const users = await section(async () => {
      const c = store.userCounts([t - DAY, t - 7 * DAY]);
      return { total: c.total, admins: c.admins, newDay: c.created[0], newWeek: c.created[1], activeDay: store.activeUsers(t - DAY), activeWeek: store.activeUsers(t - 7 * DAY) };
    });

    const sandboxes = await section(async () => {
      const list = await manager.runner.list();
      return { running: list.filter((s) => s.running).length, total: list.length, capacity: cfg.maxRunningSandboxes || null };
    });

    const tokens = await section(async () => {
      if (!manager.llm) return { metering: false };
      const [stats, all] = await Promise.all([manager.llm.stats(14), manager.llm.usageAll()]);
      const today = stats.days.at(-1) ?? { tokens: 0, requests: 0, users: 0 };
      const rank = (key) => all.filter((u) => u[key].used > 0).sort((a, b) => b[key].used - a[key].used).slice(0, 5).map((u) => ({ ...who(u.userId), used: u[key].used, limit: u[key].limit }));
      const percentOf = (w) => (w.limit > 0 ? (w.used / w.limit) * 100 : null);
      const near = all
        .map((u) => ({ u, day: percentOf(u.day), month: percentOf(u.month) }))
        .filter((x) => (x.day ?? 0) >= 80 || (x.month ?? 0) >= 80)
        .map((x) => ({ ...who(x.u.userId), window: (x.month ?? 0) > (x.day ?? 0) ? 'month' : 'day', percent: Math.round(Math.max(x.day ?? 0, x.month ?? 0)) }))
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 10);
      return {
        metering: true,
        today: { tokens: today.tokens, requests: today.requests, users: today.users },
        monthTokens: all.reduce((n, u) => n + u.month.used, 0),
        series: stats.days,
        budget: stats.global ? { used: stats.global.used, limit: stats.global.limit, exhausted: stats.global.exhausted } : null,
        topToday: rank('day'),
        topMonth: rank('month'),
        nearLimit: near,
        exhaustedUsers: all.filter((u) => u.exhausted).length,
      };
    });

    const storage = await section(async () => {
      const rows = await diskUsage();
      const limitBytes = cfg.maxDiskMb ? cfg.maxDiskMb * 1024 * 1024 : null;
      return {
        totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
        limitBytes,
        overLimit: limitBytes ? rows.filter((r) => r.bytes > limitBytes).length : 0,
        top: [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((r) => ({ ...who(r.userId), bytes: r.bytes })),
      };
    });

    const activity = await section(async () => ({ day: foldActivity(store.auditCounts(t - DAY)), week: foldActivity(store.auditCounts(t - 7 * DAY)) }));

    const readiness = await section(async () => {
      const starts = store.startTimes(t - 7 * DAY);
      const split = (rows) => ({ samples: rows.length, medianMs: percentile(rows.map((r) => r.ms), 50), p95Ms: percentile(rows.map((r) => r.ms), 95) });
      return { all: split(starts), resumed: split(starts.filter((s) => s.resumed)), fresh: split(starts.filter((s) => !s.resumed)) };
    });

    const timed = async (fn) => {
      const started = Date.now();
      await fn();
      return { ok: true, ms: Date.now() - started };
    };
    const health = {
      runner: await timed(() => manager.runner.list()).catch((e) => ({ ok: false, error: message(e) })),
      llmProxy: manager.llm ? await timed(() => manager.llm.activity()).catch((e) => ({ ok: false, error: message(e) })) : null,
      dataDisk: (() => {
        try {
          const s = statfsSync(dataDir);
          return { ok: true, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
        } catch (e) {
          return { ok: false, error: message(e) };
        }
      })(),
    };

    return { generatedAt: new Date(t).toISOString(), users, sandboxes, tokens, storage, activity, readiness, health, feedbackCount: store.feedbackCount() };
  };
}
