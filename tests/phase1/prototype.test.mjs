// Phase 1 regression: single sandbox behind Caddy (infra/docker-compose.yml).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { compose, cookieOf, request, waitFor, wsHandshake } from '../lib/helpers.mjs';

const FILE = 'docker-compose.yml';
let token;

before(async () => {
  compose(FILE, ['up', '-d', '--build']);
  token = await waitFor(() => compose(FILE, ['logs', 'sandbox']).match(/token=([A-Za-z0-9_-]+)/)?.[1], {
    what: 'launch token in sandbox logs',
  });
});
after(() => compose(FILE, ['down']));

test('unauthenticated request is rejected', async () => {
  assert.equal((await request('/')).status, 401);
});

test('launch token sets an HttpOnly auth cookie and grants access', async () => {
  const r = await request(`/?token=${token}`);
  assert.equal(r.status, 303);
  const set = [].concat(r.headers['set-cookie']).join(';');
  assert.match(set, /dsh-auth-/);
  assert.match(set, /HttpOnly/);
  const cookie = cookieOf(r, [].concat(r.headers['set-cookie'])[0].split('=')[0]);
  assert.equal((await request('/', { headers: { cookie } })).status, 200);
});

test('WebSocket /api/remote.mux upgrades through the proxy; without auth it does not', async () => {
  const login = await request(`/?token=${token}`);
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
  const ok = await wsHandshake('/api/remote.mux', { headers: { cookie } });
  assert.equal(ok.status, 101);
  ok.socket.destroy();
  const denied = await wsHandshake('/api/remote.mux');
  assert.notEqual(denied.status, 101);
});
