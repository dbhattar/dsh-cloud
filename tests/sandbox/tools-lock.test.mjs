// sandbox/tools.lock, scripts/pin-tools.sh and sandbox/install-tools.sh: the lock is well formed, a bad lock is refused, the installer
// verifies every download and installs only for its architecture, and --update only accepts what the project itself publishes. Stub
// `curl` and `sha256sum`; no network, no Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PIN = join(ROOT, 'scripts/pin-tools.sh');
const INSTALL = join(ROOT, 'sandbox/install-tools.sh');
const REAL_LOCK = join(ROOT, 'sandbox/tools.lock');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const REL = 'https://github.com/acme/widget/releases/download/v1.0.0';
const entry = (tool, arch, hash, file = `${tool}_${arch}.zip`, version = '1.0.0') => `${tool} ${version} ${arch} ${hash} ${REL.replace('v1.0.0', `v${version}`)}/${file} ${REL.replace('v1.0.0', `v${version}`)}/checksums.txt`;
const run = (cmd, args, env = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });

// ---- the real lock ----
test('the shipped lock passes the check, covers the four release tools for both architectures, and the Dockerfile uses it', () => {
  const r = run('sh', [PIN, '--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 tools, each pinned by version and SHA-256 for amd64 and arm64/);
  const lines = readFileSync(REAL_LOCK, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.deepEqual([...new Set(lines.map((l) => l.split(' ')[0]))].sort(), ['gitleaks', 'httpx', 'nuclei', 'osv-scanner']);
  assert.equal(lines.length, 8);
  const docker = readFileSync(join(ROOT, 'sandbox/Dockerfile'), 'utf8');
  assert.match(docker, /COPY tools\.lock install-tools\.sh/);
  assert.match(docker, /install-tools\.sh \/tmp\/tools\/tools\.lock/);
  assert.ok(!/trufflehog|semgrep/.test(docker.replace(/#.*$/gm, '')), 'the tools left out on licence grounds are not installed');
});

// ---- the check refuses a bad lock ----
function lockFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'tools-lock-'));
  const file = join(dir, 'tools.lock');
  writeFileSync(file, `# comment\n\n${lines.join('\n')}\n`);
  return file;
}
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const good = [entry('widget', 'amd64', H1), entry('widget', 'arm64', H2)];

test('check: a well-formed lock passes, comments and blank lines are ignored', () => {
  const r = run('sh', [PIN, '--check'], { TOOLS_LOCK: lockFile(good) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 tools/);
});

test('check: every way a lock can be wrong is refused with a line number and a reason', () => {
  const cases = [
    ['a placeholder hash', [entry('widget', 'amd64', 'PENDING'), good[1]], /not a 64-character hash/],
    ['a short hash', [entry('widget', 'amd64', 'abc123'), good[1]], /not a 64-character hash/],
    ['an uppercase hash', [entry('widget', 'amd64', 'A'.repeat(64)), good[1]], /not a 64-character hash/],
    ['a missing field', ['widget 1.0.0 amd64 ' + H1], /expected 6 fields/],
    ['an unknown architecture', [entry('widget', 'riscv', H1), good[1]], /architecture must be amd64 or arm64/],
    ['a non-github url', [good[0].replace('https://github.com', 'https://evil.example'), good[1]], /url must be a github\.com release download/],
    ['plain http', [good[0].replace(/ https:/, ' http:'), good[1]], /url must be a github\.com release download/],
    ['a url that is not a release download', [good[0].replace('/releases/download/', '/archive/'), good[1]], /url must be a github\.com release download/],
    ['a non-github checksums url', [good[0].replace('/checksums.txt', '/x').replace(/ https:\/\/github\.com([^ ]*)$/, ' https://evil.example$1'), good[1]], /checksums-url must be a github\.com release download/],
    ['a version missing from its url', [entry('widget', 'amd64', H1, 'widget_other.zip').replace('v1.0.0', 'v2.0.0'), good[1]], /does not contain its version/],
    ['one architecture only', [good[0]], /needs both amd64 and arm64/],
    ['different versions per architecture', [good[0], entry('widget', 'arm64', H2, 'widget_arm64.zip', '2.0.0')], /different versions/],
    ['a duplicate', [good[0], good[0], good[1]], /duplicate entry/],
    ['a bad tool name', [entry('Widget', 'amd64', H1), entry('Widget', 'arm64', H2)], /bad tool name/],
    ['nothing at all', [], /no tools listed/],
  ];
  for (const [what, lines, message] of cases) {
    const r = run('sh', [PIN, '--check'], { TOOLS_LOCK: lockFile(lines) });
    assert.notEqual(r.status, 0, what);
    assert.match(r.stderr, message, what);
  }
  assert.notEqual(run('sh', [PIN, '--check'], { TOOLS_LOCK: '/no/such/lock' }).status, 0);
  assert.equal(run('sh', [PIN, '--nope']).status, 2);
});

// ---- stubs for curl and sha256sum ----
/** A fake `curl` that "downloads" files from a fixtures directory by name, and a `sha256sum` for hosts that only have shasum. */
function stubs(fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'stubs-'));
  writeFileSync(join(dir, 'curl'), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
f="${fixtures}/\${url##*/}"
[ -f "$f" ] || { echo "stub curl: no fixture for $url" >&2; exit 22; }
cp "$f" "$out"
`);
  writeFileSync(join(dir, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n');
  chmodSync(join(dir, 'curl'), 0o755);
  chmodSync(join(dir, 'sha256sum'), 0o755);
  return dir;
}
function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'fixtures-'));
  const stage = join(dir, 'stage');
  mkdirSync(stage);
  // zip with a file named after the tool, tar.gz likewise, and a raw binary
  writeFileSync(join(stage, 'zipped'), '#!/bin/sh\necho zipped\n');
  spawnSync('zip', ['-q', '-j', join(dir, 'zipped_amd64.zip'), join(stage, 'zipped')]);
  spawnSync('zip', ['-q', '-j', join(dir, 'zipped_arm64.zip'), join(stage, 'zipped')]);
  writeFileSync(join(stage, 'tarred'), '#!/bin/sh\necho tarred\n');
  spawnSync('tar', ['-czf', join(dir, 'tarred_amd64.tar.gz'), '-C', stage, 'tarred']);
  spawnSync('tar', ['-czf', join(dir, 'tarred_arm64.tar.gz'), '-C', stage, 'tarred']);
  writeFileSync(join(dir, 'raw_amd64'), '#!/bin/sh\necho raw-amd64\n');
  writeFileSync(join(dir, 'raw_arm64'), '#!/bin/sh\necho raw-arm64\n');
  writeFileSync(join(stage, 'wrongname'), 'x');
  spawnSync('zip', ['-q', '-j', join(dir, 'broken_amd64.zip'), join(stage, 'wrongname')]);
  spawnSync('zip', ['-q', '-j', join(dir, 'broken_arm64.zip'), join(stage, 'wrongname')]);
  return dir;
}
const hashOf = (dir, name) => sha(readFileSync(join(dir, name)));
const lines = (dir, tools) => tools.flatMap(([tool, file]) => ['amd64', 'arm64'].map((arch) => entry(tool, arch, hashOf(dir, file.replace('ARCH', arch)), file.replace('ARCH', arch))));

test('installer: zip, tar.gz and raw binaries are installed executable, only for the requested architecture, each verified', () => {
  const fx = fixtures();
  const lock = lockFile(lines(fx, [['zipped', 'zipped_ARCH.zip'], ['tarred', 'tarred_ARCH.tar.gz'], ['raw', 'raw_ARCH']]));
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  const env = { PATH: `${stubs(fx)}:${process.env.PATH}`, TOOLS_DEST: dest, TOOLS_ARCH: 'arm64' };
  const r = run('sh', [INSTALL, lock], env);
  assert.equal(r.status, 0, r.stderr);
  for (const t of ['zipped', 'tarred', 'raw']) {
    assert.ok(existsSync(join(dest, t)), t);
    assert.ok((statSync(join(dest, t)).mode & 0o111) !== 0, `${t} is executable`);
  }
  assert.match(run(join(dest, 'raw'), []).stdout, /raw-arm64/, 'the arm64 build, not the amd64 one');
  const dest2 = mkdtempSync(join(tmpdir(), 'dest-'));
  assert.equal(run('sh', [INSTALL, lock], { ...env, TOOLS_DEST: dest2, TOOLS_ARCH: 'amd64' }).status, 0);
  assert.match(run(join(dest2, 'raw'), []).stdout, /raw-amd64/);
});

test('installer: a download that is not what the lock pins fails the build and installs nothing; so do a missing binary, an unknown architecture and an empty result', () => {
  const fx = fixtures();
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  const env = { PATH: `${stubs(fx)}:${process.env.PATH}`, TOOLS_DEST: dest, TOOLS_ARCH: 'arm64' };
  // a replaced release: the file on the server is not the one that was hashed
  const tampered = lockFile([entry('raw', 'amd64', H1, 'raw_amd64'), entry('raw', 'arm64', H1, 'raw_arm64')]);
  const t = run('sh', [INSTALL, tampered], env);
  assert.notEqual(t.status, 0);
  assert.match(t.stderr, /the download is [0-9a-f]{64} but the lock pins a{64}/);
  assert.equal(existsSync(join(dest, 'raw')), false, 'nothing was installed');
  const noBinary = lockFile(lines(fx, [['broken', 'broken_ARCH.zip']]));
  const n = run('sh', [INSTALL, noBinary], env);
  assert.notEqual(n.status, 0);
  assert.match(n.stderr, /no file named broken in the download/);
  assert.match(run('sh', [INSTALL, lockFile(good)], { ...env, TOOLS_ARCH: 's390x' }).stderr, /unsupported architecture s390x/);
  const empty = lockFile([entry('raw', 'amd64', hashOf(fx, 'raw_amd64'), 'raw_amd64'), entry('raw', 'arm64', hashOf(fx, 'raw_arm64'), 'raw_arm64')].slice(0, 1));
  assert.match(run('sh', [INSTALL, empty], env).stderr, /nothing in .* for arm64/, 'an architecture the lock does not cover is not silently skipped');
  assert.notEqual(run('sh', [INSTALL], env).status, 0, 'a lock path is required');
});

test('--update: writes the hashes the project itself publishes, and refuses a download that disagrees with them or is not listed', () => {
  const fx = fixtures();
  const hashFor = (n) => (existsSync(join(fx, n)) ? hashOf(fx, n) : 'c'.repeat(64));
  const sums = (names, wrong = false) => names.map((n) => `${wrong ? 'f'.repeat(64) : hashFor(n)}  ${n}`).join('\n') + '\n';
  writeFileSync(join(fx, 'checksums.txt'), sums(['raw_amd64', 'raw_arm64']));
  const env = { PATH: `${stubs(fx)}:${process.env.PATH}` };
  const lock = lockFile([entry('raw', 'amd64', 'PENDING', 'raw_amd64'), entry('raw', 'arm64', 'PENDING', 'raw_arm64')]);
  const u = run('sh', [PIN, '--update'], { ...env, TOOLS_LOCK: lock });
  assert.equal(u.status, 0, u.stderr);
  const body = readFileSync(lock, 'utf8');
  assert.ok(body.includes(hashOf(fx, 'raw_amd64')) && body.includes(hashOf(fx, 'raw_arm64')));
  assert.ok(body.startsWith('# comment'), 'comments are kept');
  assert.equal(run('sh', [PIN, '--check'], { TOOLS_LOCK: lock }).status, 0);
  assert.equal(run('sh', [PIN, '--verify'], { ...env, TOOLS_LOCK: lock }).status, 0, 'the lock matches the releases');
  // the lock says one thing, the release another
  writeFileSync(join(fx, 'raw_amd64'), 'changed on the server');
  writeFileSync(join(fx, 'checksums.txt'), sums(['raw_amd64', 'raw_arm64']));
  const v = run('sh', [PIN, '--verify'], { ...env, TOOLS_LOCK: lock });
  assert.notEqual(v.status, 0);
  assert.match(v.stderr, /the lock says [0-9a-f]{64} but the release is [0-9a-f]{64}/);
  // the project's own checksums disagree with the file: never written
  const before = readFileSync(lock, 'utf8');
  writeFileSync(join(fx, 'checksums.txt'), sums(['raw_amd64', 'raw_arm64'], true));
  const bad = run('sh', [PIN, '--update'], { ...env, TOOLS_LOCK: lock });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /but the project publishes f{64}/);
  assert.equal(readFileSync(lock, 'utf8'), before, 'the lock is untouched after a failure');
  // the file is not in the project's list at all
  writeFileSync(join(fx, 'checksums.txt'), sums(['something_else']));
  assert.match(run('sh', [PIN, '--update'], { ...env, TOOLS_LOCK: lock }).stderr, /is not listed in/);
  assert.equal(readFileSync(lock, 'utf8'), before);
});
