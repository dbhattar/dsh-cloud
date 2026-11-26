import { problemFor } from './states.js';

/**
 * The admin pages for accounts: a searchable list, one account's page, and the actions an admin may take on it. What an admin
 * sees is accounts, state, usage, audit rows and the feedback people sent to us; never workspace, session or prompt content.
 *
 * Every action is audited as `admin.user_<action>` with the target as the row's user and the acting admin in the detail.
 * Suspending needs the account's email typed back, and an admin cannot suspend an admin (including themselves): that is what
 * the command line is for (scripts/make-admin.sh --revoke), so a suspension can never lock the last admin out.
 */
const ID = /^\d{1,9}$/;

const orNull = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

export function createUsersApi({ store, manager, audit, log = () => {} }) {
  /** Sandbox state words for one account: none, stopped, running, plus whether it is held and why. */
  const sandboxOf = (id, listed) => {
    const state = listed === undefined ? null : listed === 'running' ? 'running' : listed === 'stopped' ? 'stopped' : 'none';
    const code = manager.heldCode(id);
    return { state, held: code ? { code, title: problemFor(code, {}, manager.cfg).title } : null };
  };

  const detail = async (id) => {
    const account = store.accountById(id);
    if (!account) return null;
    const list = await orNull(() => manager.runner.list());
    const listed = list ? (list.find((s) => s.userId === id)?.running ? 'running' : list.some((s) => s.userId === id) ? 'stopped' : 'none') : undefined;
    const info = listed === 'running' ? await orNull(() => manager.runner.info(id)) : null;
    const usage = manager.llm ? await orNull(() => manager.llm.usage(id)) : null;
    const storage = await orNull(() => manager.storageByUser());
    return {
      account,
      sandbox: { ...sandboxOf(id, listed), startedAt: info?.startedAt ?? null, reachable: list !== null },
      usage: usage ? { day: usage.day, month: usage.month, exhausted: usage.exhausted } : null,
      storageBytes: storage ? (storage.get(id) ?? 0) : null,
      audit: store.queryAudit({ userId: id, limit: 30 }).map((r) => ({ ts: new Date(r.ts).toISOString(), event: r.event, ip: r.ip, detail: r.detail })),
      feedback: store.feedbackFor(id),
    };
  };

  const list = async ({ q, page }) => {
    const limit = 25;
    const offset = Math.max(0, (Number.parseInt(page, 10) || 1) - 1) * limit;
    const { rows, total } = store.listUsers({ q, limit, offset });
    const [boxes, all, storage] = await Promise.all([
      orNull(() => manager.runner.list()),
      manager.llm ? orNull(() => manager.llm.usageAll()) : null,
      orNull(() => manager.storageByUser()),
    ]);
    const running = new Map((boxes ?? []).map((s) => [s.userId, s.running]));
    const used = new Map((all ?? []).map((u) => [u.userId, u]));
    return {
      total,
      page: offset / limit + 1,
      pageSize: limit,
      sources: { runner: boxes !== null, proxy: manager.llm ? all !== null : null, storage: storage !== null },
      users: rows.map((r) => ({
        ...r,
        sandbox: { ...sandboxOf(r.id, boxes === null ? undefined : running.has(r.id) ? (running.get(r.id) ? 'running' : 'stopped') : 'none') },
        tokens: used.has(r.id) ? { day: used.get(r.id).day.used, month: used.get(r.id).month.used, exhausted: used.get(r.id).exhausted } : null,
        storageBytes: storage ? (storage.get(r.id) ?? 0) : null,
      })),
    };
  };

  /** Run one action on one account. Returns { status, json }. `admin` is the acting admin; `ip` is for the audit row. */
  const act = async ({ id, action, admin, body, ip }) => {
    const target = store.accountById(id);
    if (!target) return { status: 404, json: { error: 'not_found' } };
    const refuse = (error, message) => ({ status: 409, json: { error, message } });
    const record = (extra = {}) => audit.record(`admin.user_${action}`, { userId: id, ip, by: admin.id, ...extra });
    switch (action) {
      case 'stop':
        await manager.stopByAdmin(id);
        record();
        break;
      case 'restart':
        if (target.suspendedAt) return refuse('suspended', 'This account is suspended. Lift the suspension first.');
        await manager.restart(id);
        record();
        break;
      case 'signout': {
        const n = store.deleteSessionsFor(id);
        record({ sessions: n });
        break;
      }
      case 'suspend':
        if (target.isAdmin) return refuse('admin_target', 'An admin cannot be suspended here. Take the role away first with scripts/make-admin.sh --revoke.');
        if (target.suspendedAt) return refuse('already', 'This account is already suspended.');
        if (typeof body?.confirm !== 'string' || body.confirm.trim().toLowerCase() !== target.email.toLowerCase()) {
          return { status: 400, json: { error: 'confirm_mismatch', message: 'Type the account\'s email address exactly to confirm.' } };
        }
        store.suspendUser(id); // first: from here on they cannot sign in or use a session, whatever happens next
        try {
          await manager.suspend(id);
        } catch (e) {
          log(`suspend ${id}: ${e.message}`);
          record({ partial: true });
          return { status: 502, json: { error: 'partial', message: 'The account is suspended and signed out, but its model access could not be revoked just now. Try Suspend again later, or check the model proxy.', detail: await detail(id) } };
        }
        record();
        break;
      case 'unsuspend':
        if (!target.suspendedAt) return refuse('not_suspended', 'This account is not suspended.');
        store.unsuspendUser(id);
        await manager.unsuspend(id);
        record();
        break;
      default:
        return { status: 404, json: { error: 'not_found' } };
    }
    return { status: 200, json: await detail(id) };
  };

  return { list, detail, act, validId: (s) => ID.test(s ?? '') };
}
