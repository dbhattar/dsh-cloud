import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Limiter } from './limits.js';
import { ActivityTracker } from './activity.js';
import { usageReport, windows } from './quota.js';
import { SseUsageScanner, usageOf } from './usage-parse.js';

const digest = (s) => createHash('sha256').update(s).digest();

/**
 * OpenAI-compatible metering proxy. Sandboxes authenticate with a per-user token; the real upstream key
 * is added here and never leaves this process. Bodies and keys are never logged.
 *
 * Returns two servers. `user` serves /v1/* on TCP and is reachable from every sandbox network, so it has
 * no admin routes at all. `admin` serves /admin/* and is meant for a unix socket on a volume that only the
 * gateway mounts; the admin secret is still required on top of that.
 */
export function createProxy({ cfg, store, log = console.log, fetchImpl = fetch, now = Date.now }) {
  const limiter = new Limiter({ perMinute: cfg.rateLimitPerMinute, maxConcurrent: cfg.maxConcurrent, now });
  const adminDigest = digest(cfg.adminSecret);
  const activity = new ActivityTracker();
  // Audit lines: one JSON object per event, no request or model content. Quota hits repeat on every blocked
  // request, so each (event, user) is written at most once per 10 minutes.
  const auditSeen = new Map();
  function audit(event, fields, { throttle = false } = {}) {
    if (throttle) {
      const key = `${event}|${fields.userId}`;
      if (now() - (auditSeen.get(key) ?? -Infinity) < 600_000) return;
      auditSeen.set(key, now());
    }
    log(`audit ${JSON.stringify({ ts: new Date(now()).toISOString(), event, ...fields })}`);
  }

  const sendJson = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
  };
  const fail = (res, status, code, message, headers) => sendJson(res, status, { error: { message, type: code, code } }, headers);
  const bearer = (req) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function quotaMessage(report) {
    const w = report[report.blockedBy];
    return `You have used your ${report.blockedBy === 'day' ? 'daily' : 'monthly'} token allowance (${w.used} of ${w.limit}). It resets at ${w.resetsAt}.`;
  }

  /** The service-wide daily budget as the gateway needs it to explain a refusal; null when there is no budget. */
  function globalReport() {
    if (!(cfg.globalDailyTokenBudget > 0)) return null;
    const used = store.usedAllToday(now());
    return { used, limit: cfg.globalDailyTokenBudget, exhausted: used >= cfg.globalDailyTokenBudget, resetsAt: new Date(windows(now()).dayResetsAt).toISOString() };
  }

  async function admin(req, res, path) {
    const given = bearer(req);
    if (!given || !timingSafeEqual(digest(given), adminDigest)) return fail(res, 401, 'unauthorized', 'Invalid admin credentials.');
    const userId = (s) => (/^\d{1,9}$/.test(s ?? '') ? Number(s) : null);
    if (path === '/admin/tokens' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req, 4096)).toString() || '{}');
      } catch {
        return fail(res, 400, 'invalid_request', 'Body must be JSON.');
      }
      const id = userId(String(body.userId));
      if (id === null) return fail(res, 400, 'invalid_request', 'userId must be a positive integer.');
      audit('token.issue', { userId: id });
      return sendJson(res, 200, { token: store.issueToken(id, now()) });
    }
    if (path === '/admin/activity' && req.method === 'GET') {
      // Users with a model request in flight or finished in the last 15 minutes (the gateway applies its own window).
      return sendJson(res, 200, { users: activity.snapshot(now(), 15 * 60 * 1000) });
    }
    const m = /^\/admin\/(tokens|usage)(?:\/([^/]*))?$/.exec(path);
    if (m?.[1] === 'tokens' && req.method === 'DELETE') {
      const id = userId(m[2]);
      if (id === null) return fail(res, 400, 'invalid_request', 'userId must be a positive integer.');
      store.revoke(id, now());
      audit('token.revoke', { userId: id });
      res.writeHead(204).end();
      return;
    }
    if (m?.[1] === 'usage' && req.method === 'GET') {
      if (m[2] === undefined) return sendJson(res, 200, store.allUsed(now()).map((u) => usageReport(u.userId, u, cfg, now())));
      const id = userId(m[2]);
      if (id === null) return fail(res, 400, 'invalid_request', 'userId must be a positive integer.');
      return sendJson(res, 200, { ...usageReport(id, store.used(id, now()), cfg, now()), global: globalReport() });
    }
    return fail(res, 404, 'not_found', 'Not found.');
  }

  async function chat(req, res, userId) {
    const started = now();
    const lease = limiter.acquire(userId);
    if (!lease.ok) {
      const msg = lease.reason === 'rate' ? 'Too many requests. Slow down.' : 'Too many requests in flight.';
      return fail(res, 429, 'rate_limited', msg, { 'retry-after': String(lease.retryAfter) });
    }
    activity.begin(userId, now());
    const ctrl = new AbortController();
    let model = '-';
    let status = 0;
    let usage = null;
    let estimated = false;
    try {
      const declared = Number(req.headers['content-length']);
      if (declared > cfg.maxBodyBytes) return (status = 413), fail(res, 413, 'request_too_large', 'Request body is too large.');
      let raw;
      let body;
      try {
        raw = await readBody(req, cfg.maxBodyBytes);
        body = JSON.parse(raw.toString());
      } catch (e) {
        status = e.status ?? 400;
        return fail(res, status, status === 413 ? 'request_too_large' : 'invalid_request', status === 413 ? 'Request body is too large.' : 'Body must be JSON.');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return (status = 400), fail(res, 400, 'invalid_request', 'Body must be a JSON object.');
      model = typeof body.model === 'string' ? body.model : '-';
      if (!cfg.allowedModels.includes(model)) {
        status = 400;
        return fail(res, 400, 'model_not_allowed', `Model is not available. Allowed: ${cfg.allowedModels.join(', ')}.`);
      }
      if (cfg.globalDailyTokenBudget > 0 && store.usedAllToday(now()) >= cfg.globalDailyTokenBudget) {
        status = 429;
        audit('budget.exhausted', { userId, budget: cfg.globalDailyTokenBudget }, { throttle: true });
        const resetsAt = windows(now()).dayResetsAt;
        return fail(res, 429, 'budget_exhausted', `The service's daily model budget is used up for everyone. It resets at ${new Date(resetsAt).toISOString()}.`, { 'retry-after': String(Math.max(1, Math.ceil((resetsAt - now()) / 1000))) });
      }
      const report = usageReport(userId, store.used(userId, now()), cfg, now());
      if (report.exhausted) {
        status = 429;
        audit('quota.hit', { userId, window: report.blockedBy, used: report[report.blockedBy].used, limit: report[report.blockedBy].limit }, { throttle: true });
        const resetsAt = Date.parse(report[report.blockedBy].resetsAt);
        return fail(res, 429, 'quota_exceeded', quotaMessage(report), { 'retry-after': String(Math.max(1, Math.ceil((resetsAt - now()) / 1000))) });
      }

      // One call must not overshoot the quota by much: cap output, and make streams report usage.
      const cap = cfg.maxOutputTokens;
      if (cap > 0) {
        const key = body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
        body[key] = Number.isFinite(body[key]) && body[key] > 0 ? Math.min(body[key], cap) : cap;
      }
      // Some upstream models (e.g. OpenRouter free) require reasoning and reject requests that disable it.
      if (body.reasoning && typeof body.reasoning === 'object' && (body.reasoning.enabled === false || body.reasoning.effort === 'none')) delete body.reasoning;
      if (body.reasoning_effort === 'none') delete body.reasoning_effort;
      if (body.stream === true) body.stream_options = { ...(typeof body.stream_options === 'object' ? body.stream_options : {}), include_usage: true };
      const payload = JSON.stringify(body);

      res.on('close', () => {
        if (!res.writableFinished) ctrl.abort();
      });
      let upstream;
      try {
        upstream = await fetchImpl(`${cfg.upstreamBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: body.stream === true ? 'text/event-stream' : 'application/json',
            authorization: `Bearer ${cfg.upstreamApiKey}`,
          },
          body: payload,
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(cfg.upstreamTimeoutSeconds * 1000)]),
        });
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError';
        status = timedOut ? 504 : 502;
        log(JSON.stringify({ ev: 'upstream_error', user: userId, error: e?.name ?? 'Error' }));
        return fail(res, status, timedOut ? 'upstream_timeout' : 'upstream_unavailable', timedOut ? 'The model provider timed out.' : 'The model provider is unavailable.');
      }
      if (upstream.status === 401 || upstream.status === 403) {
        upstream.body?.cancel().catch(() => {});
        status = 502;
        log(JSON.stringify({ ev: 'upstream_rejected_credentials', user: userId, upstreamStatus: upstream.status }));
        return fail(res, 502, 'upstream_auth_failed', 'The model provider rejected the service credentials.');
      }

      status = upstream.status;
      const type = upstream.headers.get('content-type') ?? 'application/json';
      const headers = { 'content-type': type, 'cache-control': 'no-store' };
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter) headers['retry-after'] = retryAfter;
      res.writeHead(status, headers);

      const sse = type.includes('text/event-stream');
      const scanner = new SseUsageScanner();
      const parts = [];
      let outBytes = 0;
      try {
        for await (const chunk of upstream.body ?? []) {
          outBytes += chunk.length;
          if (sse) scanner.feed(chunk);
          else if (outBytes <= 16 * 1024 * 1024) parts.push(chunk);
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r).once('close', r));
        }
        res.end();
      } catch {
        res.destroy(); // client went away or the upstream stream broke; charge for what was produced
      }
      if (status < 200 || status >= 300) return;
      if (sse) {
        scanner.end();
        usage = scanner.usage;
      } else {
        try {
          usage = usageOf(JSON.parse(Buffer.concat(parts).toString()));
        } catch {
          usage = null;
        }
      }
      if (!usage) {
        // Provider omitted usage: charge a conservative byte-based estimate rather than nothing.
        usage = { input: Math.ceil(raw.length / 4), output: Math.ceil(outBytes / 4) };
        estimated = true;
      }
    } finally {
      lease.release();
      activity.end(userId, now());
      if (usage) store.record(userId, usage, now());
      log(
        JSON.stringify({
          ev: 'llm',
          user: userId,
          model,
          status,
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          estimated,
          ms: now() - started,
        }),
      );
    }
  }

  async function handle(req, res) {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path === '/healthz') return sendJson(res, 200, { ok: true });
      if (path !== '/v1/chat/completions' && path !== '/v1/models') return fail(res, 404, 'not_found', 'Not found.');

      const userId = store.userByToken(bearer(req));
      if (userId === null) return fail(res, 401, 'invalid_api_key', 'Invalid or revoked API token.');
      if (path === '/v1/models' && req.method === 'GET') {
        return sendJson(res, 200, { object: 'list', data: cfg.allowedModels.map((id) => ({ id, object: 'model', owned_by: 'dsh-cloud' })) });
      }
      if (path === '/v1/chat/completions' && req.method === 'POST') return await chat(req, res, userId);
      return fail(res, 405, 'method_not_allowed', 'Method not allowed.', { allow: path === '/v1/models' ? 'GET' : 'POST' });
    } catch (e) {
      log(JSON.stringify({ ev: 'error', error: e?.message ?? String(e) }));
      if (!res.headersSent) fail(res, 500, 'internal_error', 'Internal error.');
      else res.destroy();
    }
  }

  async function handleAdmin(req, res) {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      return await admin(req, res, path);
    } catch (e) {
      log(JSON.stringify({ ev: 'error', error: e?.message ?? String(e) }));
      if (!res.headersSent) fail(res, 500, 'internal_error', 'Internal error.');
      else res.destroy();
    }
  }

  return { user: http.createServer(handle), admin: http.createServer(handleAdmin) };
}
