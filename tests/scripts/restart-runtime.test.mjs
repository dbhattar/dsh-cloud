// scripts/restart.sh: which sandbox runtime it picks and why. Uses `--print-runtime`, which decides and exits before anything
// is built, stopped or removed, with a stub `docker` that reports which runtimes the "daemon" has. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/restart.sh', import.meta.url));

/** A fake `docker` whose `info` lists `runtimes`; every call is appended to a log so tests can see what was run. */
function fakeDocker(runtimes) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in info) printf '%s ' ${runtimes.join(' ')} ;; context) echo fake ;; esac\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  return { dir, calls: () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } } };
}

function run(args = [], { runtimes = ['runc', 'runsc'], env = {}, envFile } = {}) {
  const docker = fakeDocker(runtimes);
  const dir = mkdtempSync(join(tmpdir(), 'env-'));
  const file = join(dir, 'env');
  writeFileSync(file, envFile ?? '');
  // A clean environment: no SANDBOX_RUNTIME from the machine running the tests.
  const r = spawnSync('sh', [SCRIPT, '--print-runtime', ...args], {
    encoding: 'utf8',
    env: { PATH: `${docker.dir}:${process.env.PATH}`, HOME: process.env.HOME, DSH_ENV_FILE: file, ...env },
  });
  const m = /^runtime=(\S+) source=(.*)$/m.exec(r.stdout);
  return { status: r.status, runtime: m?.[1], source: m?.[2], stdout: r.stdout, stderr: r.stderr, calls: docker.calls() };
}

test('automatic: gVisor when the daemon has it, plain runc when it does not', () => {
  const withRunsc = run();
  assert.equal(withRunsc.runtime, 'runsc');
  assert.match(withRunsc.source, /automatic: runsc is registered/);
  const without = run([], { runtimes: ['runc'] });
  assert.equal(without.runtime, 'runc');
  assert.match(without.source, /automatic: runsc is not registered/);
});

test('precedence: --runtime beats the environment variable, which beats the env file, which beats automatic', () => {
  const all = { env: { SANDBOX_RUNTIME: 'runc' }, envFile: 'SANDBOX_RUNTIME=runsc\n' };
  assert.deepEqual(pick(run(['--runtime', 'runsc'], all)), ['runsc', '--runtime']);
  assert.deepEqual(pick(run(['--runtime=runc'], { envFile: 'SANDBOX_RUNTIME=runsc\n' })), ['runc', '--runtime']);
  assert.deepEqual(pick(run([], all)), ['runc', 'SANDBOX_RUNTIME environment variable']);
  assert.match(run([], { envFile: 'SANDBOX_RUNTIME=runc\n' }).source, /SANDBOX_RUNTIME in .*env/);
  assert.equal(run([], { envFile: 'SANDBOX_RUNTIME=runc\n' }).runtime, 'runc', 'the file wins over automatic gVisor');
});
const pick = (r) => [r.runtime, r.source];

test('the env file is read like a .env: comments, quotes, spaces and the last value win', () => {
  for (const [text, want] of [
    ['# SANDBOX_RUNTIME=runc\n', 'runsc'], // only a comment: ignored, automatic applies
    ['SANDBOX_RUNTIME="runc"\n', 'runc'],
    ["SANDBOX_RUNTIME='runc'\n", 'runc'],
    ['SANDBOX_RUNTIME=runc   # plain docker\n', 'runc'],
    ['SANDBOX_RUNTIME=runsc\nSANDBOX_RUNTIME=runc\n', 'runc'],
    ['OTHER=1\nSANDBOX_RUNTIME=\n', 'runsc'], // empty means unset
    ['UPSTREAM_API_KEY=sk-x\n', 'runsc'],
  ]) assert.equal(run([], { envFile: text }).runtime, want, JSON.stringify(text));
});

test('an explicit runtime the daemon does not have is refused with a clear message, before anything is touched', () => {
  const r = run(['--runtime', 'runsc'], { runtimes: ['runc'] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /'runsc' .*is not registered with this Docker daemon.*it has: runc/);
  assert.match(r.stderr, /scripts\/lima\/setup\.sh/);
  assert.equal(run(['--runtime', 'runc'], { runtimes: ['runc'] }).status, 0, 'runc is always available');
});

test('invalid runtime names and a missing value are rejected', () => {
  for (const bad of ['Run C', 'runsc;rm -rf /', '../x', '-x']) assert.equal(run(['--runtime', bad]).status === 0, false, bad);
  const r = run(['--runtime']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs a name/);
});

test('--print-runtime changes nothing: the only Docker calls are the query for registered runtimes', () => {
  const r = run(['--wipe', '--harness']); // destructive flags are accepted but nothing runs
  assert.equal(r.status, 0);
  assert.ok(r.calls.every((c) => c.startsWith('info ')), `unexpected docker calls: ${r.calls}`);
});

test('help documents the runtime options', () => {
  const r = spawnSync('sh', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /--runtime runsc/);
  assert.match(r.stdout, /--print-runtime/);
  assert.match(r.stdout, /first match wins/);
});
