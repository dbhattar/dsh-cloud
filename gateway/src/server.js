import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { ADMIN_PREFIX, createAdminHandler } from './admin.js';
import { Audit } from './audit.js';
import { MIN_PASSWORD, RateLimiter, hashPassword, normalizeEmail, parseCookies, safeNext, verifyPassword } from './auth.js';
import { FEEDBACK_KINDS, WEB_DIST, appShellPage, feedbackPage, launchingPage, loginPage } from './pages.js';
import { proxyHttp, proxyUpgrade } from './proxy.js';
import { usageProblem } from './states.js';

const COOKIE = 'gw_session';
/** What a sign-up says for each state of an invite code. */
const INVITE_MESSAGES = {
  missing: 'Enter your invite code.',
  unknown: 'That invite code is not valid. Check it for typos, or ask for a new one.',
  used: 'That invite code has already been used. Ask for a new one.',
  expired: 'That invite code has expired. Ask for a new one.',
};
const ASSET_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

export function createGateway({ cfg, store, manager, log = console.log, audit = new Audit({ store, log }) }) {
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const feedbackLimiter = new RateLimiter(10, 60 * 60 * 1000);
  const signupLimiter = new RateLimiter(10, 60 * 60 * 1000);
  const inviteLookupLimiter = new RateLimiter(30, 60 * 60 * 1000); // checks of an invite link, per address

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

  const handleAdmin = createAdminHandler({ store, audit, userOf, clientIp, send, json });

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

    const query = new URL(req.url, 'http://x').searchParams;
    const loginOptions = { allowSignup: true, inviteRequired: !cfg.allowSignup };

    // Sign-in and sign-up page. /gw/signup?invite=CODE is the link an invite is sent as; ?next=/path is where to go afterwards.
    if ((path === '/gw/login' || path === '/gw/signup') && req.method === 'GET') {
      const next = safeNext(query.get('next'));
      if (userOf(req)) return send(res, 303, '', { location: next ?? '/' });
      const code = (query.get('invite') ?? '').trim().slice(0, 100);
      let invite = null;
      if (code) {
        const ip = clientIp(req);
        // Looking up codes is rate limited per address; past the limit nothing is revealed about a code.
        if (inviteLookupLimiter.blocked(ip)) invite = { code, status: 'unknown' };
        else {
          inviteLookupLimiter.fail(ip);
          invite = { code, status: store.inviteStatus(code) };
        }
      }
      // An invite link that cannot be used says why, above the form; the code stays in the field so it can be corrected.
      const error = invite && invite.status !== 'valid' ? INVITE_MESSAGES[invite.status] : undefined;
      return send(res, 200, loginPage({ ...loginOptions, error, invite, next, mode: path === '/gw/signup' || invite ? 'signup' : 'login' }));
    }
    if (path === '/gw/login' && req.method === 'POST') {
      const form = await readForm(req);
      const email = normalizeEmail(form.email);
      const next = safeNext(form.next);
      const key = `${clientIp(req)}|${email}`;
      const again = (error) => loginPage({ ...loginOptions, error, next, email: String(form.email ?? '').slice(0, 254) });
      if (loginLimiter.blocked(key)) {
        audit.record('login.fail', { ip: clientIp(req), reason: 'rate_limited', email });
        return send(res, 429, again('Too many attempts. Try again later.'));
      }
      const user = email ? store.userByEmail(email) : null;
      const ok = verifyPassword(String(form.password ?? ''), user?.pw_hash);
      if (!user || !ok) {
        loginLimiter.fail(key);
        audit.record('login.fail', { userId: user?.id ?? null, ip: clientIp(req), reason: 'bad_credentials', email });
        return send(res, 401, again('Invalid email or password.'));
      }
      loginLimiter.reset(key);
      audit.record('login.ok', { userId: user.id, ip: clientIp(req) });
      const token = store.createSession(user.id, cfg.sessionTtlSeconds);
      return send(res, 303, '', { location: next ?? '/', 'set-cookie': sessionCookie(token, cfg.sessionTtlSeconds) });
    }
    if (path === '/gw/signup' && req.method === 'POST') {
      const ip = clientIp(req);
      const form = await readForm(req);
      const email = normalizeEmail(form.email);
      const password = String(form.password ?? '');
      const invite = String(form.invite ?? '').trim();
      const next = safeNext(form.next);
      // The page shown after a failure keeps what was typed (not the password), and the invite as it was entered.
      const page = (error) =>
        loginPage({ ...loginOptions, error, next, email: String(form.email ?? '').slice(0, 254), mode: 'signup', invite: invite ? { code: invite.slice(0, 100), status: store.inviteStatus(invite) } : null });
      if (signupLimiter.blocked(ip)) {
        audit.record('signup.fail', { ip, reason: 'rate_limited' });
        return send(res, 429, page('Too many sign-ups.'));
      }
      const fail = (msg, reason) => {
        audit.record('signup.fail', { ip, reason, email });
        return send(res, 400, page(msg));
      };
      if (!email) return fail('Enter a valid email address.', 'invalid_email');
      if (password.length < MIN_PASSWORD || password.length > 200) {
        return fail(`Password must be ${MIN_PASSWORD}-200 characters.`, 'weak_password');
      }
      signupLimiter.fail(ip); // every attempt counts, so invite codes cannot be guessed quickly
      if (!cfg.allowSignup) {
        const status = invite ? store.inviteStatus(invite) : 'missing';
        if (status !== 'valid') return fail(INVITE_MESSAGES[status], status === 'unknown' ? 'invite_invalid' : `invite_${status}`);
      }
      if (store.userByEmail(email)) return fail('Could not create that account.', 'email_taken');
      const id = cfg.allowSignup ? store.createUser(email, hashPassword(password)) : store.createUserWithInvite(email, hashPassword(password), invite);
      if (id === null) return fail(INVITE_MESSAGES.used, 'invite_used'); // spent by someone else between the check and now
      audit.record('signup.ok', { userId: id, ip, viaInvite: !cfg.allowSignup });
      const token = store.createSession(id, cfg.sessionTtlSeconds);
      return send(res, 303, '', { location: next ?? '/', 'set-cookie': sessionCookie(token, cfg.sessionTtlSeconds) });
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

    // The admin panel: its own guard and route table (admin.js), before anything else that needs a session.
    if (path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`)) return handleAdmin(req, res, path);

    const user = userOf(req);
    if (!user) return json(res, 401, { error: 'unauthenticated' });
    if (path === '/gw/api/me' && req.method === 'GET') return json(res, 200, { id: user.id, email: user.email, welcomed: store.welcomedAt(user.id) !== null, admin: user.isAdmin });
    if (path === '/gw/api/welcome' && req.method === 'POST') {
      store.markWelcomed(user.id);
      return json(res, 200, { welcomed: true });
    }
    if (path === '/gw/api/status' && req.method === 'GET') {
      return json(res, 200, manager.status(user.id));
    }
    if (path === '/gw/api/limits' && req.method === 'GET') {
      return json(res, 200, await manager.limits(user.id));
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
      // ?hold=1 (the app's Stop button): stay stopped until the user starts it again, instead of waking on the next request.
      if (new URL(req.url, 'http://x').searchParams.get('hold') === '1') await manager.stopAndHold(user.id);
      else {
        const info = await manager.runner.info(user.id);
        if (info?.running) await manager.stop(user.id, 'user');
      }
      return json(res, 200, { state: 'stopped' });
    }
    if (path === '/gw/api/restart' && req.method === 'POST') {
      await manager.restart(user.id); // returns once the old container is stopped and the new start is under way
      return json(res, 202, manager.status(user.id));
    }
    return json(res, 404, { error: 'not found' });
  }

  async function handle(req, res) {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path.startsWith('/gw/')) return await handleGw(req, res, path);

      const user = userOf(req);
      if (!user) {
        if ((req.headers.accept ?? '').includes('text/html')) {
          // Come back to this page after signing in (page navigations only; never from the workspace frame's own requests).
          const back = req.method === 'GET' && req.headers['sec-fetch-dest'] !== 'iframe' ? safeNext(req.url) : null;
          return send(res, 303, '', { location: back ? `/gw/login?next=${encodeURIComponent(back)}` : '/gw/login' });
        }
        return json(res, 401, { error: 'unauthenticated' });
      }
      manager.touch(user.id);
      // Top-level browser navigations get the account shell; the harness itself loads in its iframe.
      if (req.method === 'GET' && req.headers['sec-fetch-dest'] === 'document') {
        const src = req.url.startsWith('//') ? '/' : req.url;
        manager.releaseUserHold?.(user.id); // coming back to the app ends a stop the user asked for
        return send(res, 200, appShellPage({ email: user.email, src, workspaceName: cfg.workspaceName }));
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
