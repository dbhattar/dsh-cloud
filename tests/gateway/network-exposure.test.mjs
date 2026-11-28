// SEC-04 (docs/security-review.md): the gateway must not be reachable from a sandbox. It listens on a unix socket shared with Caddy only,
// so there is no TCP port for a sandbox to connect to and no client address to forge. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Audit } from '../../gateway/src/audit.js';
import { hashPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { listenGateway } from '../../gateway/src/listen.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

function make(env) {
  const store = new Store(':memory:');
  const server = createGateway({ cfg: loadConfig({ ...base, ...env }), store, manager: { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: async () => ({}), status: () => ({}) }, log: () => {}, audit: new Audit({ store, log: () => {} }) });
  servers.push(server);
  return { server, store, cfg: loadConfig({ ...base, ...env }) };
}
const viaSocket = (socketPath, path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path, method, headers }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
  req.on('error', reject);
  req.end(body);
});

test('with GATEWAY_SOCKET the gateway listens on the socket and on no TCP port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-'));
  const socketPath = join(dir, 'run', 'gateway.sock');
  writeFileSync(join(dir, 'stale'), ''); // an unrelated file beside it is left alone
  const { server, cfg } = make({ GATEWAY_SOCKET: socketPath });
  assert.equal(cfg.socketPath, socketPath);
  const where = listenGateway(server, cfg);
  await new Promise((r) => server.once('listening', r));
  assert.match(where, /unix socket/);
  assert.equal(typeof server.address(), 'string', 'a path, not { address, port }');
  assert.equal(statSync(socketPath).mode & 0o777, 0o660, 'owner and group only');
  assert.equal((await viaSocket(socketPath, '/gw/healthz')).status, 200);
  assert.ok(existsSync(join(dir, 'stale')));
});

test('a leftover socket file from a previous run does not stop it starting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-'));
  const socketPath = join(dir, 'gateway.sock');
  const first = net.createServer().listen(socketPath);
  await new Promise((r) => first.once('listening', r));
  first.close(); // closing a unix server removes the file on most systems; recreate one to be sure
  writeFileSync(socketPath, '');
  const { server, cfg } = make({ GATEWAY_SOCKET: socketPath });
  listenGateway(server, cfg);
  await new Promise((r) => server.once('listening', r));
  assert.equal((await viaSocket(socketPath, '/gw/healthz')).status, 200);
});

test('without the setting it still listens on the TCP port (development and the other tests)', async () => {
  const { server, cfg } = make({ PORT: '0' });
  const where = listenGateway(server, { ...cfg, port: 0 });
  await new Promise((r) => server.once('listening', r));
  assert.match(where, /^:/);
  assert.equal(typeof server.address(), 'object');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/gw/healthz`)).status, 200);
});

test('over the socket there is no peer address: with no forwarded header the client is "local", never undefined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-'));
  const socketPath = join(dir, 'gateway.sock');
  const { server, cfg, store } = make({ GATEWAY_SOCKET: socketPath });
  store.createUser('ann@example.com', hashPassword('a-long-password-1'));
  listenGateway(server, cfg);
  await new Promise((r) => server.once('listening', r));
  const body = 'email=ann%40example.com&password=wrong-password-1';
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost', 'content-length': Buffer.byteLength(body) };
  assert.equal((await viaSocket(socketPath, '/gw/login', headers, 'POST', body)).status, 401);
  assert.equal(store.queryAudit({ event: 'login.fail' })[0].ip, 'local');
  // and Caddy's header, when present, is what is recorded
  await viaSocket(socketPath, '/gw/login', { ...headers, 'x-forwarded-for': '203.0.113.9' }, 'POST', body);
  assert.equal(store.queryAudit({ event: 'login.fail' })[0].ip, '203.0.113.9');
});

test('the deployment files wire it up: the socket volume is shared by the gateway and Caddy only, nothing publishes the gateway, Caddy dials the socket', () => {
  const yml = read('infra/docker-compose.gateway.yml');
  const block = (name) => { const i = yml.indexOf(`\n  ${name}:\n`); assert.ok(i >= 0, name); const rest = yml.slice(i + 1); const j = rest.search(/\n  [a-z-]+:\n/); return j < 0 ? rest : rest.slice(0, j + 1); };
  assert.match(block('gateway'), /GATEWAY_SOCKET: \/run\/gw\/gateway\.sock/);
  assert.match(block('gateway'), /gateway-socket:\/run\/gw/);
  assert.match(block('proxy'), /gateway-socket:\/run\/gw/);
  const users = yml.split('\n').filter((l) => /^\s+- gateway-socket:/.test(l));
  assert.equal(users.length, 2, 'exactly two services mount the socket volume');
  for (const name of ['gateway', 'sandbox-runner', 'llm-proxy', 'egress-proxy']) assert.doesNotMatch(block(name), /\n    ports:/, `${name} publishes a port`);
  assert.match(block('gateway'), /healthcheck:[\s\S]*socketPath/, 'the healthcheck goes through the socket');
  assert.match(read('infra/Caddyfile.gateway'), /reverse_proxy unix\/\/run\/gw\/gateway\.sock/);
  assert.doesNotMatch(read('infra/Caddyfile.gateway'), /gateway:8080/);
});
