// egress-proxy: the operator's scope list and the per-sandbox limits (docs/plan-first-security-test.md, step 3). No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { loadConfig } from '../../egress-proxy/src/config.js';
import { Limits } from '../../egress-proxy/src/limits.js';
import { DEFAULT_BASE_HOSTS, createScope, parseHostList } from '../../egress-proxy/src/scope.js';
import { createEgressProxy } from '../../egress-proxy/src/server.js';

// ---- the host list ----
test('host list: names, wildcards and IPv4 addresses parse (case and spaces ignored); everything else is refused naming the setting and the entry', () => {
  assert.deepEqual(parseHostList(' Example.COM, *.Staging.Example.com ,203.0.113.7,, '), [
    { kind: 'exact', value: 'example.com' }, { kind: 'suffix', value: 'staging.example.com' }, { kind: 'ip', value: '203.0.113.7' },
  ]);
  assert.deepEqual(parseHostList(''), []);
  assert.deepEqual(parseHostList(undefined), []);
  for (const bad of ['*', '*.com', '*.', 'exa*mple.com', 'localhost', 'a_b.example.com', 'exa mple.com', 'example..com', '-a.example.com', 'a.example.com-', 'http://example.com', 'example.com/path', 'example.com:443', '[::1]', '::1', `${'a'.repeat(64)}.example.com`, `${'a.'.repeat(130)}com`]) {
    assert.throws(() => parseHostList(`ok.example.com,${bad}`, 'EGRESS_ALLOW_HOSTS'), /EGRESS_ALLOW_HOSTS: ".*" is not usable/, bad);
  }
});

test('the base list holds only valid entries, and no wildcard that would open a whole provider', () => {
  const entries = parseHostList(DEFAULT_BASE_HOSTS.join(','));
  assert.equal(entries.length, DEFAULT_BASE_HOSTS.length);
  assert.ok(entries.every((e) => e.kind === 'exact'), 'exact hosts only');
  assert.ok(DEFAULT_BASE_HOSTS.includes('github.com') && DEFAULT_BASE_HOSTS.includes('pypi.org') && DEFAULT_BASE_HOSTS.includes('api.osv.dev'));
});

// ---- scope matching ----
const scope = createScope({ allow: parseHostList('staging.example.org,*.app.example.net,198.51.100.9'), base: parseHostList('github.com,*.base.example') });

test('scope: with no operator list it is off and allows anything', () => {
  const open = createScope({ allow: [], base: parseHostList('github.com') });
  assert.equal(open.active, false);
  for (const h of ['anything.example', '127.0.0.1', '[::1]', '']) assert.equal(open.check(h).ok, true, h);
  assert.equal(scope.active, true);
});

test('scope: listed hosts, wildcard subdomains, listed addresses and the base list are in; case and a trailing dot do not matter', () => {
  for (const h of ['staging.example.org', 'STAGING.Example.Org', 'staging.example.org.', 'a.app.example.net', 'x.y.app.example.net', '198.51.100.9', 'github.com', 'x.base.example']) assert.equal(scope.check(h).ok, true, h);
});

test('scope: look-alikes, the apex of a wildcard, other addresses, odd characters and anything else are out, with the reason named', () => {
  for (const h of [
    'example.org', 'evil-staging.example.org', 'staging.example.org.evil.test', 'staging-example.org', 'xstaging.example.org', 'staging.example.org.evil',
    'app.example.net', 'xapp.example.net', 'app.example.net.evil.test', 'a..app.example.net', '.app.example.net',
    '198.51.100.10', '198.51.100.9.evil.test', '127.0.0.1', '[::1]', '::1', 'github.com.evil.test', 'notgithub.com', 'gist.github.com',
    'sta\u0000ging.example.org', 'staging.example.org\u0000.evil', 'staging.example.org/x', 'staging.example.org:443', 'stag ing.example.org', '', null, undefined,
  ]) {
    const r = scope.check(h);
    assert.equal(r.ok, false, JSON.stringify(h));
    assert.match(r.reason, /^not in scope: .* is not on the allowed list$/);
  }
  assert.equal(scope.check('example.org').reason, 'not in scope: example.org is not on the allowed list');
});

// ---- limits, with a fake clock ----
function fake() {
  const t = { now: 1_000_000, waits: [] };
  return { t, now: () => t.now, sleep: async (ms) => { t.waits.push(ms); t.now += ms; } };
}

test('limits: no limits set admits everything at once', async () => {
  const f = fake();
  const l = new Limits({ now: f.now, sleep: f.sleep });
  for (let i = 0; i < 500; i++) assert.equal((await l.admit('s1', 'a.example')).ok, true);
  assert.deepEqual(f.t.waits, []);
});

test('rate: a burst of twice the rate goes straight through, then connections are spaced to the rate; nobody is refused while the wait is short', async () => {
  const f = fake();
  const l = new Limits({ perDestRate: 10, maxWaitMs: 5000, now: f.now, sleep: f.sleep });
  for (let i = 0; i < 25; i++) assert.equal((await l.admit('s1', 'a.example')).ok, true);
  assert.deepEqual(f.t.waits, [100, 100, 100, 100, 100], 'the burst of 20 did not wait; the last five did, one every 100 ms, which is 10 a second');
});

test('rate: a request that would wait longer than the cap is refused with a Retry-After, and the queue does not grow from refusals', async () => {
  const f = fake();
  f.sleep = async () => {}; // requests queue without time passing: all arrive at once
  const l = new Limits({ perDestRate: 10, maxWaitMs: 250, now: f.now, sleep: f.sleep });
  const results = await Promise.all(Array.from({ length: 40 }, () => l.admit('s1', 'a.example')));
  assert.equal(results.filter((r) => r.ok).length, 22, '20 in the burst and two queued within 250 ms');
  const refused = results.filter((r) => !r.ok);
  assert.equal(refused.length, 18);
  assert.match(refused[0].reason, /rate limit: too many new connections to a\.example/);
  assert.ok(refused.every((r) => r.retryAfter >= 1));
  // Refusals gave their token back, so once time passes the next request is served.
  f.t.now += 1000;
  assert.equal((await l.admit('s1', 'a.example')).ok, true);
});

test('rate: sources and destinations are counted separately; the per-source rate covers all destinations', async () => {
  const f = fake();
  const l = new Limits({ perDestRate: 1, perSourceRate: 3, maxWaitMs: 0, now: f.now, sleep: f.sleep }); // bursts of 2 and 6
  assert.equal((await l.admit('s1', 'a.example')).ok, true);
  assert.equal((await l.admit('s1', 'a.example')).ok, true);
  assert.equal((await l.admit('s1', 'a.example')).ok, false, 'a third to the same destination is over its rate');
  assert.equal((await l.admit('s1', 'b.example')).ok, true, 'another destination has its own');
  assert.equal((await l.admit('s2', 'a.example')).ok, true, 'another sandbox has its own');
  assert.equal((await l.admit('s2', 'a.example')).ok, true);
  assert.equal((await l.admit('S1', 'A.EXAMPLE')).ok, true, 'a source is exact, a destination is case-insensitive');
  assert.equal((await l.admit('s1', 'c.example')).ok, true);
  assert.equal((await l.admit('s1', 'd.example')).ok, true);
  assert.equal((await l.admit('s1', 'e.example')).ok, false, 'six in a burst from one sandbox is the per-source limit');
});

test('concurrency: over the limit a request waits for a slot, gets it the moment one is released, and is refused if none frees in time', async () => {
  const l = new Limits({ perDestConcurrent: 2, maxWaitMs: 80 });
  const a = await l.admit('s1', 'a.example');
  const b = await l.admit('s1', 'a.example');
  assert.deepEqual([a.ok, b.ok], [true, true]);
  const started = Date.now();
  const c = await l.admit('s1', 'a.example');
  assert.equal(c.ok, false);
  assert.match(c.reason, /too many connections open to a\.example/);
  assert.ok(Date.now() - started >= 60, 'it did wait');
  // a waiter is handed a freed slot at once
  const pending = l.admit('s1', 'a.example');
  setTimeout(() => a.release(), 20);
  const d = await pending;
  assert.equal(d.ok, true);
  assert.ok(Date.now() - started < 400);
  // releasing twice frees one slot, not two
  b.release();
  b.release();
  const e1 = await l.admit('s1', 'a.example');
  assert.equal(e1.ok, true, 'one slot is free');
  assert.equal((await l.admit('s1', 'a.example')).ok, false, 'and only one');
  e1.release();
  d.release();
});

test('concurrency: the per-source cap spans destinations, and a request refused for its rate does not keep its slot', async () => {
  const l = new Limits({ perSourceConcurrent: 3, perDestRate: 1, maxWaitMs: 0 });
  const held = [await l.admit('s1', 'a.example'), await l.admit('s1', 'b.example'), await l.admit('s1', 'c.example')];
  assert.equal(held.every((h) => h.ok), true);
  assert.equal((await l.admit('s1', 'd.example')).ok, false, 'three open from one sandbox is the cap');
  held.forEach((h) => h.release());
  // refused for rate again and again: no slot may leak
  for (let i = 0; i < 20; i++) (await l.admit('s1', 'a.example')).release?.(); // the few that get through are released at once
  const after = [await l.admit('s1', 'x.example'), await l.admit('s1', 'y.example'), await l.admit('s1', 'z.example')];
  assert.equal(after.every((h) => h.ok), true, 'all three slots are still available');
});

// ---- the proxy, with a local "internet" ----
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
async function start(env = {}, extra = {}) {
  const logs = [];
  const seen = [];
  const target = http.createServer((req, res) => { seen.push(req.headers.host); res.end('target'); });
  const targetPort = await listen(target);
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  const echoPort = await listen(echo);
  const cfg = loadConfig({ ALLOWED_PORTS: `${targetPort},${echoPort}`, RATE_PER_SOURCE: '0', RATE_PER_DESTINATION: '0', MAX_CONNECTIONS_PER_SOURCE: '0', MAX_CONNECTIONS_PER_DESTINATION: '0', ...env });
  const proxy = createEgressProxy({ cfg, log: (l) => logs.push(l), blocked: () => false, lookup: async () => [{ address: '127.0.0.1' }], ...extra });
  const proxyPort = await listen(proxy);
  return { logs, seen, targetPort, echoPort, proxyPort, stop: () => { for (const s of tunnels) s.destroy(); tunnels.clear(); return Promise.all([close(proxy), close(target), close(echo)]); } };
}
const viaProxy = (proxyPort, url) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
const tunnels = new Set(); // every CONNECT socket a test opened, so a failed assertion cannot leave one holding the proxy open
const connect = (proxyPort, hostport) =>
  new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${hostport} HTTP/1.1\r\nHost: ${hostport}\r\n\r\n`));
    tunnels.add(s);
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) resolve({ socket: s, head: buf }); });
    s.on('error', reject);
    s.on('close', () => resolve({ socket: s, head: buf }));
  });

test('scoped proxy: listed and base hosts pass; anything else is refused before any dial, with the reason in the status text, a header, the body and the log', async () => {
  const t = await start({ EGRESS_ALLOW_HOSTS: 'files.test,*.staging.test', EGRESS_BASE_HOSTS: 'github.com' });
  try {
    for (const host of ['files.test', 'deep.staging.test', 'github.com']) {
      const r = await viaProxy(t.proxyPort, `http://${host}:${t.targetPort}/`);
      assert.equal(r.status, 200, host);
      const c = await connect(t.proxyPort, `${host}:${t.echoPort}`);
      assert.match(c.head, /^HTTP\/1\.1 200/, host);
      c.socket.destroy();
    }
    const before = t.seen.length;
    for (const host of ['other.test', 'files.test.evil.test', 'staging.test', 'evilfiles.test', '127.0.0.1']) {
      const r = await viaProxy(t.proxyPort, `http://${host}:${t.targetPort}/`);
      assert.equal(r.status, 403, host);
      assert.match(r.headers['x-egress-reason'], /^not in scope: .* is not on the allowed list$/);
      assert.match(r.body, /not in scope/);
      const c = await connect(t.proxyPort, `${host}:${t.echoPort}`);
      assert.match(c.head, /^HTTP\/1\.1 403 Forbidden\r\nX-Egress-Reason: not in scope: /);
      assert.match(c.head, /\r\n\r\nnot in scope: .* is not on the allowed list\n$/, 'the tool shows why');
      c.socket.destroy();
    }
    assert.equal(t.seen.length, before, 'no refused request reached the target');
    assert.ok(t.logs.some((l) => l.includes('egress deny') && l.includes('other.test') && l.includes('not in scope: other.test is not on the allowed list')));
    assert.ok(!t.logs.some((l) => l.startsWith('egress allow') && /other\.test|evil/.test(l)));
  } finally { await t.stop(); }
});

test('scoped proxy: an allowed name that resolves to a private address is still refused by the address filter', async () => {
  const t = await start({ EGRESS_ALLOW_HOSTS: 'files.test' }, { blocked: (ip) => ip === '10.0.0.5', lookup: async () => [{ address: '10.0.0.5' }] });
  try {
    const r = await viaProxy(t.proxyPort, `http://files.test:${t.targetPort}/`);
    assert.equal(r.status, 403);
    assert.match(r.body, /non-public/, 'refused for its address, not its name');
  } finally { await t.stop(); }
});

test('open proxy (no operator list): any public host passes as before', async () => {
  const t = await start({});
  try {
    for (const host of ['anything.test', 'another.example']) assert.equal((await viaProxy(t.proxyPort, `http://${host}:${t.targetPort}/`)).status, 200);
  } finally { await t.stop(); }
});

test('concurrency cap through the proxy: the second tunnel to a destination gets 429 with Retry-After and the reason, and works once the first closes', async () => {
  const t = await start({ MAX_CONNECTIONS_PER_DESTINATION: '1', LIMIT_WAIT_SECONDS: '0' });
  try {
    const first = await connect(t.proxyPort, `files.test:${t.echoPort}`);
    assert.match(first.head, /^HTTP\/1\.1 200/);
    const second = await connect(t.proxyPort, `files.test:${t.echoPort}`);
    assert.match(second.head, /^HTTP\/1\.1 429 Too Many Requests\r\nX-Egress-Reason: too many connections open to files\.test\r\nRetry-After: 1\r\n/);
    assert.ok(t.logs.some((l) => /egress deny .* files\.test:\d+ \(too many connections open to files\.test\)/.test(l)));
    const other = await connect(t.proxyPort, `other.test:${t.echoPort}`);
    assert.match(other.head, /^HTTP\/1\.1 200/, 'another destination is not affected');
    other.socket.destroy();
    first.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const third = await connect(t.proxyPort, `files.test:${t.echoPort}`);
    assert.match(third.head, /^HTTP\/1\.1 200/, 'the slot was freed when the first tunnel closed');
    third.socket.destroy();
  } finally { await t.stop(); }
});

test('rate limit through the proxy on plain HTTP: requests beyond the rate and the wait cap get 429, the rest are served', async () => {
  const t = await start({ RATE_PER_DESTINATION: '2', LIMIT_WAIT_SECONDS: '1' }); // burst of 4, then 2 a second; the cap is 1 s
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, () => viaProxy(t.proxyPort, `http://files.test:${t.targetPort}/`)));
    const ok = rs.filter((r) => r.status === 200).length;
    const limited = rs.filter((r) => r.status === 429);
    assert.ok(ok >= 5 && ok <= 7, `4 in the burst and about 2 queued within the cap: ${ok}`);
    assert.ok(limited.length >= 5);
    assert.match(limited[0].headers['x-egress-reason'], /rate limit: too many new connections to files\.test/);
    assert.ok(Number(limited[0].headers['retry-after']) >= 1);
  } finally { await t.stop(); }
});

test('refused and limited requests do not leak the proxy\'s own connection budget', async () => {
  const t = await start({ EGRESS_ALLOW_HOSTS: 'files.test', MAX_CONNECTIONS: '3', MAX_CONNECTIONS_PER_DESTINATION: '1', LIMIT_WAIT_SECONDS: '0' });
  try {
    const held = await connect(t.proxyPort, `files.test:${t.echoPort}`);
    for (let i = 0; i < 20; i++) {
      assert.match((await connect(t.proxyPort, `other.test:${t.echoPort}`)).head, /^HTTP\/1\.1 403/);
      assert.match((await connect(t.proxyPort, `files.test:${t.echoPort}`)).head, /^HTTP\/1\.1 429/);
    }
    held.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const again = await connect(t.proxyPort, `files.test:${t.echoPort}`);
    assert.match(again.head, /^HTTP\/1\.1 200/, 'still room after forty refusals with a budget of three');
    again.socket.destroy();
  } finally { await t.stop(); }
});

test('a client that resets its connection after a refusal, or while queued, does not crash the proxy or leak its budget', async () => {
  // Regression: a refused CONNECT whose client then reset the connection emitted an unhandled socket error and took the whole proxy down.
  const t = await start({ EGRESS_ALLOW_HOSTS: 'files.test', MAX_CONNECTIONS: '4', MAX_CONNECTIONS_PER_DESTINATION: '1', LIMIT_WAIT_SECONDS: '1' });
  try {
    for (let i = 0; i < 10; i++) {
      // refused for scope, then reset at once
      const refused = net.connect(t.proxyPort, '127.0.0.1');
      await new Promise((r) => refused.on('connect', r));
      refused.write('CONNECT other.test:443 HTTP/1.1\r\nHost: other.test:443\r\n\r\n');
      await new Promise((r) => refused.once('data', r));
      refused.resetAndDestroy();
      // reset before the proxy has even answered
      const eager = net.connect(t.proxyPort, '127.0.0.1');
      await new Promise((r) => eager.on('connect', r));
      eager.write(`CONNECT other.test:${t.echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
      eager.resetAndDestroy();
    }
    await new Promise((r) => setTimeout(r, 100));
    const held = await connect(t.proxyPort, `files.test:${t.echoPort}`);
    assert.match(held.head, /^HTTP\/1\.1 200/, 'the proxy is still up');
    // a client that gives up while queued for the held slot does not take the slot when it is freed
    const queued = net.connect(t.proxyPort, '127.0.0.1');
    await new Promise((r) => queued.on('connect', r));
    queued.write(`CONNECT files.test:${t.echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 100));
    queued.resetAndDestroy();
    held.socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
    const next = await connect(t.proxyPort, `files.test:${t.echoPort}`);
    assert.match(next.head, /^HTTP\/1\.1 200/, 'the slot and the connection budget are free');
    next.socket.destroy();
    assert.equal(t.logs.filter((l) => /egress allow/.test(l)).length >= 2, true);
  } finally { await t.stop(); }
});

// ---- configuration ----
test('config: scope off by default; the operator list turns it on; the base list defaults, can be replaced or dropped; bad entries name the setting', () => {
  assert.equal(loadConfig({}).scope.active, false);
  assert.equal(loadConfig({ EGRESS_ALLOW_HOSTS: '' }).scope.active, false, 'empty (as compose passes it) means off');
  const c = loadConfig({ EGRESS_ALLOW_HOSTS: 'staging.example.org' });
  assert.equal(c.scope.active, true);
  assert.equal(c.scope.check('github.com').ok, true, 'the default base list');
  assert.equal(c.scope.check('example.com').ok, false);
  assert.equal(loadConfig({ EGRESS_ALLOW_HOSTS: 'a.example', EGRESS_BASE_HOSTS: 'none' }).scope.check('github.com').ok, false, 'the base list can be dropped');
  const custom = loadConfig({ EGRESS_ALLOW_HOSTS: 'a.example', EGRESS_BASE_HOSTS: 'mirror.example' });
  assert.deepEqual([custom.scope.check('mirror.example').ok, custom.scope.check('github.com').ok], [true, false]);
  assert.throws(() => loadConfig({ EGRESS_ALLOW_HOSTS: '*.com' }), /EGRESS_ALLOW_HOSTS: "\*\.com" is not usable/);
  assert.throws(() => loadConfig({ EGRESS_ALLOW_HOSTS: 'ok.example', EGRESS_BASE_HOSTS: 'x y' }), /EGRESS_BASE_HOSTS/);
});

test('config: the limits default to conservative values, 0 turns one off, and nonsense is refused', () => {
  assert.deepEqual(loadConfig({}).limits, { perSourceRate: 100, perDestRate: 20, perSourceConcurrent: 64, perDestConcurrent: 16, maxWaitMs: 5000 });
  const c = loadConfig({ RATE_PER_DESTINATION: '5', RATE_PER_SOURCE: '0', MAX_CONNECTIONS_PER_SOURCE: '10', MAX_CONNECTIONS_PER_DESTINATION: '2', LIMIT_WAIT_SECONDS: '3' });
  assert.deepEqual(c.limits, { perSourceRate: 0, perDestRate: 5, perSourceConcurrent: 10, perDestConcurrent: 2, maxWaitMs: 3000 });
  for (const key of ['RATE_PER_DESTINATION', 'RATE_PER_SOURCE', 'MAX_CONNECTIONS_PER_SOURCE', 'MAX_CONNECTIONS_PER_DESTINATION', 'LIMIT_WAIT_SECONDS', 'MAX_CONNECTIONS']) {
    for (const bad of ['-1', '1.5', 'many']) assert.throws(() => loadConfig({ [key]: bad }), new RegExp(key), `${key}=${bad}`);
  }
});
