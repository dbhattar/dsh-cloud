// SEC-02 (docs/security-review.md): a web server decides what it answers, and the proxy must survive any answer. Reproduced on
// 2026-11-28 before the fix: a server replying `HTTP/1.1 099 nope` made the proxy exit with ERR_HTTP_INVALID_STATUS_CODE, for every
// sandbox. The address filter is switched off here because the "public internet" is loopback, as in the other proxy tests. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { loadConfig } from '../../egress-proxy/src/config.js';
import { createEgressProxy } from '../../egress-proxy/src/server.js';

const closers = [];
after(() => closers.forEach((c) => c()));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => { closers.push(() => { srv.closeAllConnections?.(); srv.close(); }); r(srv.address().port); }));

async function setup(reply) {
  const evil = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.end(reply)); });
  const evilPort = await listen(evil);
  const logs = [];
  const proxy = createEgressProxy({ cfg: loadConfig({ ALLOWED_PORTS: `${evilPort},80` }), log: (l) => logs.push(l), blocked: () => false, lookup: async () => [{ address: '127.0.0.1' }] });
  const proxyPort = await listen(proxy);
  const get = () => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://evil.test:${evilPort}/`, headers: { host: `evil.test:${evilPort}` } }, (r) => { r.resume(); resolve(r.statusCode); });
    req.on('error', (e) => resolve(`client error ${e.code}`));
    req.end();
  });
  return { get, logs, proxyPort };
}

test('an upstream status code outside 100 to 999 is a 502 for the caller, and the proxy keeps serving', async () => {
  for (const status of ['099 nope', '000 zero']) {
    const { get, logs, proxyPort } = await setup(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\n\r\n`);
    assert.equal(await get(), 502, status);
    assert.ok(logs.some((l) => /invalid upstream response/.test(l)), 'the refusal is logged');
    // still serving: the health check answers and a second bad answer is handled the same way
    const health = await new Promise((r) => http.get({ host: '127.0.0.1', port: proxyPort, path: '/healthz' }, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(health, 200);
    assert.equal(await get(), 502);
  }
});

test('a normal upstream answer is still relayed', async () => {
  const { get } = await setup('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
  assert.equal(await get(), 200);
});
