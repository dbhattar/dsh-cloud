// SEC-01 and SEC-03 (docs/security-review.md): one bad request from one client must not end the gateway. Each test sends the input that
// used to end the process; an unhandled error in this process would fail the whole file. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));

async function gateway(manager = {}) {
  const store = new Store(':memory:');
  const m = { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: async () => ({}), status: () => ({}), wsOpen() {}, wsClose() {}, invalidate() {}, ...manager };
  const server = createGateway({ cfg: loadConfig(base), store, manager: m, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { server, store, port: server.address().port };
}

/** Send raw bytes, return the status line of the answer (or what happened to the connection). */
const raw = (port, bytes, { wait = 600 } = {}) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(bytes));
  let out = '';
  s.on('data', (d) => (out += d));
  s.on('close', () => resolve(out.split('\r\n')[0] || 'closed'));
  s.on('error', () => resolve('error'));
  setTimeout(() => { s.destroy(); resolve(out.split('\r\n')[0] || 'no answer'); }, wait);
});

test('a request target that is not a valid URL is a 400, and the gateway keeps serving', async () => {
  const { port } = await gateway();
  for (const target of ['//[', '//a:99999', 'http://[', '//%']) {
    assert.match(await raw(port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 400 /, target);
  }
  assert.match(await raw(port, 'GET /gw/healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200 /, 'still answering');
});

test('a client that resets an upgrade while the sandbox is still starting does not end the gateway', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { port, store } = await gateway({ ensure: () => gate.then(() => ({ host: '127.0.0.1', port: 9, cookie: 'k=v' })) });
  const uid = store.createUser('ws@example.com', 'x');
  const cookie = `gw_session=${store.createSession(uid, 600)}`;
  const s = net.connect(port, '127.0.0.1');
  await new Promise((r) => s.on('connect', r));
  s.on('error', () => {});
  s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${cookie}\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 150)); // the gateway is now waiting for the sandbox
  s.resetAndDestroy(); // a real TCP reset, as a browser or a script can send
  await new Promise((r) => setTimeout(r, 100));
  release(); // the sandbox "starts" after the client left
  await new Promise((r) => setTimeout(r, 300));
  assert.match(await raw(port, 'GET /gw/healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200 /, 'still answering');
});

test('every long-running service restarts after a crash or a reboot, and the gateway has a healthcheck', () => {
  const yml = readFileSync(new URL('../../infra/docker-compose.gateway.yml', import.meta.url), 'utf8');
  const block = (name) => { const i = yml.indexOf(`\n  ${name}:\n`); assert.ok(i >= 0, name); const rest = yml.slice(i + 1); const j = rest.search(/\n  [a-z-]+:\n/); return j < 0 ? rest : rest.slice(0, j + 1); };
  for (const name of ['gateway', 'sandbox-runner', 'llm-proxy', 'egress-proxy', 'proxy']) assert.match(block(name), /\n    restart: unless-stopped/, `${name} has no restart policy`);
  assert.match(block('gateway'), /healthcheck:[\s\S]*\/gw\/healthz/);
});

test('every service installs a last-resort handler that exits non-zero, so the restart policy applies', () => {
  for (const svc of ['gateway', 'runner', 'llm-proxy', 'egress-proxy']) {
    const src = readFileSync(new URL(`../../${svc}/src/index.js`, import.meta.url), 'utf8');
    assert.match(src, /'uncaughtException', 'unhandledRejection'/, svc);
    assert.match(src, /process\.exit\(1\)/, svc);
  }
});
