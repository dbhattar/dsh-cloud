// P5-6, gateway side: the welcome is remembered per user, the limits payload carries the settings it quotes, and the shell knows
// what to call the workspace. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };

test('welcome: remembered per user, the first time wins, others are unaffected', () => {
  const s = new Store(':memory:');
  const a = s.createUser('a@example.com', 'x');
  const b = s.createUser('b@example.com', 'x');
  assert.equal(s.welcomedAt(a), null);
  s.markWelcomed(a, 1000);
  s.markWelcomed(a, 2000);
  assert.equal(s.welcomedAt(a), 1000, 'the first time is kept');
  assert.equal(s.welcomedAt(b), null);
  assert.equal(s.welcomedAt(999), null, 'an unknown user is simply not welcomed');
});

test('migration: a database from before the welcome existed gets the column and keeps its users', () => {
  const dir = mkdtempSync(join(tmpdir(), 'old-db-'));
  const file = join(dir, 'gateway.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO users (email, pw_hash, created_at) VALUES ('old@example.com', 'x', 1);");
  old.close();
  const s = new Store(file);
  assert.equal(s.userByEmail('old@example.com').email, 'old@example.com');
  assert.equal(s.welcomedAt(1), null, 'an existing user sees the welcome once');
  s.markWelcomed(1, 5);
  assert.equal(new Store(file).welcomedAt(1), 5, 'persisted, and opening the database again is harmless');
});

async function gateway(extra = {}) {
  const store = new Store(':memory:');
  const uid = store.createUser('u@example.com', 'x');
  const cfg = loadConfig({ ...base, ...extra });
  const manager = new SandboxManager({ runner: { diskUsage: async () => [] }, cfg, log: () => {} });
  const server = createGateway({ cfg, store, manager, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cookie = `gw_session=${store.createSession(uid, 60)}`;
  const call = (method, path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: { cookie, ...headers } }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.end();
    });
  return { store, uid, call, close: () => { server.closeAllConnections(); server.close(); } };
}

test('HTTP: /gw/api/me says whether the welcome was seen; POST /gw/api/welcome records it', async () => {
  const g = await gateway();
  try {
    assert.equal(JSON.parse((await g.call('GET', '/gw/api/me')).text).welcomed, false);
    assert.equal((await g.call('POST', '/gw/api/welcome')).status, 200);
    assert.equal(JSON.parse((await g.call('GET', '/gw/api/me')).text).welcomed, true);
    assert.notEqual(g.store.welcomedAt(g.uid), null);
  } finally { g.close(); }
});

test('limits payload carries the limits as settings, so the welcome can say what applies', async () => {
  const g = await gateway({ IDLE_SECONDS: '900', MAX_BUSY_SECONDS: '7200', MAX_RUN_SECONDS: '28800', MAX_DISK_MB: '2048' });
  try {
    const l = JSON.parse((await g.call('GET', '/gw/api/limits')).text);
    assert.deepEqual(l.policy, { idleSeconds: 900, maxBusySeconds: 7200, maxRunSeconds: 28800, maxDiskMb: 2048 });
  } finally { g.close(); }
});

test('the app shell page is told what to call the workspace', async () => {
  const boot = async (extra) => {
    const g = await gateway(extra);
    try {
      const r = await g.call('GET', '/', { accept: 'text/html', 'sec-fetch-dest': 'document' });
      return JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(r.text)[1]);
    } finally { g.close(); }
  };
  assert.equal((await boot({})).workspaceName, 'Workspace');
  assert.equal((await boot({ WORKSPACE_NAME: 'Framewrite' })).workspaceName, 'Framewrite');
  assert.equal((await boot({ WORKSPACE_NAME: 'x'.repeat(100) })).workspaceName.length, 40, 'bounded');
});
