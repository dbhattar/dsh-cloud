// SEC-12: only an image whose harness is the locked, committed one is published, and servers get digests. Uses a stub `docker` and
// throwaway git repositories; nothing is built or pushed. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

function world({ buildInfo } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pub-')); dirs.push(root);
  const repo = join(root, 'dsh-cloud'); mkdirSync(join(repo, 'sandbox'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'sandbox/.harness-src/\nsandbox/.harness-dist/\nimages.env*\n');
  const remote = join(root, 'remote.git'); git(root, 'init', '--bare', '-b', 'main', remote);
  const h = join(root, 'harness'); mkdirSync(join(h, 'apps', 'cli'), { recursive: true });
  git(h, 'init', '-b', 'main');
  writeFileSync(join(h, 'package.json'), '{"name":"h"}\n'); writeFileSync(join(h, 'apps', 'cli', 'package.json'), '{"version":"1.2.3"}\n');
  git(h, 'add', '.'); git(h, 'commit', '-m', 'one'); git(h, 'remote', 'add', 'origin', 'git@github.com:someone/harness.git');
  git(h, 'push', remote, 'main'); git(h, 'fetch', remote, 'main:refs/remotes/origin/main');
  const sha = git(h, 'rev-parse', 'HEAD');
  const env = { ...process.env, HARNESS_DIR: h };
  const lockRun = spawnSync(join(repo, 'scripts', 'harness-lock.sh'), ['--update'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(lockRun.status, 0, lockRun.stderr);
  mkdirSync(join(repo, 'sandbox', '.harness-dist'), { recursive: true });
  writeFileSync(join(repo, 'sandbox', '.harness-dist', 'BUILD_INFO'), buildInfo ?? `commit=${sha}\ndirty=no\nversion=1.2.3\n`);
  git(repo, 'init', '-b', 'main'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'x');
  // A docker that records its arguments; `inspect` answers with a digest for the reference it was asked about, unless told to fail.
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'docker.log');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = inspect ]; then
  [ -z "\${STUB_NO_DIGEST:-}" ] || exit 0
  for a; do last="$a"; done; ref="\${last%:*}"; printf '%s@sha256:%064d\\n' "$ref" 7; exit 0
fi
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = (args, extraEnv = {}) => spawnSync(join(repo, 'scripts', 'publish-images.sh'), args, { cwd: repo, encoding: 'utf8', env: { ...env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv } });
  return { repo, run, sha, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}
const GOOD = ['--registry', 'ghcr.io/someone/dsh-cloud', '--tag', 'sha-abc'];

test('builds the five images, pushes them, and writes a digest line for each; the sandbox build requires a clean harness and the services get the common context', () => {
  const w = world();
  const r = w.run(GOOD);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = w.calls();
  assert.equal(calls.filter((c) => c.startsWith('build ')).length, 5);
  assert.equal(calls.filter((c) => c.startsWith('push ')).length, 5);
  assert.ok(calls.some((c) => /^build --build-arg REQUIRE_CLEAN_HARNESS=1 -t ghcr\.io\/someone\/dsh-cloud-sandbox:sha-abc sandbox$/.test(c)), calls.join('\n'));
  for (const svc of ['gateway', 'runner', 'llm-proxy']) assert.ok(calls.some((c) => c.includes('--build-context common=common') && c.endsWith(` ${svc}`)), svc);
  const env = readFileSync(join(w.repo, 'images.env'), 'utf8').trim().split('\n');
  assert.deepEqual(env.map((l) => l.split('=')[0]), ['GATEWAY_IMAGE', 'RUNNER_IMAGE', 'LLM_PROXY_IMAGE', 'EGRESS_PROXY_IMAGE', 'SANDBOX_IMAGE']);
  for (const l of env) assert.match(l, /^[A-Z_]+=ghcr\.io\/someone\/dsh-cloud-[a-z-]+@sha256:[0-9]{64}$/);
});

test('--dry-run builds and pushes nothing', () => {
  const w = world();
  const r = w.run([...GOOD, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would run: docker build/);
  assert.deepEqual(w.calls().filter((c) => /^(build|push) /.test(c)), []);
});

test('a harness built from a dirty tree, or from another commit, or not built at all, is refused before anything is built', () => {
  for (const [name, info, rx] of [
    ['dirty', (sha) => `commit=${sha}\ndirty=yes\n`, /dirty tree/],
    ['other commit', () => `commit=${'b'.repeat(40)}\ndirty=no\n`, /not the locked commit/],
  ]) {
    const w = world();
    writeFileSync(join(w.repo, 'sandbox', '.harness-dist', 'BUILD_INFO'), info(w.sha));
    const r = w.run(GOOD);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, rx, name);
    assert.deepEqual(w.calls().filter((c) => /^(build|push) /.test(c)), [], name);
  }
  const w = world(); rmSync(join(w.repo, 'sandbox', '.harness-dist'), { recursive: true });
  const r = w.run(GOOD);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /build-harness\.sh --locked first/);
});

test('uncommitted changes to tracked files are refused; a dirty harness lock is refused', () => {
  const w = world();
  writeFileSync(join(w.repo, 'scripts', 'backup.sh'), '#!/bin/sh\n# edited\n');
  assert.match(w.run(GOOD).stderr, /uncommitted changes/);
  const x = world();
  const lock = join(x.repo, 'sandbox', 'harness.lock');
  writeFileSync(lock, readFileSync(lock, 'utf8').replace('dirty=no', 'dirty=yes'));
  git(x.repo, 'commit', '-am', 'dirty lock');
  const r = x.run(GOOD);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lock does not check out/);
});

test('a push that left no registry digest fails and leaves no images.env behind', () => {
  const w = world();
  const r = w.run(GOOD, { STUB_NO_DIGEST: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no registry digest/);
  assert.ok(!existsSync(join(w.repo, 'images.env')));
});

test('registry and tag are checked, not interpolated: a scheme, an upper-case name, spaces and a shell fragment are refused', () => {
  const w = world();
  for (const reg of ['https://ghcr.io/x/y', 'ghcr.io/Someone/dsh', 'ghcr.io/x y', 'ghcr.io/x;rm -rf /', 'ghcr.io//x']) {
    assert.equal(w.run(['--registry', reg, '--tag', 'v1']).status, 2, reg);
  }
  assert.equal(w.run(['--registry', 'ghcr.io/x/y', '--tag', '-bad']).status, 2);
  assert.deepEqual(w.calls().filter((c) => /^(build|push) /.test(c)), []);
});
