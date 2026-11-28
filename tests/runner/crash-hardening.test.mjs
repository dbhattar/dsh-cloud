// SEC-01 (docs/security-review.md): a request target that is not a valid URL must be a 400, not the end of the runner. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { loadConfig } from '../../runner/src/config.js';
import { createRunner } from '../../runner/src/server.js';

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

test('the runner answers a request target that is not a valid URL with 400 and keeps serving', async () => {
  const cfg = loadConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_SECRET: 'runner-secret-0123456789', LLM_PROXY_URL: 'http://llm-proxy:8081/' });
  const server = createRunner({ cfg, docker: {}, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;
  for (const target of ['//[', '//a:99999', 'http://[']) assert.match(await raw(port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 400 /, target);
  assert.match(await raw(port, 'GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200 /, 'still answering');
});
