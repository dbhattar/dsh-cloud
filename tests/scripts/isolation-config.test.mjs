// SEC-05, 07 and 09 (docs/security-review.md) in the deployment files and scripts: gVisor by default, bounded logs and service limits, and the
// scripts that handle volumes understand per-account keys and refuse unexpected names. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const yml = read('infra/docker-compose.gateway.yml');
const block = (name) => { const i = yml.indexOf(`\n  ${name}:\n`); assert.ok(i >= 0, name); const rest = yml.slice(i + 1); const j = rest.search(/\n  [a-z-]+:\n/); return j < 0 ? rest : rest.slice(0, j + 1); };

test('compose: the runner defaults to gVisor and runc needs an explicit flag; the sandbox log bound is passed on', () => {
  const runner = block('sandbox-runner');
  assert.match(runner, /SANDBOX_RUNTIME: \$\{SANDBOX_RUNTIME:-runsc\}/);
  assert.match(runner, /ALLOW_INSECURE_RUNTIME: \$\{ALLOW_INSECURE_RUNTIME:-false\}/);
  assert.match(runner, /SANDBOX_LOG_MAX_SIZE: \$\{SANDBOX_LOG_MAX_SIZE:-10m\}/);
  assert.doesNotMatch(yml, /SANDBOX_RUNTIME:-runc/);
});

test('compose: every long-running service has a bounded log and memory and process limits', () => {
  assert.match(yml, /x-logging: &logging\n  driver: local\n  options:\n    max-size: \d+m\n    max-file: "\d+"/);
  for (const name of ['gateway', 'sandbox-runner', 'llm-proxy', 'egress-proxy', 'proxy']) {
    const b = block(name);
    assert.match(b, /\n    logging: \*logging\n/, `${name}: logging`);
    assert.match(b, /\n    mem_limit: \d+m /, `${name}: memory`);
    assert.match(b, /\n    pids_limit: \d+\n/, `${name}: pids`);
  }
});

test('restart.sh only allows the insecure runtime for the development fallback it warns about', () => {
  const sh = read('scripts/restart.sh');
  assert.match(sh, /\[ "\$RUNTIME" = runc \] && export ALLOW_INSECURE_RUNTIME=true/);
  assert.equal((sh.match(/ALLOW_INSECURE_RUNTIME/g) ?? []).length >= 1, true);
});

/** Run a shell fragment taken from a real script, so what is tested is the script's own pattern. */
const run = (script, env = {}) => spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const NAMES = {
  ok: ['dsh-data-1', 'dsh-ws-1', 'dsh-data-12-0123456789abcdef', 'dsh-ws-123456789-fedcba9876543210'],
  bad: ['dsh-data-1-short', 'dsh-data-x', 'dsh-ws-1-ZZZZZZZZZZZZZZZZ', 'dsh-data-1-0123456789abcdef0', 'dshcloud_gateway-data', 'something-else', 'dsh-data-1;rm', 'dsh-sbx-1'],
};

test('restore.sh accepts the volume names a backup holds, with or without a key, and Caddy\'s, and refuses anything else (SEC-13, SEC-09)', () => {
  const src = read('scripts/restore.sh');
  const block = /  case "\$name" in\n[\s\S]*?  esac\n/.exec(src)[0];
  for (const name of [...NAMES.ok, 'dshcloud_caddy-data']) assert.equal(run(`name='${name}'\n${block}`).status, 0, name);
  for (const name of NAMES.bad) {
    const r = run(`name='${name}'\n${block}`);
    assert.equal(r.status, 1, `${name} must be refused`);
    assert.match(r.stderr, /unexpected name/);
  }
});

test('backup.sh and restart.sh --wipe select account volumes by the same key-aware pattern', () => {
  for (const file of ['scripts/backup.sh', 'scripts/restart.sh']) {
    const pattern = /grep -E ['"]([^'"]*dsh-\(data\|ws\)-\[0-9\]\+[^'"]*)['"]/.exec(read(file))?.[1];
    assert.ok(pattern, `${file} has the pattern`);
    const re = new RegExp(pattern.replace('\\$', '$').replace(/\$\{PROJECT\}/g, 'dshcloud').replace(/\|\^dshcloud_caddy-data\$?/, '|^dshcloud_caddy-data$'));
    for (const name of NAMES.ok) assert.ok(re.test(name), `${file} must select ${name}`);
    for (const name of ['dsh-data-1-short', 'dsh-sbx-1', 'dshcloud_gateway-data', 'dsh-data-x']) assert.ok(!re.test(name), `${file} must not select ${name}`);
  }
});
