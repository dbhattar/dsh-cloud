import { adminPage } from './pages.js';

/**
 * The admin panel's routes, as one table. The server dispatches every /gw/admin request through `handleAdmin`, which checks the
 * guard first and only then looks in this table, so a route added here cannot be reached without being an admin, and a path that
 * is not in the table looks the same to everyone else as a path that does not exist.
 *
 * What the panel may show: accounts, state, usage, audit rows, feedback and health. Never the content of a workspace, a session
 * or a prompt or reply, and there is no "sign in as this user" (docs/plan-phase-5.md, "Admin panel (design)").
 */
export const ADMIN_PREFIX = '/gw/admin';

/** Headers for every admin response: the panel is never shown inside another page. */
const ADMIN_HEADERS = { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' };

export function adminRoutes({ store }) {
  return [
    { method: 'GET', path: '/gw/admin', page: true, handle: ({ admin }) => ({ html: adminPage({ email: admin.email }) }) },
    { method: 'GET', path: '/gw/admin/api/me', handle: ({ admin }) => ({ json: { id: admin.id, email: admin.email } }) },
    {
      // What admins have done: grants and revokes, invites. Newest first. Details are the audit detail, which never holds content.
      method: 'GET',
      path: '/gw/admin/api/audit',
      handle: () => ({
        json: {
          events: store.queryAudit({ event: 'admin.', limit: 50 }).map((r) => ({ ts: new Date(r.ts).toISOString(), event: r.event, userId: r.userId, detail: r.detail })),
        },
      }),
    },
  ];
}

/**
 * Guard and dispatch. `send` and `json` are the gateway's response helpers; `login` builds the redirect for a signed-out visitor.
 * Signed out: the page redirects to sign-in and the API says 401. Signed in but not an admin: 404 for everything, so the panel's
 * existence is not confirmed to ordinary users, and the attempt is audited.
 */
export function createAdminHandler({ store, audit, userOf, clientIp, send, json }) {
  const routes = adminRoutes({ store });
  return async function handleAdmin(req, res, path) {
    const route = routes.find((r) => r.method === req.method && r.path === path);
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
    const out = await route.handle({ req, res, admin: user });
    if (out.html !== undefined) return send(res, 200, out.html, ADMIN_HEADERS);
    return send(res, out.status ?? 200, JSON.stringify(out.json), { ...ADMIN_HEADERS, 'content-type': 'application/json' });
  };
}
