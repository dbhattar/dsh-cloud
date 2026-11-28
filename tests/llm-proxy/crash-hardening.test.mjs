// SEC-01 (docs/security-review.md): any sandbox can reach the llm-proxy, so one malformed request line must not end it for every user.
// Reproduced on 2026-11-28 before the fix: `GET //[ HTTP/1.1` made the process exit with ERR_INVALID_URL. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { loadConfig } from '../../llm-proxy/src/config.js';
import { UsageStore } from '../../llm-proxy/src/db.js';
import { createProxy } from '../../llm-proxy/src/server.js';

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));
const raw = (port, bytes) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(bytes));
  let out = '';
  s.on('data', (d) => (out += d));
  s.on('close', () => resolve(out.split('\r\n')[0] || 'closed'));
  s.on('error', () => resolve('error'));
  setTimeout(() => { s.destroy(); resolve(out.split('\r\n')[0] || 'no answer'); }, 500);
});

test('the user port and the admin port answer a target that is not a valid URL with 400 and keep serving', async () => {
  const cfg = loadConfig({ UPSTREAM_API_KEY: 'sk-real', ADMIN_SECRET: 'admin-secret-01234567890', ALLOWED_MODELS: 'm' });
  const { user, admin } = createProxy({ cfg, store: new UsageStore(':memory:'), log: () => {} });
  for (const s of [user, admin]) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); servers.push(s); }
  for (const [name, server] of [['user', user], ['admin', admin]]) {
    const port = server.address().port;
    for (const target of ['//[', '//a:99999', 'http://[']) assert.match(await raw(port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 400 /, `${name} ${target}`);
  }
  assert.match(await raw(user.address().port, 'GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200 /, 'still answering');
});
