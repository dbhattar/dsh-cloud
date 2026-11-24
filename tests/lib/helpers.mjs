// Shared helpers for the regression suites. Zero dependencies (Node >= 20).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASE = process.env.BASE_URL || 'https://localhost';
const agent = new https.Agent({ rejectUnauthorized: false }); // Caddy internal CA

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
export const compose = (file, args, env = {}) => {
  // The sandbox image copies a pre-built harness; it is built separately (scripts/build-harness.sh).
  if ((args.includes('--build') || args.includes('build')) && !existsSync(join(ROOT, 'sandbox', '.harness-dist', 'apps', 'cli', 'lib', 'bin.js'))) {
    throw new Error('No built harness at sandbox/.harness-dist. Run scripts/build-harness.sh first.');
  }
  return composeRaw(file, args, env);
};
const composeRaw = (file, args, env) =>
  sh('docker', ['compose', '-f', join(ROOT, 'infra', file), ...args], { env: { ...process.env, ...env }, timeout: 3600000 }); // image builds from harness source can take a while

/** HTTP/1.1 request that never follows redirects. Returns {status, headers, body}. */
export function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request(
      BASE + path,
      {
        method,
        agent,
        headers: {
          ...(data ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
    req.end(data);
  });
}

/** Perform a WebSocket upgrade handshake; resolves with status and the open socket (caller closes). */
export function wsHandshake(path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(BASE + path, {
      agent,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Origin: BASE,
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, headers: res.headers, socket }));
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers, socket: null });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('ws timeout')));
    req.end();
  });
}

export const cookieOf = (res, name) => {
  const set = [].concat(res.headers['set-cookie'] ?? []);
  const c = set.find((s) => s.startsWith(`${name}=`));
  return c ? c.split(';')[0] : null;
};

export async function waitFor(fn, { timeoutMs = 120000, everyMs = 1000, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/** Sign up a throwaway user through the gateway; returns {email, cookie, id, container}. */
export async function signupUser(label, run, password = 'test-password-123') {
  const email = `${label}-${run}@example.com`;
  const r = await request('/gw/signup', { method: 'POST', body: { email, password } });
  if (r.status !== 303) throw new Error(`signup ${email} -> ${r.status}: ${r.body.slice(0, 200)}`);
  const cookie = cookieOf(r, 'gw_session');
  const me = JSON.parse((await request('/gw/api/me', { headers: { cookie } })).body);
  return { email, cookie, id: me.id, container: `dsh-sbx-${me.id}` };
}

/** Request / until the user's sandbox answers (the launching page is 503 until it is up). */
export function waitSandboxUp(u, timeoutMs = 150000) {
  return waitFor(
    async () => {
      const r = await request('/', { headers: { cookie: u.cookie, accept: 'text/html', 'sec-fetch-dest': 'iframe' } });
      return r.status === 200 ? r : null;
    },
    { timeoutMs, what: `sandbox for ${u.email}` },
  );
}

/**
 * The Docker suites share the compose project, container and volume names of a local dev stack, and their
 * cleanup runs `compose down -v` plus `docker rm`/`volume rm`. Refuse to start when dev data exists, so a
 * test run can never delete real accounts or user workspaces. Set DSH_TESTS_ALLOW_DESTRUCTIVE=1 to override.
 */
export function assertNoDevData() {
  if (process.env.DSH_TESTS_ALLOW_DESTRUCTIVE === '1') return;
  const lines = (args) => sh('docker', args).split('\n').map((l) => l.trim()).filter(Boolean);
  const found = [
    ...lines(['ps', '-a', '--filter', 'label=dsh-cloud.user', '--format', 'container {{.Names}}']),
    ...lines(['volume', 'ls', '--filter', 'name=dsh-data-', '--format', 'volume {{.Name}}']),
    ...lines(['volume', 'ls', '--filter', 'name=dshcloud_', '--format', 'volume {{.Name}}']),
  ];
  if (found.length) {
    throw new Error(
      `Refusing to run: existing dsh-cloud data would be deleted by this suite:\n  ${found.join('\n  ')}\n` +
        'Remove it yourself (scripts/restart.sh --wipe) or set DSH_TESTS_ALLOW_DESTRUCTIVE=1.',
    );
  }
}
