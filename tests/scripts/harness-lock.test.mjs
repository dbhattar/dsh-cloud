// SEC-12 (docs/security-review.md): a release build stages one committed harness commit with git archive, and the lock refuses
// anything that cannot be rebuilt from a commit. Runs against throwaway git repositories in a copy of scripts/, so the real
// sandbox/.harness-src and the owner's harness checkout are never touched. No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

/** A copy of the repo's scripts, an empty sandbox/, a "remote" and a harness checkout that has pushed its first commit. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'hl-')); dirs.push(root);
  const repo = join(root, 'dsh-cloud'); mkdirSync(join(repo, 'sandbox'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(repo, 'scripts'), { recursive: true });
  const remote = join(root, 'remote.git'); git(root, 'init', '--bare', '-b', 'main', remote);
  const h = join(root, 'harness'); mkdirSync(join(h, 'apps', 'cli'), { recursive: true });
  git(h, 'init', '-b', 'main');
  writeFileSync(join(h, 'package.json'), '{"name":"h"}\n');
  writeFileSync(join(h, 'apps', 'cli', 'package.json'), '{"version":"1.2.3"}\n');
  writeFileSync(join(h, '.gitignore'), 'ignored.txt\n');
  git(h, 'add', '.'); git(h, 'commit', '-m', 'one');
  git(h, 'remote', 'add', 'origin', 'git@github.com:someone/harness.git');
  git(h, 'push', remote, 'main');
  git(h, 'fetch', remote, 'main:refs/remotes/origin/main'); // what `git push origin` would have recorded
  const env = { ...process.env, HARNESS_DIR: h };
  const run = (script, ...a) => spawnSync(join(repo, 'scripts', script), a, { cwd: repo, encoding: 'utf8', env });
  return { root, repo, h, run, lock: () => readFileSync(join(repo, 'sandbox', 'harness.lock'), 'utf8'), staged: (f) => join(repo, 'sandbox', '.harness-src', f) };
}

test('--update pins HEAD with dirty=no, a version, an https repo url and a content hash; --check then passes', () => {
  const w = world();
  const r = w.run('harness-lock.sh', '--update');
  assert.equal(r.status, 0, r.stderr);
  const lock = w.lock();
  assert.match(lock, /^repo=https:\/\/github\.com\/someone\/harness\.git$/m);
  assert.match(lock, new RegExp(`^commit=${git(w.h, 'rev-parse', 'HEAD')}$`, 'm'));
  assert.match(lock, /^dirty=no$/m);
  assert.match(lock, /^version=1\.2\.3$/m);
  assert.match(lock, /^source_hash=[0-9a-f]{64}$/m);
  assert.equal(w.run('harness-lock.sh', '--check').status, 0);
});

test('--update refuses a checkout with uncommitted changes and writes no lock', () => {
  const w = world();
  writeFileSync(join(w.h, 'package.json'), '{"name":"edited"}\n');
  const r = w.run('harness-lock.sh', '--update');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uncommitted changes/);
  assert.ok(!existsSync(join(w.repo, 'sandbox', 'harness.lock')));
});

test('--allow-dirty records dirty=yes, and --check refuses such a lock', () => {
  const w = world();
  writeFileSync(join(w.h, 'package.json'), '{"name":"edited"}\n');
  assert.equal(w.run('harness-lock.sh', '--update', '--allow-dirty').status, 0);
  assert.match(w.lock(), /^dirty=yes$/m);
  const r = w.run('harness-lock.sh', '--check');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty=yes/);
});

test('--update refuses a commit that no remote branch contains (CI could not fetch it)', () => {
  const w = world();
  writeFileSync(join(w.h, 'new.txt'), 'x\n'); git(w.h, 'add', '.'); git(w.h, 'commit', '-m', 'local only');
  const r = w.run('harness-lock.sh', '--update');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /on no remote branch/);
  assert.equal(w.run('harness-lock.sh', '--update', '--allow-unpushed').status, 0);
});

test('--check ignores the working tree: edits and untracked files after the lock do not matter, a changed lock does', () => {
  const w = world();
  assert.equal(w.run('harness-lock.sh', '--update').status, 0);
  writeFileSync(join(w.h, 'package.json'), '{"name":"edited later"}\n');
  writeFileSync(join(w.h, 'stray.txt'), 'x\n');
  assert.equal(w.run('harness-lock.sh', '--check').status, 0, 'the commit is what is checked');
  const lockFile = join(w.repo, 'sandbox', 'harness.lock');
  writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace(/^source_hash=.*/m, `source_hash=${'0'.repeat(64)}`));
  const r = w.run('harness-lock.sh', '--check');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /source_hash differs/);
});

test('--check says what to do when the locked commit is not in the checkout', () => {
  const w = world();
  assert.equal(w.run('harness-lock.sh', '--update').status, 0);
  const lockFile = join(w.repo, 'sandbox', 'harness.lock');
  writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace(/^commit=.*/m, `commit=${'a'.repeat(40)}`));
  const r = w.run('harness-lock.sh', '--check');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not in .*fetch it/);
});

test('--commit staging takes committed files only: an untracked secret file in the checkout is not staged, and the working-tree mode would stage it', () => {
  const w = world();
  const sha = git(w.h, 'rev-parse', 'HEAD');
  writeFileSync(join(w.h, 'secret.env'), 'TOKEN=do-not-ship\n');
  writeFileSync(join(w.h, 'package.json'), '{"name":"edited"}\n');
  assert.equal(w.run('stage-harness.sh', '--commit', sha).status, 0);
  assert.ok(!existsSync(w.staged('secret.env')), 'untracked file left out');
  assert.equal(readFileSync(w.staged('package.json'), 'utf8'), '{"name":"h"}\n', 'the committed content, not the edit');
  assert.match(readFileSync(w.staged('.staged-from'), 'utf8'), /^dirty=no$/m);
  assert.equal(w.run('stage-harness.sh').status, 0);
  assert.ok(existsSync(w.staged('secret.env')), 'development staging does include it (that is why releases do not use it)');
  assert.match(readFileSync(w.staged('.staged-from'), 'utf8'), /^dirty=yes$/m);
});

test('--commit refuses anything but a full commit id', () => {
  const w = world();
  for (const bad of ['HEAD', 'abc123', '../x', `${'g'.repeat(40)}`]) {
    const r = w.run('stage-harness.sh', '--commit', bad);
    assert.notEqual(r.status, 0, bad);
  }
});

test('the committed sandbox/harness.lock is clean (dirty=no), has a repo url and a full commit', () => {
  const lock = readFileSync(join(ROOT, 'sandbox', 'harness.lock'), 'utf8');
  assert.match(lock, /^dirty=no$/m, 'commit the harness edits, push them, then scripts/harness-lock.sh --update');
  assert.match(lock, /^repo=https:\/\/\S+$/m);
  assert.match(lock, /^commit=[0-9a-f]{40}$/m);
});
