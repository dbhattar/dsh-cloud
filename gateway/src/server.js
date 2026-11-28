import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { ADMIN_PREFIX, createAdminHandler } from './admin.js';
import { createPolicies } from './policy.js';
import { Audit } from './audit.js';
import { createMailer } from './mail.js';
import { createMailFlows } from './mail-flows.js';
import { MIN_PASSWORD, RateLimiter, hashPassword, normalizeEmail, parseCookies, safeNext, verifyPassword } from './auth.js';
import { FEEDBACK_KINDS, WEB_DIST, appShellPage, feedbackPage, forgotPage, launchingPage, loginPage, noticePage, resetPage, waitlistPage } from './pages.js';
import { proxyHttp, proxyUpgrade } from './proxy.js';
import { usageProblem } from './states.js';

const COOKIE = 'gw_session';
/** What a sign-up says for each state of an invite code. */
const INVITE_MESSAGES = {
  missing: 'Enter your invite code.',
  unknown: 'That invite code is not valid. Check it for typos, or ask for a new one.',
  used: 'That invite code has already been used. Ask for a new one.',
  expired: 'That invite code has expired. Ask for a new one.',
  revoked: 'That invite is no longer valid. Ask for a new one.',
};
const ASSET_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createGateway({ cfg, store, manager, log = console.log, audit = new Audit({ store, log }), mailer = createMailer({ cfg, audit, log }) }) {
  const mail = createMailFlows({ cfg, store, mailer, audit });
  // Admin-editable settings: the stored overrides are applied to cfg now, and again on every change (policy.js).
  const policies = createPolicies({ cfg, store, log });
  policies.load();
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const feedbackLimiter = new RateLimiter(10, 60 * 60 * 1000);
  const signupLimiter = new RateLimiter(10, 60 * 60 * 1000);
  const inviteLookupLimiter = new RateLimiter(30, 60 * 60 * 1000); // checks of an invite link, per address
  const forgotLimiter = new RateLimiter(5, 60 * 60 * 1000); // reset requests, per address of the caller (every request counts)
  const waitlistLimiter = new RateLimiter(5, 60 * 60 * 1000); // waitlist sign-ups, per address of the caller (every request counts)
  const resetLimiter = new RateLimiter(20, 60 * 60 * 1000); // looks at and uses of a reset link, per address of the caller

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

  const handleAdmin = createAdminHandler({ store, cfg, manager, audit, policies, mail, userOf, clientIp, send, json, sessionToken: (req) => parseCookies(req.headers.cookie)[COOKIE], readJson, log });

  /** A small JSON request body (the admin actions); rejects with status 400 when it is not JSON. */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      const bad = () => reject(Object.assign(new Error('bad body'), { status: 400 }));
      req.on('data', (c) => {
        size += c.length;
        if (size > 4096) {
          bad();
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString();
          resolve(text ? JSON.parse(text) : {});
        } catch {
          bad();
        }
      });
      req.on('error', bad);
    });
  }

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
      // Public on purpose: the login page needs them. Flat directory, no traversal. Build output has hashed names (cached for good); the icons do not (an hour).
      const name = path.slice('/gw/assets/'.length);
      const type = ASSET_TYPES[name.slice(name.lastIndexOf('.'))];
      if (!/^[\w.-]+$/.test(name) || name.includes('..') || !type) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      try {
        const body = await readFile(new URL(name, WEB_DIST));
        return send(res, 200, req.method === 'HEAD' ? '' : body, { 'content-type': type, 'cache-control': /-[\w]{8}\.\w+$/.test(name) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' });
      } catch {
        return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      }
    }
    if (path === '/gw/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain' });
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, 'Forbidden', { 'content-type': 'text/plain' });

    const query = new URL(req.url, 'http://x').searchParams;
    const loginOptions = { allowSignup: true, inviteRequired: !cfg.allowSignup, canReset: mailer.enabled, canJoinWaitlist: !cfg.allowSignup };
    // Pages whose address holds a secret. Not `no-referrer`: with it a browser sends `Origin: null` on the form post, which the
    // same-origin check rightly refuses. `strict-origin` sends only the origin, never the path and token, and a true Origin.
    const noReferrer = { 'referrer-policy': 'strict-origin' };

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
      const notice = query.get('reset') === '1' ? 'Your password was changed. Sign in with the new one.' : undefined;
      return send(res, 200, loginPage({ ...loginOptions, error, notice, invite, next, mode: path === '/gw/signup' || invite ? 'signup' : 'login' }));
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
      // Said only after the right password, so it does not confirm that an address has an account.
      if (user.suspended_at) {
        audit.record('login.fail', { userId: user.id, ip: clientIp(req), reason: 'suspended' });
        return send(res, 403, again('This account has been suspended. If you think that is a mistake, contact whoever invited you.'));
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
      store.removeFromWaitlist(email);
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

    // ---- the waitlist: people with no invite ask for a place; an admin invites them from the panel ----
    if (path === '/gw/waitlist' && !cfg.allowSignup && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') return send(res, 200, waitlistPage({}));
      const ip = clientIp(req);
      const form = await readForm(req);
      if (waitlistLimiter.blocked(ip)) {
        audit.record('waitlist.join', { ip, reason: 'rate_limited' });
        return send(res, 429, waitlistPage({ error: 'Too many requests. Try again later.' }));
      }
      waitlistLimiter.fail(ip);
      const email = normalizeEmail(form.email);
      if (!email) return send(res, 400, waitlistPage({ error: 'Enter a valid email address.', email: String(form.email ?? '').slice(0, 254) }));
      // Someone who already has an account is not added, and is not told so: the answer is the same for everyone.
      const result = store.userByEmail(email) ? 'account' : store.joinWaitlist(email);
      if (result === 'full') return send(res, 503, waitlistPage({ error: 'The waitlist is full right now. Please try again later.', email }));
      // A new address is asked to confirm; so is a repeat that never did (the first message may not have gone, or was lost), within the
      // per-address mail limit. A confirmed address is not mailed again.
      if (mailer.enabled && (result === 'new' || (result === 'exists' && !store.waitlistEntry(email)?.confirmedAt))) mail.waitlistConfirm(email);
      audit.record('waitlist.join', { ip, result: result === 'account' ? 'exists' : result });
      return send(res, 200, waitlistPage({ done: true, confirmMail: mailer.enabled }));
    }
    if (path === '/gw/waitlist/confirm' && !cfg.allowSignup && (req.method === 'GET' || req.method === 'POST')) {
      const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(query);
      const email = normalizeEmail(form.e);
      if (!email || !mail.waitlistSigOk(email, form.t)) return send(res, 400, noticePage({ title: 'This link does not work', message: 'The link is incomplete or was changed. Use the link in the message, or join the waitlist again.' }));
      if (req.method === 'GET') return send(res, 200, noticePage({ title: 'Confirm your place', message: 'Confirm that this address is yours, and stay on the waitlist.', action: { label: 'Confirm', href: '/gw/waitlist/confirm', fields: { e: email, t: String(form.t) } } }));
      if (store.confirmWaitlist(email)) audit.record('waitlist.confirm', { ip: clientIp(req) });
      return send(res, 200, noticePage({ title: 'Thank you', message: 'Your place on the waitlist is confirmed. We will email you an invitation when a place opens.' }));
    }
    // ---- password reset by email (docs/email.md) ----
    if (path === '/gw/forgot' && req.method === 'GET') return send(res, 200, forgotPage({ available: mailer.enabled }));
    if (path === '/gw/forgot' && req.method === 'POST') {
      const ip = clientIp(req);
      const form = await readForm(req);
      if (!mailer.enabled) return send(res, 200, forgotPage({ available: false }));
      if (forgotLimiter.blocked(ip)) {
        audit.record('password.reset_request', { ip, reason: 'rate_limited' });
        return send(res, 429, forgotPage({ error: 'Too many requests. Try again later.' }));
      }
      forgotLimiter.fail(ip);
      const email = normalizeEmail(form.email);
      if (!email) return send(res, 400, forgotPage({ error: 'Enter a valid email address.', email: String(form.email ?? '').slice(0, 254) }));
      const r = mail.requestReset(email);
      audit.record('password.reset_request', { ip, userId: r.userId, known: r.known, queued: r.queued });
      // The same page whether or not the address has an account, so this cannot be used to find out who has one.
      return send(res, 200, forgotPage({ sent: true }));
    }
    if (path === '/gw/reset' && req.method === 'GET') {
      const ip = clientIp(req);
      const token = (query.get('token') ?? '').slice(0, 100);
      if (resetLimiter.blocked(ip)) return send(res, 429, resetPage({ token, status: 'unknown', error: 'Too many attempts. Try again later.' }), noReferrer);
      resetLimiter.fail(ip);
      return send(res, 200, resetPage({ token, status: store.resetTokenStatus(token) }), noReferrer);
    }
    if (path === '/gw/reset' && req.method === 'POST') {
      const ip = clientIp(req);
      const form = await readForm(req);
      const token = String(form.token ?? '').slice(0, 100);
      if (resetLimiter.blocked(ip)) return send(res, 429, resetPage({ token, status: 'unknown', error: 'Too many attempts. Try again later.' }), noReferrer);
      resetLimiter.fail(ip);
      const status = store.resetTokenStatus(token);
      if (status !== 'valid') return send(res, 400, resetPage({ token, status }), noReferrer);
      const password = String(form.password ?? '');
      // Checked before the token is used up, so a typo does not cost the link.
      if (password.length < MIN_PASSWORD || password.length > 200) return send(res, 400, resetPage({ token, status, error: `Password must be ${MIN_PASSWORD}-200 characters.` }), noReferrer);
      if (password !== String(form.confirm ?? '')) return send(res, 400, resetPage({ token, status, error: 'The two passwords are not the same.' }), noReferrer);
      const userId = store.consumeResetToken(token);
      if (userId === null) return send(res, 400, resetPage({ token, status: 'used' }), noReferrer); // used by another request just now
      store.setPassword(userId, hashPassword(password)); // also ends every session of the account
      audit.record('password.reset', { userId, ip });
      mail.passwordChanged(userId);
      return send(res, 303, '', { location: '/gw/login?reset=1', ...noReferrer });
    }
    // ---- opting out of the "your workspace finished" message; the link in the message carries a signature ----
    if (path === '/gw/mail/stop' && (req.method === 'GET' || req.method === 'POST')) {
      const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(query);
      const userId = /^\d{1,9}$/.test(String(form.u ?? '')) ? Number(form.u) : null;
      if (userId === null || !mail.stopSigOk(userId, form.t) || !store.userById(userId)) return send(res, 400, noticePage({ title: 'This link does not work', message: 'The link is incomplete or was changed. Use the link in the message, or ask whoever runs this service.' }));
      const fields = { u: String(userId), t: String(form.t) };
      if (req.method === 'GET') return send(res, 200, noticePage({ title: 'Stop these emails?', message: 'You will no longer get a message when your workspace finishes working while you are away. Other messages, such as password resets, still arrive.', action: { label: 'Stop these emails', href: '/gw/mail/stop', fields } }));
      const on = form.on === '1';
      store.setMailNotices(userId, on);
      audit.record(on ? 'mail.opt_in' : 'mail.opt_out', { userId, ip: clientIp(req) });
      return send(res, 200, noticePage(on
        ? { title: 'Turned back on', message: 'You will get a message when your workspace finishes working while you are away.' }
        : { title: 'Done', message: 'You will not get these messages any more.', action: { label: 'Turn them back on', href: '/gw/mail/stop', fields: { ...fields, on: '1' } } }));
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
    // The request target is whatever bytes the client sent. Parsed inside the guard: a target that is not a valid URL ("//[") used to
    // throw here, outside any try, and ended the whole process (docs/security-review.md, SEC-01). Once this succeeds, every later
    // `new URL(req.url, ...)` on the same string in the gateway succeeds too.
    let path;
    try {
      path = new URL(req.url, 'http://x').pathname;
    } catch {
      return send(res, 400, 'Bad request', { 'content-type': 'text/plain' });
    }
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
    // First, before any await: once a request is upgraded Node hands over the raw socket and removes its own error handling, so a client
    // that resets the connection while the sandbox is still starting (up to the start timeout plus the waiting room) would emit an
    // unhandled 'error' and end the process (SEC-03).
    socket.on('error', () => {});
    try {
      const user = userOf(req);
      if (!user) return reject('401 Unauthorized');
      if (!sameOrigin(req)) return reject('403 Forbidden');
      const sb = await manager.ensure(user.id);
      if (socket.destroyed) return; // the client left while the sandbox was starting
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
  server.mail = mail; // so index.js can wire the sandbox manager's "agent finished" signal to it
  server.on('upgrade', handleUpgrade);
  return server;
}
