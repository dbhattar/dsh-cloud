/**
 * The admin page for policies (P5-15): the settings an admin may change, in the gateway (policy.js) and in the llm-proxy (its own
 * policy.js, reached over its admin socket), with their current values, where each value comes from, and the last few changes.
 * Every change and reset is audited with who made it and the old and new value (numbers and on/off only, never anything secret).
 */
export function createPoliciesApi({ store, manager, audit, policies, log = () => {} }) {
  const recent = () => store.queryAudit({ event: 'admin.policy*', limit: 10 }).map((r) => ({ ts: new Date(r.ts).toISOString(), event: r.event, detail: r.detail }));

  async function list() {
    let proxy = { ok: true };
    let remote = [];
    if (manager.llm) {
      try {
        remote = (await manager.llm.policy()).settings.map((s) => ({ scope: 'proxy', type: 'int', ...s }));
      } catch (e) {
        log(`policies: could not read the model proxy's settings: ${e.message}`);
        proxy = { ok: false, error: 'The model proxy did not answer, so its settings are not shown.' };
      }
    } else proxy = { ok: null };
    return { settings: [...policies.list(), ...remote], proxy, recent: recent() };
  }

  /** The proxy's refusal, as the answer to the admin: its plain message and status, or a 502 when it could not be reached. */
  const proxyFailure = (e) => (e.status === 400 || e.status === 404 ? { status: e.status, json: { error: e.detail?.code ?? 'refused', message: e.detail?.message ?? 'The model proxy refused that value.' } } : { status: 502, json: { error: 'proxy_unreachable', message: 'The model proxy did not answer. Nothing was changed.' } });

  async function set({ key, value, confirm, admin, ip }) {
    const local = policies.set(key, value, { confirmed: confirm === true, by: admin.id });
    if (local.ok) {
      audit.record('admin.policy_set', { ip, by: admin.id, key, from: local.from, to: local.to, scope: 'gateway' });
      return { status: 200, json: { key, from: local.from, to: local.to, ...(await list()) } };
    }
    if (local.status !== 404) return { status: local.status, json: { error: local.error, message: local.message } };
    if (!manager.llm) return { status: 404, json: { error: 'not_found', message: 'No such setting.' } };
    try {
      const out = await manager.llm.setPolicy(key, value, confirm === true);
      audit.record('admin.policy_set', { ip, by: admin.id, key, from: out.from, to: out.to, scope: 'proxy' });
      return { status: 200, json: { key, from: out.from, to: out.to, ...(await list()) } };
    } catch (e) {
      return proxyFailure(e);
    }
  }

  async function reset({ key, admin, ip }) {
    const local = policies.reset(key);
    if (local.ok) {
      if (local.from !== local.to) audit.record('admin.policy_reset', { ip, by: admin.id, key, from: local.from, to: local.to, scope: 'gateway' });
      return { status: 200, json: { key, ...(await list()) } };
    }
    if (!manager.llm) return { status: 404, json: { error: 'not_found', message: 'No such setting.' } };
    try {
      const out = await manager.llm.resetPolicy(key);
      if (out.from !== out.to) audit.record('admin.policy_reset', { ip, by: admin.id, key, from: out.from, to: out.to, scope: 'proxy' });
      return { status: 200, json: { key, ...(await list()) } };
    } catch (e) {
      return proxyFailure(e);
    }
  }

  return { list, set, reset };
}
