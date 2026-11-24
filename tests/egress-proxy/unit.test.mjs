// egress-proxy: address filter, DNS-rebinding defence, CONNECT and plain HTTP forwarding, port and scheme limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { isBlockedAddress, resolvePublic } from '../../egress-proxy/src/filter.js';
import { loadConfig } from '../../egress-proxy/src/config.js';
import { createEgressProxy } from '../../egress-proxy/src/server.js';

test('filter: private, loopback, link-local, metadata and reserved IPv4 are blocked; public is not', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.254', '172.19.255.254', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255'])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.255.255', '172.32.0.1', '93.184.216.34', '100.63.255.255', '169.253.0.1'])
    assert.equal(isBlockedAddress(ip), false, ip);
});

test('filter: IPv6 loopback, ULA, link-local, mapped/embedded private IPv4 and NAT64 are blocked', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::808:808', '2001:db8::1', '2002:7f00:1::1'])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])
    assert.equal(isBlockedAddress(ip), false, ip);
});

test('filter: unparseable input is blocked, not allowed', () => {
  for (const x of ['', 'not-an-ip', '1.2.3', '::g', '1.2.3.4.5']) assert.equal(isBlockedAddress(x), true, x);
});

test('resolvePublic: refuses a name if ANY answer is private (mixed records), returns the checked address otherwise', async () => {
  const lookup = async (h) => (h === 'mixed.test' ? [{ address: '8.8.8.8' }, { address: '10.0.0.5' }] : [{ address: '93.184.216.34' }, { address: '8.8.4.4' }]);
  await assert.rejects(resolvePublic('mixed.test', { lookup }), { code: 'blocked' });
  assert.equal(await resolvePublic('ok.test', { lookup }), '93.184.216.34');
  await assert.rejects(resolvePublic('127.0.0.1'), { code: 'blocked' });
  await assert.rejects(resolvePublic('[::1]'), { code: 'blocked' });
  await assert.rejects(resolvePublic('169.254.169.254'), { code: 'blocked' });
  assert.equal(await resolvePublic('1.1.1.1'), '1.1.1.1');
  await assert.rejects(resolvePublic('nope.test', { lookup: async () => { throw new Error('ENOTFOUND'); } }), { code: 'unresolved' });
});

test('config: ports default to 80 and 443 and must not be empty', () => {
  assert.deepEqual([...loadConfig({}).allowedPorts], [80, 443]);
  assert.deepEqual([...loadConfig({ ALLOWED_PORTS: '80, 8443' }).allowedPorts], [80, 8443]);
  assert.throws(() => loadConfig({ ALLOWED_PORTS: 'x' }), /ALLOWED_PORTS/);
});

// ---- proxy behaviour, with a local "internet" ----
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });

async function start(extra = {}) {
  const logs = [];
  const target = http.createServer((req, res) => {
    res.setHeader('x-seen-host', req.headers.host ?? '');
    res.setHeader('x-seen-proxy-header', String(req.headers['proxy-authorization'] ?? ''));
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => res.end(`target:${req.method}:${req.url}:${body}`));
  });
  const targetPort = await listen(target);
  const echo = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
  const echoPort = await listen(echo);
  const cfg = { ...loadConfig({ ALLOWED_PORTS: `${targetPort},${echoPort},80` }), ...extra.cfg };
  // The "public" internet is loopback here, so tests that need to reach it switch the filter off.
  const proxy = createEgressProxy({ cfg, log: (l) => logs.push(l), blocked: extra.blocked ?? (() => false), lookup: extra.lookup ?? (async () => [{ address: '127.0.0.1' }]) });
  const proxyPort = await listen(proxy);
  return { logs, targetPort, echoPort, proxyPort, stop: () => Promise.all([close(proxy), close(target), close(echo)]) };
}

const viaProxy = (proxyPort, url, { method = 'GET', body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });

const connect = (proxyPort, hostport) =>
  new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${hostport} HTTP/1.1\r\nHost: ${hostport}\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n')) resolve({ socket: s, head: buf });
    });
    s.on('error', reject);
    s.on('close', () => resolve({ socket: s, head: buf }));
  });

test('plain http: forwarded, body and method preserved, proxy headers stripped, request logged as allow', async () => {
  const t = await start();
  try {
    const r = await viaProxy(t.proxyPort, `http://files.test:${t.targetPort}/a/b?x=1`, { method: 'POST', body: 'hello', headers: { 'proxy-authorization': 'secret' } });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'target:POST:/a/b?x=1:hello');
    assert.equal(r.headers['x-seen-host'], `files.test:${t.targetPort}`);
    assert.equal(r.headers['x-seen-proxy-header'], '');
    assert.ok(t.logs.some((l) => /egress allow .*POST files\.test:\d+/.test(l)));
  } finally { await t.stop(); }
});

test('plain http to a private or metadata destination is refused with 403 and never dialled', async () => {
  const t = await start({ blocked: isBlockedAddress, lookup: async (h) => [{ address: h === 'metadata.test' ? '169.254.169.254' : '127.0.0.1' }] });
  try {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.test/', `http://localhost:${t.targetPort}/`, 'http://10.0.0.1/']) {
      const r = await viaProxy(t.proxyPort, url);
      assert.equal(r.status, 403, url);
    }
    assert.ok(t.logs.filter((l) => l.startsWith('egress deny')).length >= 4);
    assert.ok(!t.logs.some((l) => l.startsWith('egress allow')));
  } finally { await t.stop(); }
});

test('default filter on a real lookup: loopback and the metadata address are refused', async () => {
  const logs = [];
  const proxy = createEgressProxy({ cfg: loadConfig({}), log: (l) => logs.push(l) });
  const port = await listen(proxy);
  try {
    assert.equal((await viaProxy(port, 'http://127.0.0.1:80/')).status, 403);
    assert.equal((await viaProxy(port, 'http://169.254.169.254/')).status, 403);
    assert.equal((await viaProxy(port, 'http://[::1]/')).status, 403);
    const c = await connect(port, '127.0.0.1:443');
    assert.match(c.head, /^HTTP\/1\.1 403/);
    c.socket.destroy();
  } finally { await close(proxy); }
});

test('only the allowed ports, only http: and CONNECT; non-proxy requests are rejected', async () => {
  const t = await start();
  try {
    assert.equal((await viaProxy(t.proxyPort, 'http://files.test:22/')).status, 403);
    assert.equal((await viaProxy(t.proxyPort, 'ftp://files.test/x')).status, 400);
    assert.equal((await viaProxy(t.proxyPort, 'http://files.test:8081/')).status, 403);
    const direct = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: t.proxyPort, path: '/not-absolute' }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(direct, 400);
    const bad = await connect(t.proxyPort, 'files.test:22');
    assert.match(bad.head, /^HTTP\/1\.1 403/);
    bad.socket.destroy();
  } finally { await t.stop(); }
});

test('CONNECT: tunnel is opened to the vetted address and carries bytes both ways', async () => {
  const t = await start();
  try {
    const { socket, head } = await connect(t.proxyPort, `tunnel.test:${t.echoPort}`);
    assert.match(head, /^HTTP\/1\.1 200 Connection Established/);
    const reply = await new Promise((r) => { socket.once('data', (d) => r(String(d))); socket.write('ping'); });
    assert.equal(reply, 'echo:ping');
    socket.destroy();
    assert.ok(t.logs.some((l) => /egress allow .*CONNECT tunnel\.test:\d+/.test(l)));
  } finally { await t.stop(); }
});

test('CONNECT to a name that resolves to a private address is refused; unresolvable names give 502', async () => {
  const t = await start({ blocked: (ip) => ip === '127.0.0.1', lookup: async (h) => { if (h === 'gone.test') throw new Error('ENOTFOUND'); return [{ address: '127.0.0.1' }]; } });
  try {
    const priv = await connect(t.proxyPort, `internal.test:${t.echoPort}`);
    assert.match(priv.head, /^HTTP\/1\.1 403/);
    const gone = await connect(t.proxyPort, `gone.test:${t.echoPort}`);
    assert.match(gone.head, /^HTTP\/1\.1 502/);
    const malformed = await connect(t.proxyPort, 'no-port');
    assert.match(malformed.head, /^HTTP\/1\.1 400/);
  } finally { await t.stop(); }
});

test('DNS rebinding: the connection goes to the address that was checked, not to a second lookup', async () => {
  let calls = 0;
  const t = await start({ blocked: () => false, lookup: async () => { calls++; return [{ address: calls === 1 ? '127.0.0.1' : '10.0.0.9' }]; } });
  try {
    const r = await viaProxy(t.proxyPort, `http://rebind.test:${t.targetPort}/`);
    assert.equal(r.status, 200);
    assert.equal(calls, 1, 'resolved exactly once');
  } finally { await t.stop(); }
});

test('connection cap: beyond MAX_CONNECTIONS new tunnels are refused with 503', async () => {
  const t = await start({ cfg: { maxConnections: 1 } });
  try {
    const first = await connect(t.proxyPort, `a.test:${t.echoPort}`);
    assert.match(first.head, /^HTTP\/1\.1 200/);
    const second = await connect(t.proxyPort, `b.test:${t.echoPort}`);
    assert.match(second.head, /^HTTP\/1\.1 503/);
    first.socket.destroy();
  } finally { await t.stop(); }
});

test('healthz answers without being a proxy request', async () => {
  const t = await start();
  try {
    const status = await new Promise((r) => http.get({ host: '127.0.0.1', port: t.proxyPort, path: '/healthz' }, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(status, 200);
  } finally { await t.stop(); }
});
