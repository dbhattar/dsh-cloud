// SEC-10 (docs/security-review.md): shared secrets must be long and not a pattern, checked by one shared function in all three services,
// and the container hardening is in the compose file. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { secretProblem } from '../../common/secret.js';
import { loadConfig as gatewayConfig } from '../../gateway/src/config.js';
import { loadConfig as llmConfig } from '../../llm-proxy/src/config.js';
import { loadConfig as runnerConfig } from '../../runner/src/config.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const GOOD = randomBytes(24).toString('hex');

test('a secret must be at least 24 characters and not a pattern', () => {
  assert.equal(secretProblem(GOOD), null);
  assert.equal(secretProblem('runner-secret-0123456789'), null, 'the constant the tests use is fine');
  for (const bad of ['', 'short', 'a'.repeat(16), 'a'.repeat(64), 'abababababababababababab', '0123012301230123012301230123', '1234567890'.repeat(3).slice(0, 23), undefined, null, 5]) {
    assert.ok(secretProblem(bad), `${JSON.stringify(bad)} must be refused`);
  }
  assert.match(secretProblem('a'.repeat(30)), /pattern.*openssl rand -hex 24/);
  assert.match(secretProblem('short'), /at least 24 characters/);
});

test('all three services refuse a weak shared secret at start-up, and accept a generated one', () => {
  const g = (secret) => () => gatewayConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://r:1', RUNNER_SECRET: secret });
  const r = (secret) => () => runnerConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_SECRET: secret });
  const l = (secret) => () => llmConfig({ UPSTREAM_API_KEY: 'k', ADMIN_SECRET: secret, ALLOWED_MODELS: 'm' });
  for (const weak of ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'short', '12341234123412341234123412341234']) {
    assert.throws(g(weak), /RUNNER_SECRET/, `gateway ${weak}`);
    assert.throws(r(weak), /RUNNER_SECRET/, `runner ${weak}`);
    assert.throws(l(weak), /ADMIN_SECRET/, `llm-proxy ${weak}`);
  }
  assert.doesNotThrow(g(GOOD));
  assert.doesNotThrow(r(GOOD));
  assert.doesNotThrow(l(GOOD));
  // the gateway's copy of the llm-proxy's secret is held to the same rule
  assert.throws(() => gatewayConfig({ PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://r:1', RUNNER_SECRET: GOOD, LLM_ADMIN_SOCKET: '/s', LLM_ADMIN_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaa' }), /LLM_ADMIN_SECRET/);
});

test('the check lives in one place: common/secret.js, imported by each service, copied into each image at the same relative path', () => {
  for (const svc of ['gateway', 'runner', 'llm-proxy']) {
    assert.match(read(`${svc}/src/config.js`), /from '\.\.\/\.\.\/common\/secret\.js'/, `${svc} imports the shared file`);
    assert.equal(existsSync(new URL(`../../${svc}/src/secret.js`, import.meta.url)), false, `${svc} has no copy of its own`);
    assert.match(read(`${svc}/Dockerfile`), /^COPY --from=common \. \/common$/m, `${svc} image gets /common`);
  }
  const yml = read('infra/docker-compose.gateway.yml');
  assert.equal((yml.match(/additional_contexts:\n\s+common: \.\.\/common/g) ?? []).length, 3, 'compose gives the three builds the common context');
  assert.match(read('.github/workflows/ci.yml'), /docker build --build-context common=common/);
});

const block = (yml, name) => { const i = yml.indexOf(`\n  ${name}:\n`); assert.ok(i >= 0, name); const rest = yml.slice(i + 1); const j = rest.search(/\n  [a-z-]+:\n/); return j < 0 ? rest : rest.slice(0, j + 1); };

test('compose: every long-running service drops all capabilities, cannot gain privileges, and has a read-only root filesystem', () => {
  const yml = read('infra/docker-compose.gateway.yml');
  assert.match(yml, /x-hardening: &hardening\n  security_opt:\n    - no-new-privileges:true\n  cap_drop:\n    - ALL\n  read_only: true\n  tmpfs:\n    - \/tmp/);
  for (const name of ['gateway', 'sandbox-runner', 'llm-proxy', 'egress-proxy', 'proxy']) assert.match(block(yml, name), /\n    <<: \*hardening\n/, `${name} is hardened`);
  assert.doesNotMatch(block(yml, 'gateway'), /privileged|docker\.sock/);
  // the few capabilities given back, each for a stated reason
  assert.match(block(yml, 'gateway'), /cap_add:\n\s+- CHOWN\n\s+- SETUID\n\s+- SETGID\n/);
  assert.match(block(yml, 'proxy'), /cap_add:\n\s+- NET_BIND_SERVICE[^\n]*\n/);
  assert.match(block(yml, 'sandbox-runner'), /cap_add:\n\s+- DAC_OVERRIDE\n/, 'the runner gets one capability, to open a Docker socket it does not own');
  for (const name of ['llm-proxy', 'egress-proxy']) assert.doesNotMatch(block(yml, name), /cap_add/, `${name} needs none`);
  assert.match(block(yml, 'proxy'), /tmpfs:[\s\S]*\/config/, 'Caddy needs /config writable');
  assert.match(block(yml, 'proxy'), /group_add:\n\s+- "1000"/, 'Caddy reaches the gateway socket through its group, not through DAC_OVERRIDE');
  assert.doesNotMatch(block(yml, 'proxy').replace(/#.*$/gm, ''), /DAC_OVERRIDE/, 'only the explanation mentions it');
  assert.match(block(yml, 'gateway'), /"setpriv", "--reuid=node"/, 'the health check runs as node, because the socket is owner and group only');
});

test('the gateway runs as node: its entrypoint drops every capability and privilege before starting it, and does nothing as root beyond taking over its volumes', () => {
  const sh = read('gateway/docker-entrypoint.sh');
  assert.match(sh, /chown -R node:node/);
  assert.match(sh, /exec setpriv --reuid=node --regid=node --init-groups --bounding-set=-all --inh-caps=-all/);
  assert.match(read('gateway/Dockerfile'), /ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]/);
  assert.doesNotMatch(read('gateway/Dockerfile'), /^USER root/m);
});

// ---- SEC-11: the production Caddy configuration ----

test('Caddyfile.production: the domain comes from the environment, no development certificate, headers, limits, the socket upstream and no access log', () => {
  const c = read('infra/Caddyfile.production');
  assert.match(c, /^\{\$DOMAIN\} \{/m, 'the site address is DOMAIN, and is empty (so Caddy refuses to start) when it is not set');
  const code = c.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // what Caddy reads, without the explanations
  assert.doesNotMatch(code, /tls internal|\blocalhost\b/, 'no development certificate');
  for (const h of [/Strict-Transport-Security "max-age=\d{7,}"/, /X-Content-Type-Options "nosniff"/, /\?Referrer-Policy/, /-Server/]) assert.match(c, h);
  assert.match(c, /request_body \{\n\s+max_size \d+MB/);
  assert.match(c, /read_header \d+s/);
  assert.match(c, /reverse_proxy unix\/\/run\/gw\/gateway\.sock/);
  assert.doesNotMatch(code, /^\s*log\b/m, 'a log would write the query strings of reset links and launch tokens');
  assert.doesNotMatch(code, /gateway:8080/);
});

test('compose: ports 80, 443 and 443/udp are published by Caddy only, the Caddyfile and the public address are chosen from the environment', () => {
  const yml = read('infra/docker-compose.gateway.yml');
  assert.match(block(yml, 'proxy'), /ports:\n\s+- "80:80"[^\n]*\n\s+- "443:443"\n\s+- "443:443\/udp"/);
  for (const name of ['gateway', 'sandbox-runner', 'llm-proxy', 'egress-proxy']) assert.doesNotMatch(block(yml, name), /\n    ports:/, name);
  assert.match(block(yml, 'proxy'), /\.\/\$\{CADDYFILE:-Caddyfile\.gateway\}:\/etc\/caddy\/Caddyfile:ro/);
  assert.match(block(yml, 'proxy'), /DOMAIN: \$\{DOMAIN:-\}/);
  assert.equal((yml.match(/PUBLIC_URL: \$\{PUBLIC_URL:-https:\/\/localhost\/\}/g) ?? []).length, 2, 'gateway and runner take the public address from the environment');
  assert.doesNotMatch(yml, /PUBLIC_URL: https:\/\/localhost\/\n/);
});

test('both real Caddyfiles are valid for Caddy, and production refuses to start without a domain (needs Docker; skipped without)', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return t.skip('no Docker');
  const image = /image: (caddy:[^\s]+)/.exec(read('infra/docker-compose.gateway.yml'))[1];
  const root = new URL('../../infra/', import.meta.url).pathname;
  const validate = (file, env) => spawnSync('docker', ['run', '--rm', ...env, '-v', `${root}${file}:/etc/caddy/Caddyfile:ro`, image, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], { encoding: 'utf8' });
  assert.equal(validate('Caddyfile.gateway', []).status, 0);
  assert.equal(validate('Caddyfile.production', ['-e', 'DOMAIN=cloud.example.com']).status, 0);
  assert.notEqual(validate('Caddyfile.production', []).status, 0, 'no domain: it must not start');
});

test('scripts/gen-secrets.sh prints two secrets the services accept, different every time, and never writes a file', async () => {
  const { execFileSync } = await import('node:child_process');
  const run = () => execFileSync(new URL('../../scripts/gen-secrets.sh', import.meta.url).pathname, { encoding: 'utf8' }).trim().split('\n');
  const [a, b] = [run(), run()];
  assert.deepEqual(a.map((l) => l.split('=')[0]), ['RUNNER_SECRET', 'LLM_ADMIN_SECRET']);
  for (const line of [...a, ...b]) assert.equal(secretProblem(line.split('=')[1]), null, line.split('=')[0]);
  assert.notEqual(a[0], b[0]);
  assert.notEqual(a[0].split('=')[1], a[1].split('=')[1], 'the two are independent');
});
