/**
 * Every reason a user's workspace is not available, or their model access is paused, as one designed state:
 * a stable code, a plain title, what happened, what to do, and an action the page can offer. The launching page and
 * the app shell render these; nothing in the UI invents its own wording. Raw technical messages stay in the
 * `error` field of the status API (and the logs) for the "details" disclosure and for support.
 */

/** An error that already knows which designed state it is. */
export class SandboxProblem extends Error {
  constructor(code, params = {}, message = code) {
    super(message);
    this.name = 'SandboxProblem';
    this.code = code;
    this.params = params;
  }
}

/** "30 minutes", "2 hours", "1.5 hours". */
export function spanText(seconds) {
  if (seconds >= 3600) {
    const h = Math.round((seconds / 3600) * 10) / 10;
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

const utc = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const number = (n) => new Intl.NumberFormat('en').format(n);
const RETRY = { kind: 'retry', label: 'Try again' };
const START = { kind: 'restart', label: 'Start my workspace' };
const NONE = { kind: 'none', label: '' };

/** code -> (params, cfg) -> { severity, title, message, action }. Severity: info, warning or error. */
const PROBLEMS = {
  capacity: () => ({
    severity: 'warning',
    title: 'The service is busy right now',
    message: 'All workspace slots are in use. Nothing is wrong with your account or your files. Try again in a few minutes.',
    action: RETRY,
  }),
  stopped_run_time: (p, cfg) => ({
    severity: 'warning',
    title: 'Your workspace reached its time limit',
    message: `A workspace can run for ${spanText(p.maxRunSeconds ?? cfg.maxRunSeconds)} at a time. It was stopped, and your files and sessions are saved. Start it again to keep working.`,
    action: START,
  }),
  stopped_disk: (p, cfg) => ({
    severity: 'warning',
    title: 'Your workspace is over its storage limit',
    message: `It uses ${number(p.usedMb)} MB of the ${number(p.limitMb ?? cfg.maxDiskMb)} MB you can store, so it was stopped. Start it again and delete files you do not need. Storage is checked about every ${spanText(p.checkSeconds ?? cfg.diskCheckSeconds)} and the workspace is stopped again while it is still over.`,
    action: START,
  }),
  start_timeout: () => ({
    severity: 'error',
    title: 'Your workspace is taking too long to start',
    message: 'It did not become ready in time. This is usually temporary: try again. If it keeps happening, send us feedback and include the details below.',
    action: RETRY,
  }),
  harness_exited: () => ({
    severity: 'error',
    title: 'Your workspace stopped while starting',
    message: 'The program inside it exited before it was ready. Your files are safe. Try again; if it keeps happening, send us feedback and include the details below.',
    action: RETRY,
  }),
  service_unavailable: () => ({
    severity: 'error',
    title: 'The workspace service is not responding',
    message: 'We could not reach the service that runs workspaces. Your files are safe. Try again in a minute.',
    action: RETRY,
  }),
  model_unavailable: () => ({
    severity: 'error',
    title: 'The model service is not responding',
    message: 'Your workspace needs it in order to start. Try again in a minute.',
    action: RETRY,
  }),
  sandbox_unreachable: () => ({
    severity: 'error',
    title: 'We could not connect to your workspace',
    message: 'It started, but the connection to it failed. Try again.',
    action: RETRY,
  }),
  start_failed: () => ({
    severity: 'error',
    title: 'Your workspace could not start',
    message: 'Something went wrong. Your files are safe. Try again; if it keeps happening, send us feedback and include the details below.',
    action: RETRY,
  }),
  // Model access, shown as a banner in the app (the workspace itself keeps running).
  quota_day: (p) => ({
    severity: 'warning',
    title: "You have used today's model allowance",
    message: `You have used ${number(p.used)} of ${number(p.limit)} tokens today. Model requests work again at ${utc(p.resetsAt)}. Your workspace and files are unaffected.`,
    action: NONE,
  }),
  quota_month: (p) => ({
    severity: 'warning',
    title: "You have used this month's model allowance",
    message: `You have used ${number(p.used)} of ${number(p.limit)} tokens this month. Model requests work again at ${utc(p.resetsAt)}. Your workspace and files are unaffected.`,
    action: NONE,
  }),
  budget: (p) => ({
    severity: 'warning',
    title: "The service's daily model budget is used up",
    message: `The daily budget shared by all users is used up, which is not about your own usage. Model requests work again at ${utc(p.resetsAt)}. Your workspace keeps working; only the model is paused.`,
    action: NONE,
  }),
};

/** The designed state for a code, or the generic start failure for an unknown one. */
export function problemFor(code, params = {}, cfg = {}) {
  const make = PROBLEMS[code] ?? PROBLEMS.start_failed;
  return { code: PROBLEMS[code] ? code : 'start_failed', ...make(params, cfg) };
}

/** Which designed state an untyped failure message belongs to. Order matters: the most specific first. */
export function classifyFailure(message = '') {
  if (/at capacity/.test(message)) return 'capacity';
  if (/exited during startup/.test(message)) return 'harness_exited';
  if (/timed out waiting for dsh/.test(message)) return 'start_timeout';
  if (/llm-proxy|\/admin\/tokens/.test(message)) return 'model_unavailable';
  if (/^runner |sandbox-runner|stale_network|docker/i.test(message)) return 'service_unavailable';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|token exchange|fetch failed/.test(message)) return 'sandbox_unreachable';
  return 'start_failed';
}

/**
 * A calm, informational line shown while a stopped workspace starts again, saying why it had stopped.
 * Only for stops the user did not ask for and that are not limits (limits are problems with their own state).
 */
export function noticeFor(by, cfg = {}) {
  switch (by) {
    case 'idle':
      return { code: 'resumed_idle', severity: 'info', message: `Your workspace was paused after ${spanText(cfg.idleSeconds ?? 1800)} without activity. Your files and sessions are kept.` };
    case 'busy_cap':
      return { code: 'resumed_busy_cap', severity: 'info', message: `Your agent kept working for ${spanText(cfg.maxBusySeconds ?? 7200)} after you left, then your workspace was paused. Your files and sessions are kept.` };
    case 'evicted':
      return { code: 'resumed_evicted', severity: 'info', message: 'Your workspace was paused to free a slot for other users while it was idle. Your files and sessions are kept.' };
    default:
      return null;
  }
}

/**
 * The model-access state for a usage report from the llm-proxy, or null. The service-wide budget wins over a personal
 * quota because it is the one the user cannot fix themselves.
 */
export function usageProblem(usage) {
  if (!usage) return null;
  if (usage.global?.exhausted) return problemFor('budget', { resetsAt: usage.global.resetsAt });
  if (usage.exhausted && usage.blockedBy) {
    const w = usage[usage.blockedBy];
    return problemFor(usage.blockedBy === 'day' ? 'quota_day' : 'quota_month', { used: w.used, limit: w.limit, resetsAt: w.resetsAt });
  }
  return null;
}
