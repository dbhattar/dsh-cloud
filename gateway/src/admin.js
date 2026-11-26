import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRecordsApi } from './admin-records.js';
import { createUsersApi } from './admin-users.js';
import { adminPage } from './pages.js';
import { createOverview } from './stats.js';

/**
 * The admin panel's routes, as one table. The server dispatches every /gw/admin request through `handleAdmin`, which checks the
 * guard first and only then looks in this table, so a route added here cannot be reached without being an admin, and a path that
 * is not in the table looks the same to everyone else as a path that does not exist.
 *
 * Paths may hold `:id` (an account number). Anything that changes state is a POST that also needs the admin page's CSRF token in
 * the `x-csrf-token` header, on top of the gateway's same-origin check.
 *
 * What the panel may show: accounts, state, usage, audit rows, feedback and health. Never the content of a workspace, a session
 * or a prompt or reply, and there is no "sign in as this user" (docs/plan-phase-5.md, "Admin panel (design)").
 */
export const ADMIN_PREFIX = '/gw/admin';

/** Headers for every admin response: the panel is never shown inside another page. */
const ADMIN_HEADERS = { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' };

const ACTIONS = ['stop', 'restart', 'signout', 'suspend', 'unsuspend'];

/** The route table. `users` is the accounts API (admin-users.js). */
export function adminRoutes({ store, overview = async () => ({}), users = null, records = null }) {
  const page = (path) => ({ method: 'GET', path, page: true, handle: ({ admin, csrf }) => ({ html: adminPage({ email: admin.email, csrf }) }) });
  const routes = [
    page('/gw/admin'),
    page('/gw/admin/users'),
    page('/gw/admin/users/:id'),
    page('/gw/admin/invites'),
    page('/gw/admin/feedback'),
    page('/gw/admin/audit'),
    { method: 'GET', path: '/gw/admin/api/me', handle: ({ admin }) => ({ json: { id: admin.id, email: admin.email } }) },
    // The numbers on the overview page, each section gathered on its own (stats.js).
    { method: 'GET', path: '/gw/admin/api/overview', handle: async () => ({ json: await overview() }) },
    {
      // What admins have done: grants and revokes, invites, actions on accounts. Newest first. Details never hold content.
      method: 'GET',
      path: '/gw/admin/api/audit',
      handle: () => ({
        json: {
          events: store.queryAudit({ event: 'admin.', limit: 50 }).map((r) => ({ ts: new Date(r.ts).toISOString(), event: r.event, userId: r.userId, detail: r.detail })),
        },
      }),
    },
  ];
  if (users) {
    routes.push(
      { method: 'GET', path: '/gw/admin/api/users', handle: async ({ query }) => ({ json: await users.list({ q: query.get('q') ?? '', page: query.get('page') }) }) },
      {
        method: 'GET',
        path: '/gw/admin/api/users/:id',
        handle: async ({ params }) => {
          const d = await users.detail(params.id);
          return d ? { json: d } : { status: 404, json: { error: 'not_found' } };
        },
      },
      ...ACTIONS.map((action) => ({
        method: 'POST',
        path: `/gw/admin/api/users/:id/${action}`,
        handle: async ({ params, admin, body, ip }) => {
          const out = await users.act({ id: params.id, action, admin, body: await body(), ip });
          return out;
        },
      })),
    );
  }
  if (records) {
    routes.push(
      { method: 'GET', path: '/gw/admin/api/invites', handle: () => ({ json: records.invites.list() }) },
      { method: 'POST', path: '/gw/admin/api/invites', handle: async ({ admin, body, ip }) => records.invites.create({ ...(await body()), admin, ip }) },
      { method: 'POST', path: '/gw/admin/api/invites/:ref/revoke', handle: ({ params, admin, ip }) => records.invites.revoke({ ref: params.ref, admin, ip }) },
      { method: 'GET', path: '/gw/admin/api/feedback', handle: ({ query }) => ({ json: records.feedback.list({ status: query.get('status'), page: query.get('page') }) }) },
      { method: 'POST', path: '/gw/admin/api/feedback/:id/read', handle: async ({ params, admin, body, ip }) => records.feedback.mark({ id: params.id, read: (await body()).read, admin, ip }) },
      { method: 'GET', path: '/gw/admin/api/audit/search', handle: ({ query }) => records.audit.search(query) },
      { method: 'GET', path: '/gw/admin/api/audit/export', handle: ({ query, admin, ip }) => records.audit.export(query, { admin, ip }) },
    );
  }
  return routes;
}

/** A path from the table with `:id` filled in, for tests and for matching. */
export const samplePath = (route) => route.path.replace(':id', '1').replace(':ref', 'aaaaaaaaaaaa');

/** `:id` is an account or feedback number, `:ref` an invite's 12-character id; anything else does not match. */
const PARAM = { ':id': '(\\d{1,9})', ':ref': '([0-9a-f]{12})' };
const matcher = (route) => new RegExp(`^${route.path.replace(/:(id|ref)/g, (m) => PARAM[m])}$`);
const paramNames = (route) => [...route.path.matchAll(/:(id|ref)/g)].map((m) => m[1]);

/**
 * Guard and dispatch. `send` and `json` are the gateway's response helpers.
 * Signed out: the page redirects to sign-in and the API says 401. Signed in but not an admin: 404 for everything, so the panel's
 * existence is not confirmed to ordinary users, and the attempt is audited. For an admin, a state-changing request without the
 * page's CSRF token is refused (and audited).
 */
export function createAdminHandler({ store, cfg, manager, audit, userOf, clientIp, send, json, sessionToken, readJson, log = () => {} }) {
  const users = createUsersApi({ store, manager, audit, log });
  const records = createRecordsApi({ store, cfg, audit });
  const routes = adminRoutes({ store, overview: createOverview({ store, manager, cfg }), users, records }).map((r) => ({ ...r, re: matcher(r), names: paramNames(r) }));
  const secret = randomBytes(32); // per process: a restart makes open admin pages reload once to get a new token
  const csrfFor = (req) => createHmac('sha256', secret).update(String(sessionToken(req) ?? '')).digest('hex');

  return async function handleAdmin(req, res, path) {
    const hit = routes.map((r) => ({ r, m: r.re.exec(path) })).find((x) => x.r.method === req.method && x.m);
    const route = hit?.r;
    const user = userOf(req);
    if (!user) {
      if (req.method === 'GET' && route?.page) return send(res, 303, '', { location: `/gw/login?next=${encodeURIComponent(path)}` });
      return json(res, 401, { error: 'unauthenticated' });
    }
    if (!user.isAdmin) {
      audit.record('admin.denied', { userId: user.id, ip: clientIp(req), path });
      return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    }
    if (!route) return json(res, 404, { error: 'not found' });
    const csrf = csrfFor(req);
    if (route.method !== 'GET') {
      const given = String(req.headers['x-csrf-token'] ?? '');
      const ok = given.length === csrf.length && timingSafeEqual(Buffer.from(given), Buffer.from(csrf));
      if (!ok) {
        audit.record('admin.denied', { userId: user.id, ip: clientIp(req), path, reason: 'csrf' });
        return json(res, 403, { error: 'csrf', message: 'This page is out of date. Reload it and try again.' });
      }
    }
    const params = Object.fromEntries((route.names ?? []).map((n, i) => [n, n === 'id' ? Number(hit.m[i + 1]) : hit.m[i + 1]]));
    let bodyPromise;
    const body = () => (bodyPromise ??= readJson(req));
    let out;
    try {
      out = await route.handle({ req, res, admin: user, csrf, params, query: new URL(req.url, 'http://x').searchParams, body, ip: clientIp(req) });
    } catch (e) {
      if (e?.status === 400) return json(res, 400, { error: 'bad_request', message: 'The request body must be JSON.' });
      log(`admin ${req.method} ${path}: ${e.stack ?? e}`);
      return json(res, 500, { error: 'internal', message: 'Something went wrong. Check the gateway log.' });
    }
    if (out.html !== undefined) return send(res, 200, out.html, ADMIN_HEADERS);
    if (out.raw) return send(res, 200, out.raw.body, { ...ADMIN_HEADERS, 'content-type': out.raw.type, 'content-disposition': `attachment; filename="${out.raw.filename}"` });
    return send(res, out.status ?? 200, JSON.stringify(out.json), { ...ADMIN_HEADERS, 'content-type': 'application/json' });
  };
}
