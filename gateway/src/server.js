import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { Audit } from './audit.js';
import { MIN_PASSWORD, RateLimiter, hashPassword, normalizeEmail, parseCookies, verifyPassword } from './auth.js';
import { FEEDBACK_KINDS, WEB_DIST, appShellPage, feedbackPage, launchingPage, loginPage } from './pages.js';
import { proxyHttp, proxyUpgrade } from './proxy.js';
import { usageProblem } from './states.js';

const COOKIE = 'gw_session';
const ASSET_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

export function createGateway({ cfg, store, manager, log = console.log, audit = new Audit({ store, log }) }) {
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const feedbackLimiter = new RateLimiter(10, 60 * 60 * 1000);
  const signupLimiter = new RateLimiter(10, 60 * 60 * 1000);

  const clientIp = (req) => (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;
  const userOf = (req) => store.userBySession(parseCookies(req.headers.cookie)[COOKIE]);
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try {
      return new URL(o).host === cfg.publicHost;
    } catch {
      return false;
    }
  };

  function sessionCookie(token, maxAge) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.secureCookies ? '; Secure' : ''}`;
  }
  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "frame-ancestors 'self'",
      'x-frame-options': 'SAMEORIGIN',
      ...headers,
    });
    res.end(body);
  }
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json' });

  function readForm(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 16384) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))));
      req.on('error', reject);
    });
  }

  async function handleGw(req, res, path) {
    if (path.startsWith('/gw/assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
      // Public on purpose: the login page needs them. Hashed filenames, flat directory, no traversal.
      const name = path.slice('/gw/assets/'.length);
      const type = ASSET_TYPES[name.slice(name.lastIndexOf('.'))];
      if (!/^[\w.-]+$/.test(name) || name.includes('..') || !type) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      try {
        const body = await readFile(new URL(name, WEB_DIST));
        return send(res, 200, req.method === 'HEAD' ? '' : body, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' });
      } catch {
        return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      }
    }
    if (path === '/gw/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain' });
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, 'Forbidden', { 'content-type': 'text/plain' });

    if (path === '/gw/login' && req.method === 'GET') {
      if (userOf(req)) return send(res, 303, '', { location: '/' });
      return send(res, 200, loginPage({ allowSignup: true, inviteRequired: !cfg.allowSignup }));
    }
    if (path === '/gw/login' && req.method === 'POST') {
      const form = await readForm(req);
      const email = normalizeEmail(form.email);
      const key = `${clientIp(req)}|${email}`;
      if (loginLimiter.blocked(key)) {
        audit.record('login.fail', { ip: clientIp(req), reason: 'rate_limited', email });
        return send(res, 429, loginPage({ error: 'Too many attempts. Try again later.', allowSignup: true, inviteRequired: !cfg.allowSignup }));
      }
      const user = email ? store.userByEmail(email) : null;
      const ok = verifyPassword(String(form.password ?? ''), user?.pw_hash);
      if (!user || !ok) {
        loginLimiter.fail(key);
        audit.record('login.fail', { userId: user?.id ?? null, ip: clientIp(req), reason: 'bad_credentials', email });
        return send(res, 401, loginPage({ error: 'Invalid email or password.', allowSignup: true, inviteRequired: !cfg.allowSignup }));
      }
      loginLimiter.reset(key);
      audit.record('login.ok', { userId: user.id, ip: clientIp(req) });
      const token = store.createSession(user.id, cfg.sessionTtlSeconds);
      return send(res, 303, '', { location: '/', 'set-cookie': sessionCookie(token, cfg.sessionTtlSeconds) });
    }
    if (path === '/gw/signup' && req.method === 'POST') {
      const page = (error) => loginPage({ error, allowSignup: true, inviteRequired: !cfg.allowSignup });
      const ip = clientIp(req);
      if (signupLimiter.blocked(ip)) {
        audit.record('signup.fail', { ip, reason: 'rate_limited' });
        return send(res, 429, page('Too many sign-ups.'));
      }
      const form = await readForm(req);
      const email = normalizeEmail(form.email);
      const password = String(form.password ?? '');
      const invite = String(form.invite ?? '').trim();
      const fail = (msg, reason) => {
        audit.record('signup.fail', { ip, reason, email });
        return send(res, 400, page(msg));
      };
      if (!email) return fail('Enter a valid email address.', 'invalid_email');
      if (password.length < MIN_PASSWORD || password.length > 200) {
        return fail(`Password must be ${MIN_PASSWORD}-200 characters.`, 'weak_password');
      }
      signupLimiter.fail(ip); // every attempt counts, so invite codes cannot be guessed quickly
      if (!cfg.allowSignup && !store.inviteValid(invite)) return fail('A valid invite code is required.', 'invite_invalid');
      if (store.userByEmail(email)) return fail('Could not create that account.', 'email_taken');
      const id = cfg.allowSignup ? store.createUser(email, hashPassword(password)) : store.createUserWithInvite(email, hashPassword(password), invite);
      if (id === null) return fail('A valid invite code is required.', 'invite_invalid');
      audit.record('signup.ok', { userId: id, ip, viaInvite: !cfg.allowSignup });
      const token = store.createSession(id, cfg.sessionTtlSeconds);
      return send(res, 303, '', { location: '/', 'set-cookie': sessionCookie(token, cfg.sessionTtlSeconds) });
    }
    if (path === '/gw/logout' && req.method === 'POST') {
      const t = parseCookies(req.headers.cookie)[COOKIE];
      audit.record('logout', { userId: userOf(req)?.id ?? null, ip: clientIp(req) });
      if (t) store.deleteSession(t);
      return send(res, 303, '', { location: '/gw/login', 'set-cookie': sessionCookie('', 0) });
    }

    if (path === '/gw/feedback') {
      const fbUser = userOf(req);
      if (!fbUser) return send(res, 303, '', { location: '/gw/login' });
      if (req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const context = {};
        for (const k of ['source', 'harness_version', 'device_info']) {
          const v = q.get(`prefill_${k}`);
          if (v) context[k] = v.slice(0, 500);
        }
        return send(res, 200, feedbackPage({ email: fbUser.email, context }));
      }
      if (req.method === 'POST') {
        const form = await readForm(req);
        const message = String(form.message ?? '').trim();
        const context = {};
        for (const k of ['source', 'harness_version', 'device_info']) if (form[k]) context[k] = String(form[k]).slice(0, 500);
        if (!message || message.length > 4000) {
          return send(res, 400, feedbackPage({ email: fbUser.email, context, error: 'Enter a message up to 4000 characters.' }));
        }
        if (feedbackLimiter.blocked(String(fbUser.id))) {
          return send(res, 429, feedbackPage({ email: fbUser.email, context, error: 'Too much feedback sent. Try again later.' }));
        }
        feedbackLimiter.fail(String(fbUser.id));
        const kind = FEEDBACK_KINDS.includes(form.kind) ? form.kind : 'other';
        store.addFeedback(fbUser.id, kind, message, context);
        return send(res, 200, feedbackPage({ email: fbUser.email, sent: true }));
      }
    }

    const user = userOf(req);
    if (!user) return json(res, 401, { error: 'unauthenticated' });
    if (path === '/gw/api/me' && req.method === 'GET') return json(res, 200, { id: user.id, email: user.email });
    if (path === '/gw/api/status' && req.method === 'GET') {
      return json(res, 200, manager.status(user.id));
    }
    if (path === '/gw/api/usage' && req.method === 'GET') {
      if (!manager.llm) return json(res, 404, { error: 'metering is not enabled' });
      try {
        const usage = await manager.llm.usage(user.id);
        // The shared budget's totals are not the user's business; they only need to know whether it is used up and when it resets.
        const global = usage.global ? { exhausted: usage.global.exhausted, resetsAt: usage.global.resetsAt } : null;
        return json(res, 200, { ...usage, global, problem: usageProblem({ ...usage, global }) });
      } catch (e) {
        log(`usage lookup failed user=${user.id}: ${e.message}`);
        return json(res, 502, { error: 'usage unavailable' });
      }
    }
    if (path === '/gw/api/start' && req.method === 'POST') {
      manager.touch(user.id);
      manager.ensure(user.id, { explicit: true }).catch(() => {}); // outcome is reported through /gw/api/status
      return json(res, 202, manager.status(user.id));
    }
    if (path === '/gw/api/stop' && req.method === 'POST') {
      const info = await manager.runner.info(user.id);
      if (info?.running) await manager.stop(user.id, 'user');
      return json(res, 200, { state: 'stopped' });
    }
    return json(res, 404, { error: 'not found' });
  }

  async function handle(req, res) {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path.startsWith('/gw/')) return await handleGw(req, res, path);

      const user = userOf(req);
      if (!user) {
        if ((req.headers.accept ?? '').includes('text/html')) return send(res, 303, '', { location: '/gw/login' });
        return json(res, 401, { error: 'unauthenticated' });
      }
      manager.touch(user.id);
      // Top-level browser navigations get the account shell; the harness itself loads in its iframe.
      if (req.method === 'GET' && req.headers['sec-fetch-dest'] === 'document') {
        const src = req.url.startsWith('//') ? '/' : req.url;
        return send(res, 200, appShellPage({ email: user.email, src }));
      }
      const sb = await manager.ready(user.id);
      if (!sb) {
        manager.ensure(user.id).catch(() => {}); // failure is surfaced via /gw/api/status
        if ((req.headers.accept ?? '').includes('text/html')) {
          return send(res, 503, launchingPage(), { 'retry-after': '2' });
        }
        return json(res, 503, { error: 'sandbox starting' });
      }
      proxyHttp(req, res, sb, (e) => {
        log(`proxy error user=${user.id}: ${e.message}`);
        manager.invalidate(user.id);
      });
    } catch (e) {
      log(`request error: ${e.stack ?? e}`);
      if (!res.headersSent) send(res, 500, 'Internal error', { 'content-type': 'text/plain' });
      else res.destroy();
    }
  }

  async function handleUpgrade(req, socket, head) {
    const reject = (line) => socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
    try {
      const user = userOf(req);
      if (!user) return reject('401 Unauthorized');
      if (!sameOrigin(req)) return reject('403 Forbidden');
      const sb = await manager.ensure(user.id);
      proxyUpgrade(req, socket, head, sb, {
        onOpen: () => manager.wsOpen(user.id),
        onClose: () => manager.wsClose(user.id),
        onError: (e) => {
          log(`ws proxy error user=${user.id}: ${e.message}`);
          manager.invalidate(user.id);
        },
      });
    } catch (e) {
      log(`upgrade error: ${e.message}`);
      reject('502 Bad Gateway');
    }
  }

  const server = http.createServer(handle);
  server.on('upgrade', handleUpgrade);
  return server;
}
