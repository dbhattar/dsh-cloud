// scripts/probe-agent-shell.sh: what it runs in a sandbox and what it refuses, with a stub `docker`. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/probe-agent-shell.sh', import.meta.url));

/** A fake `docker`: logs every call, answers `inspect` with `running`, saves what is piped into the container, and can fail the probe. */
function fakeDocker({ running = 'true', failProbe = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  const log = join(dir, 'calls.log');
  const piped = join(dir, 'piped.sh');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  inspect) echo ${running} ;;
  exec)
    case "$*" in
      *"cat > /workspace/probe-shell.sh"*) cat > "${piped}" ;;
      *"sh /workspace/probe-shell.sh"*) ${failProbe ? 'echo probe failed >&2; exit 7' : 'echo "probe output"'} ;;
      *"cat /workspace/agent-run.out"*) echo "agent said: probe output" ;;
      *"timeout 240 dsh --profile headless"*) echo "dsh exit: 0" ;;
    esac ;;
esac
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } };
  const probe = () => readFileSync(piped, 'utf8');
  return { dir, calls, probe };
}

function run(args, { docker = fakeDocker(), env = {} } = {}) {
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: `${docker.dir}:${process.env.PATH}`, HOME: process.env.HOME, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: docker.calls(), docker };
}

test('help prints the usage without the script body and touches nothing; no container, or an unknown option, is a usage error', () => {
  const h = run(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Check what the agent's shell can do/);
  assert.ok(!/set -eu/.test(h.stdout), 'only the comment block');
  assert.deepEqual(h.calls, []);
  for (const args of [[], ['--nope'], ['dsh-sbx-1', '--bogus']]) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.deepEqual(r.calls, []);
  }
});

test('a container that is not running is refused before anything is written into it', () => {
  const r = run(['dsh-sbx-9'], { docker: fakeDocker({ running: 'false' }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dsh-sbx-9 is not a running container/);
  assert.deepEqual(r.calls, ['inspect -f {{.State.Running}} dsh-sbx-9'], 'only the check');
});

test('control run: the probe is written into the workspace, run as the sandbox user, and removed; no model call', () => {
  const r = run(['dsh-sbx-9']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /### control/);
  assert.match(r.stdout, /probe output/);
  assert.ok(!/agent/.test(r.stdout.replace('the agent\'s', '')), 'no agent section');
  assert.deepEqual(r.calls.map((c) => c.split(' ').slice(0, 5).join(' ')), [
    'inspect -f {{.State.Running}} dsh-sbx-9',
    'exec -i -u dsh dsh-sbx-9',
    'exec -u dsh dsh-sbx-9 sh',
    'exec -u dsh dsh-sbx-9 rm',
  ]);
  assert.ok(!r.calls.some((c) => c.includes('dsh --profile headless')));
});

test('the probe it writes is valid shell, checks the right things, and is aimed at example.com unless told otherwise', () => {
  const r = run(['dsh-sbx-9']);
  const script = r.docker.probe();
  const syntax = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const needle of ['https://example.com/', 'http://example.com:8080/', '169.254.169.254', '10.0.0.1', 'KEY|PASSWORD|SECRET|TOKEN', 'curl wget git python3 pip jq rg unzip node npm httpx nuclei', 'direct TCP']) assert.ok(script.includes(needle), needle);
  assert.ok(!script.includes('$HOST') && !script.includes('${'), 'the host is filled in, not left as a variable');
  const other = run(['dsh-sbx-9'], { env: { PROBE_HOST: 'staging.example.org' } });
  assert.ok(other.docker.probe().includes('https://staging.example.org/'));
  assert.ok(!other.docker.probe().includes('https://example.com/'));
});

test('--agent also has the real agent run it, and shows what it answered', () => {
  const r = run(['dsh-sbx-9', '--agent']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /### agent/);
  assert.match(r.stdout, /agent said: probe output/);
  const dsh = r.calls.find((c) => c.includes('dsh --profile headless'));
  assert.ok(dsh, 'the agent was started');
  assert.match(dsh, /exec -u dsh -w \/workspace dsh-sbx-9/);
  assert.match(dsh, /sh \/workspace\/probe-shell\.sh/);
  assert.match(dsh, /--patch \/tmp\/dsh-cloud-patch\.yml/, 'with the sandbox\'s own policy patch');
});

test('the probe files are removed even when the probe fails, and the failure is the script\'s exit code', () => {
  const r = run(['dsh-sbx-9'], { docker: fakeDocker({ failProbe: true }) });
  assert.equal(r.status, 7);
  assert.ok(r.calls.some((c) => /exec -u dsh dsh-sbx-9 rm -f \/workspace\/probe-shell\.sh/.test(c)), 'cleanup ran');
});
