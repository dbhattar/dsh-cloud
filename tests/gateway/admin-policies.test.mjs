// P5-15: policies an admin can change without a restart, in the gateway and (through its admin socket) the llm-proxy.
// A real gateway in this process with a fake runner and a fake proxy; no Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { POLICIES, createPolicies, crossCheck, policyOf, validate } from '../../gateway/src/policy.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';
import { Audit } from '../../gateway/src/audit.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const PW = 'a-long-password-1';

// ---- the settings and their checks ----
test('every setting is described, bounded, and has a default that passes its own checks', () => {
  const cfg = loadConfig(base);
  const keys = new Set();
  for (const p of POLICIES) {
    assert.ok(!keys.has(p.key), `duplicate ${p.key}`);
    keys.add(p.key);
    assert.ok(p.label && p.description && p.group && p.applies, p.key);
    assert.ok(p.key in cfg, `${p.key} is a real setting`);
    if (p.type === 'int') {
      assert.ok(p.unit && p.min >= 0 && p.max > p.min, p.key);
      const d = cfg[p.key];
      assert.ok(d === 0 ? Boolean(p.zero) : d >= p.min && d <= p.max, `${p.key}: the default ${d} fits ${p.min}..${p.max}`);
    }
  }
  assert.equal(crossCheck({ idleSeconds: 1800, maxBusySeconds: 0 }), null);
  assert.equal(crossCheck({ idleSeconds: 1800, maxBusySeconds: 7200 }), null);
  assert.match(crossCheck({ idleSeconds: 3600, maxBusySeconds: 1800 }), /at least the idle time/);
});

test('validation: whole numbers inside the bounds, 0 only where it means off and only when confirmed, booleans, the opening-up confirmation', () => {
  const idle = policyOf('idleSeconds');
  assert.deepEqual(validate(idle, 900), { ok: true, value: 900 });
  assert.deepEqual(validate(idle, '900'), { ok: true, value: 900 });
  for (const bad of [-5, 1.5, 'soon', '', '1e3', null, undefined, 30, 7 * 86400 + 1, 0]) assert.equal(validate(idle, bad).ok, false, String(bad));
  assert.equal(validate(idle, 0).error, 'out_of_range', '0 is not "off" for the idle time: it is simply too small');
  const run = policyOf('maxRunSeconds');
  assert.equal(validate(run, 0).error, 'confirm_zero');
  assert.match(validate(run, 0).message, /0 means no limit/);
  assert.deepEqual(validate(run, 0, { confirmed: true }), { ok: true, value: 0 });
  const signup = policyOf('allowSignup');
  assert.equal(validate(signup, true).error, 'confirm_open');
  assert.deepEqual(validate(signup, true, { confirmed: true }), { ok: true, value: true });
  assert.deepEqual(validate(signup, false), { ok: true, value: false }, 'closing it needs no confirmation');
  assert.deepEqual(validate(signup, 'false'), { ok: true, value: false });
  for (const bad of ['yes', 1, 0, null, undefined]) assert.equal(validate(signup, bad).ok, false, String(bad));
});

test('policies: defaults come from the environment, overrides are stored and applied in place, survive a restart, reset restores', () => {
  const store = new Store(':memory:');
  const cfg = loadConfig({ ...base, IDLE_SECONDS: '1200' });
  const p = createPolicies({ cfg, store });
  p.load();
  const row = (key) => p.list().find((x) => x.key === key);
  assert.deepEqual([row('idleSeconds').value, row('idleSeconds').default, row('idleSeconds').source], [1200, 1200, 'default']);
  assert.deepEqual(p.set('idleSeconds', 600, { by: 7 }), { ok: true, from: 1200, to: 600 });
  assert.equal(cfg.idleSeconds, 600, 'the running configuration changed in place');
  assert.deepEqual([row('idleSeconds').source, row('idleSeconds').default, row('idleSeconds').updatedBy], ['admin', 1200, 7]);
  assert.deepEqual(p.set('allowSignup', true, { confirmed: true }), { ok: true, from: false, to: true });
  assert.equal(cfg.allowSignup, true);
  // A new start: same database, same environment.
  const cfg2 = loadConfig({ ...base, IDLE_SECONDS: '1200' });
  createPolicies({ cfg: cfg2, store }).load();
  assert.deepEqual([cfg2.idleSeconds, cfg2.allowSignup], [600, true], 'an override outlives a restart, a boolean too');
  assert.deepEqual(p.reset('idleSeconds'), { ok: true, from: 600, to: 1200 });
  assert.equal(cfg.idleSeconds, 1200);
  assert.equal(store.policyOverrides().length, 1);
  // Refusals store and change nothing.
  for (const [key, value, error] of [['idleSeconds', 5, 'out_of_range'], ['idleSeconds', 'x', 'not_a_number'], ['maxRunSeconds', 0, 'confirm_zero'], ['nope', 1, 'not_found'], ['allowSignup', 'maybe', 'not_a_bool']]) {
    const r = p.set(key, value);
    assert.deepEqual([r.ok, r.error], [false, error], `${key}=${value}`);
  }
  assert.equal(cfg.idleSeconds, 1200);
  assert.equal(p.reset('nope').status, 404);
});

test('policies: the busy cap cannot be set below the idle time, nor the idle time above the busy cap', () => {
  const cfg = loadConfig({ ...base, IDLE_SECONDS: '1800', MAX_BUSY_SECONDS: '7200' });
  const p = createPolicies({ cfg, store: new Store(':memory:') });
  p.load();
  assert.equal(p.set('maxBusySeconds', 900).error, 'conflict');
  assert.equal(p.set('idleSeconds', 9000).error, 'conflict');
  assert.deepEqual([cfg.idleSeconds, cfg.maxBusySeconds], [1800, 7200]);
  assert.equal(p.set('maxBusySeconds', 0, { confirmed: true }).ok, true, 'turning the busy cap off is allowed');
  assert.equal(p.set('idleSeconds', 9000).ok, true, 'and then the idle time is free');
});

test('policies: a stored value that is invalid, retired or in conflict is ignored with a log line, and the defaults apply', () => {
  const store = new Store(':memory:');
  store.setPolicy('idleSeconds', 5);
  store.setPolicy('retired', 1);
  const logs = [];
  const cfg = loadConfig(base);
  createPolicies({ cfg, store, log: (m) => logs.push(m) }).load();
  assert.equal(cfg.idleSeconds, 1800);
  assert.equal(logs.length, 2);
  const s2 = new Store(':memory:');
  s2.setPolicy('idleSeconds', 9000);
  s2.setPolicy('maxBusySeconds', 7200);
  const l2 = [];
  const c2 = loadConfig(base);
  createPolicies({ cfg: c2, store: s2, log: (m) => l2.push(m) }).load();
  assert.deepEqual([c2.idleSeconds, c2.maxBusySeconds], [1800, 0]);
  assert.match(l2.at(-1), /conflict/);
});

// ---- through the admin routes, on a real gateway ----
async function world({ llm = 'ok', fixed } = {}) {
  const store = fixed?.store ?? new Store(':memory:');
  const cfg = loadConfig(base);
  const admin = fixed?.admin ?? store.createUser('admin@example.com', hashPassword(PW));
  if (!fixed) store.setAdmin('admin@example.com', true);
  const proxyState = { quota: 500_000, calls: [], fail: null };
  const proxySettings = () => [{ key: 'dailyTokenQuota', group: 'Model allowances', label: 'Daily tokens per user', description: 'd', unit: 'tokens', min: 1000, max: 10 ** 10, zero: 'unlimited', applies: 'Right away', default: 500_000, value: proxyState.quota, source: proxyState.quota === 500_000 ? 'default' : 'admin', updatedAt: null }];
  const fakeLlm = llm === null ? null : {
    usage: async () => ({}),
    activity: async () => ({ users: [] }),
    policy: async () => { if (llm === 'down') throw Object.assign(new Error('socket'), { status: undefined }); return { settings: proxySettings() }; },
    setPolicy: async (key, value, confirm) => {
      proxyState.calls.push(['set', key, value, confirm]);
      if (key !== 'dailyTokenQuota') throw Object.assign(new Error('404'), { status: 404, detail: { code: 'not_found', message: 'No such setting.' } });
      if (llm === 'down') throw new Error('socket');
      if (value === 0 && !confirm) throw Object.assign(new Error('400'), { status: 400, detail: { code: 'confirm_zero', message: '0 means unlimited: this turns the limit off. Confirm to continue.' } });
      if (typeof value !== 'number' || (value < 1000 && value !== 0)) throw Object.assign(new Error('400'), { status: 400, detail: { code: 'out_of_range', message: 'Use 0 (unlimited) or a value from 1000 to 10000000000.' } });
      const from = proxyState.quota;
      proxyState.quota = value;
      return { key, from, to: value };
    },
    resetPolicy: async (key) => { proxyState.calls.push(['reset', key]); if (key !== 'dailyTokenQuota') throw Object.assign(new Error('404'), { status: 404, detail: { code: 'not_found', message: 'No such setting.' } }); if (llm === 'down') throw new Error('socket'); const from = proxyState.quota; proxyState.quota = 500_000; return { key, from, to: 500_000 }; },
  };
  const state = { boxes: [{ userId: 5, running: true }], stopped: [] }; // not the admin's own id (1): the admin's requests would count as that user's activity
  const runner = {
    list: async () => state.boxes, info: async () => ({ running: true, startedAt: 't' }), diskUsage: async () => [],
    stop: async (id) => { state.stopped.push(id); state.boxes = state.boxes.map((b) => (b.userId === id ? { ...b, running: false } : b)); },
    activity: async () => ({ cpuNs: 0, memBytes: 1 }),
  };
  const manager = new SandboxManager({ runner, cfg, log: () => {}, llm: fakeLlm, audit: new Audit({ store, log: () => {} }) });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cookie = `gw_session=${store.createSession(admin, 86_400)}`; // long enough for a test that moves the clock
  const raw = (method, path, { headers = {}, body, auth = true } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const h = { ...(auth ? { cookie } : {}), ...(data && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers };
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: h }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(data);
    });
  const page = await raw('GET', '/gw/admin');
  const csrf = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(page.text)[1]).csrf;
  const get = (path) => raw('GET', path);
  const post = (path, body = {}) => raw('POST', path, { headers: { 'x-csrf-token': csrf, origin: 'https://localhost' }, body });
  const signup = (email, invite = '') => raw('POST', '/gw/signup', { auth: false, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost' }, body: new URLSearchParams({ email, password: PW, invite }).toString() });
  return { store, cfg, manager, state, proxyState, admin, get, post, signup, close: () => { server.closeAllConnections(); server.close(); } };
}

test('list: the gateway\'s settings and the proxy\'s together, with where each value comes from; a proxy that does not answer is said so', async () => {
  const w = await world();
  try {
    const out = (await w.get('/gw/admin/api/policies')).json();
    assert.equal(out.proxy.ok, true);
    assert.equal(out.settings.filter((s) => s.scope === 'gateway').length, POLICIES.length);
    const idle = out.settings.find((s) => s.key === 'idleSeconds');
    assert.deepEqual([idle.value, idle.default, idle.source, idle.unit], [1800, 1800, 'default', 'seconds']);
    assert.equal(out.settings.find((s) => s.key === 'dailyTokenQuota').scope, 'proxy');
    assert.deepEqual(out.recent, []);
  } finally { w.close(); }
  const down = await world({ llm: 'down' });
  try {
    const out = (await down.get('/gw/admin/api/policies')).json();
    assert.equal(out.proxy.ok, false);
    assert.match(out.proxy.error, /did not answer/);
    assert.equal(out.settings.length, POLICIES.length, 'the gateway\'s own settings still show');
  } finally { down.close(); }
  const off = await world({ llm: null });
  try {
    assert.equal((await off.get('/gw/admin/api/policies')).json().proxy.ok, null, 'no metering: no proxy section');
  } finally { off.close(); }
});

test('change: validated, stored, applied at once, audited with who and the old and new value; refusals change nothing', async () => {
  const w = await world();
  try {
    const r = await w.post('/gw/admin/api/policies/idleSeconds', { value: 600 });
    assert.equal(r.status, 200);
    const out = r.json();
    assert.deepEqual([out.key, out.from, out.to], ['idleSeconds', 1800, 600]);
    assert.deepEqual(out.settings.find((s) => s.key === 'idleSeconds').source, 'admin');
    assert.equal(w.cfg.idleSeconds, 600);
    const row = w.store.queryAudit({ event: 'admin.policy_set' })[0];
    assert.deepEqual([row.detail.key, row.detail.from, row.detail.to, row.detail.by, row.detail.scope], ['idleSeconds', 1800, 600, w.admin, 'gateway']);
    assert.equal(out.recent[0].event, 'admin.policy_set');
    // The two time settings must fit together: a busy cap, then an idle time above it, is refused.
    assert.equal((await w.post('/gw/admin/api/policies/maxBusySeconds', { value: 1200 })).status, 200);
    const clash = await w.post('/gw/admin/api/policies/idleSeconds', { value: 3600 });
    assert.deepEqual([clash.status, clash.json().error], [400, 'conflict']);
    assert.equal(w.cfg.idleSeconds, 600);
    await w.post('/gw/admin/api/policies/maxBusySeconds/reset');
    for (const [key, body, status, error] of [['idleSeconds', { value: 5 }, 400, 'out_of_range'], ['idleSeconds', { value: 'soon' }, 400, 'not_a_number'], ['maxRunSeconds', { value: 0 }, 400, 'confirm_zero'], ['allowSignup', { value: true }, 400, 'confirm_open'], ['nothing', { value: 1 }, 404, 'not_found'], ['idleSeconds', {}, 400, 'not_a_number']]) {
      const x = await w.post(`/gw/admin/api/policies/${key}`, body);
      assert.deepEqual([x.status, x.json().error], [status, error], `${key} ${JSON.stringify(body)}`);
      assert.ok(x.json().message.length > 10, 'a plain message');
    }
    assert.equal(w.cfg.idleSeconds, 600);
    assert.equal(w.store.policyOverrides().length, 1, 'only the valid changes that remain were stored');
    assert.equal(w.store.queryAudit({ event: 'admin.policy_set' }).length, 2, 'refusals are not audited as changes (the idle time and the busy cap that was then reset)');
    assert.equal((await w.post('/gw/admin/api/policies/not-a-key!', { value: 1 })).status, 404);
  } finally { w.close(); }
});

test('change: the new idle time is what the reaper uses on its next pass', async () => {
  const w = await world();
  try {
    w.manager.touch(5);
    const realNow = Date.now;
    Date.now = () => realNow() + 900_000; // fifteen minutes later: idle for 15 minutes
    try {
      await w.manager.reap();
      assert.deepEqual(w.state.stopped, [], 'not idle long enough for the default of 30 minutes');
      await w.post('/gw/admin/api/policies/idleSeconds', { value: 600 });
      await w.manager.reap();
      assert.deepEqual(w.state.stopped, [5], 'but past the new limit of 10 minutes, with no restart');
    } finally { Date.now = realNow; }
  } finally { w.close(); }
});

test('change: opening sign-up needs a yes, then takes effect on the very next sign-up; closing it again does too', async () => {
  const w = await world();
  try {
    assert.equal((await w.signup('first@example.com')).status, 400, 'invite only to begin with');
    assert.equal((await w.post('/gw/admin/api/policies/allowSignup', { value: true })).status, 400);
    assert.equal((await w.signup('second@example.com')).status, 400, 'still closed after the refusal');
    assert.equal((await w.post('/gw/admin/api/policies/allowSignup', { value: true, confirm: true })).status, 200);
    assert.equal((await w.signup('third@example.com')).status, 303, 'open now, no restart');
    assert.equal((await w.post('/gw/admin/api/policies/allowSignup', { value: false })).status, 200);
    assert.equal((await w.signup('fourth@example.com')).status, 400, 'closed again');
    assert.deepEqual(w.store.queryAudit({ event: 'admin.policy_set' }).map((r) => r.detail.to), [false, true]);
  } finally { w.close(); }
});

test('zero: turning a limit off needs the yes, and it applies', async () => {
  const w = await world({ llm: null });
  try {
    await w.post('/gw/admin/api/policies/maxRunSeconds', { value: 3600 });
    assert.equal(w.cfg.maxRunSeconds, 3600);
    assert.equal((await w.post('/gw/admin/api/policies/maxRunSeconds', { value: 0 })).status, 400);
    assert.equal(w.cfg.maxRunSeconds, 3600);
    assert.equal((await w.post('/gw/admin/api/policies/maxRunSeconds', { value: 0, confirm: true })).status, 200);
    assert.equal(w.cfg.maxRunSeconds, 0);
    assert.equal((await w.post('/gw/admin/api/policies/maxRunSeconds', { value: 0, confirm: 'yes' })).status, 400, 'only a real true counts as the yes');
  } finally { w.close(); }
});

test('reset: the environment value applies again; it is audited once, and a reset that changes nothing is not', async () => {
  const w = await world();
  try {
    await w.post('/gw/admin/api/policies/idleSeconds', { value: 600 });
    const r = await w.post('/gw/admin/api/policies/idleSeconds/reset');
    assert.equal(r.status, 200);
    assert.equal(w.cfg.idleSeconds, 1800);
    assert.equal(r.json().settings.find((s) => s.key === 'idleSeconds').source, 'default');
    assert.equal(w.store.policyOverrides().length, 0);
    assert.deepEqual(w.store.queryAudit({ event: 'admin.policy_reset' }).map((x) => [x.detail.from, x.detail.to]), [[600, 1800]]);
    await w.post('/gw/admin/api/policies/idleSeconds/reset');
    assert.equal(w.store.queryAudit({ event: 'admin.policy_reset' }).length, 1, 'nothing changed, so nothing to record');
    assert.equal((await w.post('/gw/admin/api/policies/nothing/reset')).status, 404);
  } finally { w.close(); }
});

test('proxy settings go through the proxy: its checks, its messages, and an audit row on the gateway side', async () => {
  const w = await world();
  try {
    const r = await w.post('/gw/admin/api/policies/dailyTokenQuota', { value: 250_000 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json().from, r.json().to], [500_000, 250_000]);
    assert.equal(r.json().settings.find((s) => s.key === 'dailyTokenQuota').value, 250_000);
    assert.deepEqual(w.proxyState.calls, [['set', 'dailyTokenQuota', 250_000, false]]);
    const row = w.store.queryAudit({ event: 'admin.policy_set' })[0];
    assert.deepEqual([row.detail.scope, row.detail.from, row.detail.to, row.detail.by], ['proxy', 500_000, 250_000, w.admin]);
    const refused = await w.post('/gw/admin/api/policies/dailyTokenQuota', { value: 5 });
    assert.equal(refused.status, 400);
    assert.match(refused.json().message, /from 1000 to/, 'the proxy\'s own explanation reaches the page');
    const zero = await w.post('/gw/admin/api/policies/dailyTokenQuota', { value: 0 });
    assert.equal(zero.json().error, 'confirm_zero');
    assert.equal((await w.post('/gw/admin/api/policies/dailyTokenQuota', { value: 0, confirm: true })).status, 200, 'the yes is passed on');
    assert.equal(w.proxyState.calls.at(-1)[3], true);
    const reset = await w.post('/gw/admin/api/policies/dailyTokenQuota/reset');
    assert.equal(reset.status, 200);
    assert.equal(w.proxyState.quota, 500_000);
    assert.equal(w.store.queryAudit({ event: 'admin.policy_reset' })[0].detail.scope, 'proxy');
    assert.equal(w.store.queryAudit({ event: 'admin.policy_set' }).length, 2, 'only the two changes that happened');
  } finally { w.close(); }
});

test('proxy settings: an unreachable proxy gives a 502 with a plain message, changes nothing and records nothing; without metering it is not found', async () => {
  const w = await world({ llm: 'down' });
  try {
    const r = await w.post('/gw/admin/api/policies/dailyTokenQuota', { value: 250_000 });
    assert.equal(r.status, 502);
    assert.match(r.json().message, /Nothing was changed/);
    assert.equal((await w.post('/gw/admin/api/policies/dailyTokenQuota/reset')).status, 502);
    assert.equal(w.store.queryAudit({ event: 'admin.policy' }).length, 0);
  } finally { w.close(); }
  const off = await world({ llm: null });
  try {
    assert.equal((await off.post('/gw/admin/api/policies/dailyTokenQuota', { value: 250_000 })).status, 404);
  } finally { off.close(); }
});

test('an override outlives a restart of the gateway: a new gateway over the same database starts with it', async () => {
  const w = await world();
  try {
    await w.post('/gw/admin/api/policies/idleSeconds', { value: 600 });
    await w.post('/gw/admin/api/policies/allowSignup', { value: true, confirm: true });
    const again = await world({ fixed: { store: w.store, admin: w.admin } });
    try {
      assert.deepEqual([again.cfg.idleSeconds, again.cfg.allowSignup], [600, true]);
      const out = (await again.get('/gw/admin/api/policies')).json();
      assert.equal(out.settings.find((s) => s.key === 'idleSeconds').source, 'admin');
      assert.equal(out.settings.find((s) => s.key === 'idleSeconds').default, 1800, 'and it still knows the default to go back to');
      assert.ok(out.recent.length >= 2);
    } finally { again.close(); }
  } finally { w.close(); }
});
