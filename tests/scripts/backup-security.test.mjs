// SEC-13 (docs/security-review.md): backups are owner-only, kept outside the checkout, optionally encrypted, pruned by age, and an
// encrypted one is decrypted into a private directory that is removed again. Uses a stub `docker` (no volumes) and a stub `age`; the real
// round trip with Docker and age is in tests/phase4/backup.test.mjs. No Docker needed here.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const KEY = `age1${'q'.repeat(58)}`;

function world({ withAge = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bk-')); dirs.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const home = join(root, 'home'); mkdirSync(home);
  const tmp = join(root, 'tmp'); mkdirSync(tmp);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
case "$1" in info) exit 0 ;; context) echo stub ;; volume) case "$2" in inspect) exit 1 ;; esac ;; esac
exit 0
`);
  // A reversible stand-in for age: the "ciphertext" starts with the recipient, and decrypting needs an identity file naming it.
  writeFileSync(join(bin, 'age'), `#!/bin/sh
mode=enc; out=""; rec=""; id=""
while [ $# -gt 0 ]; do case "$1" in -d) mode=dec; shift ;; -o) out="$2"; shift 2 ;; -r) rec="$2"; shift 2 ;; -R) rec="file:$(cat "$2")"; shift 2 ;; -i) id="$2"; shift 2 ;; *) file="$1"; shift ;; esac; done
if [ $mode = enc ]; then { echo "STUBAGE $rec"; cat; } > "$out"; else
  [ "$(sed -n 1p "$file")" = "STUBAGE $(cat "$id")" ] || { echo "no identity matched" >&2; exit 1; }
  sed 1d "$file"; fi
`);
  chmodSync(join(bin, 'docker'), 0o755); chmodSync(join(bin, 'age'), 0o755);
  const path = withAge ? `${bin}:${process.env.PATH}` : `${join(root, 'bin-noage')}:${process.env.PATH}`;
  if (!withAge) { mkdirSync(join(root, 'bin-noage')); writeFileSync(join(root, 'bin-noage', 'docker'), readFileSync(join(bin, 'docker'))); chmodSync(join(root, 'bin-noage', 'docker'), 0o755); }
  const env = { ...process.env, PATH: path, HOME: home, TMPDIR: tmp, DSH_BACKUP_DIR: '', DSH_BACKUP_RECIPIENT: '' };
  const run = (script, args, extra = {}) => spawnSync(join(ROOT, 'scripts', script), args, { encoding: 'utf8', env: { ...env, ...extra } });
  return { root, home, tmp, run };
}
const mode = (p) => statSync(p).mode & 0o777;
const stamp = (r) => r.stdout.match(/Backup complete: (.+)/)[1].trim();

test('by default a backup goes to ~/dsh-backups, owner-only, with a warning that it is not encrypted', () => {
  const w = world();
  const r = w.run('backup.sh', ['--no-verify']);
  assert.equal(r.status, 0, r.stderr);
  const dest = stamp(r);
  assert.equal(dest.startsWith(join(realpathSync(w.home), 'dsh-backups') + '/'), true, dest);
  assert.equal(mode(join(w.home, 'dsh-backups')), 0o700);
  assert.equal(mode(dest), 0o700);
  assert.equal(mode(join(dest, 'MANIFEST')), 0o600);
  assert.match(r.stderr, /NOT encrypted/);
});

test('a backup directory inside this checkout is refused and not left behind', () => {
  const w = world();
  const inside = join(ROOT, 'backups-sec13-probe');
  try {
    const r = w.run('backup.sh', ['--out', inside]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /inside the checkout/);
    assert.ok(!existsSync(inside), 'the directory it made is removed again');
  } finally { rmSync(inside, { recursive: true, force: true }); }
});

test('--encrypt-to writes dsh-STAMP.tar.age owner-only and removes the plaintext; the key must be an age public key', () => {
  const w = world();
  const r = w.run('backup.sh', ['--no-verify', '--encrypt-to', KEY]);
  assert.equal(r.status, 0, r.stderr);
  const out = stamp(r);
  assert.match(out, /dsh-\d{8}-\d{6}\.tar\.age$/);
  assert.equal(mode(out), 0o600);
  assert.deepEqual(readdirSync(join(w.home, 'dsh-backups')).filter((f) => !f.endsWith('.age')), [], 'no plaintext directory left');
  assert.doesNotMatch(r.stderr, /NOT encrypted/);
  for (const bad of ['--out', '-r', 'age1short', 'age1' + 'Q'.repeat(58), `${KEY};rm`]) assert.equal(w.run('backup.sh', ['--encrypt-to', bad]).status, 2, bad);
});

test('asking for encryption without age installed refuses instead of writing plaintext', () => {
  const w = world({ withAge: false });
  if (spawnSync('sh', ['-c', 'PATH=/usr/bin:/bin command -v age']).status === 0) return; // a real age is on the system PATH: cannot hide it
  const r = w.run('backup.sh', ['--no-verify', '--encrypt-to', KEY]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /age is not installed/);
  assert.equal(existsSync(join(w.home, 'dsh-backups')), false);
});

test('--keep-days removes older backups (plain or encrypted) and keeps newer ones and files that are not backups', () => {
  const w = world();
  const dir = join(w.home, 'dsh-backups'); mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 40 * 86400e3);
  for (const n of ['dsh-20200101-000000', 'dsh-20200102-000000.tar.age']) { const p = join(dir, n); n.endsWith('.age') ? writeFileSync(p, 'x') : mkdirSync(p); utimesSync(p, old, old); }
  writeFileSync(join(dir, 'unrelated.txt'), 'keep me'); utimesSync(join(dir, 'unrelated.txt'), old, old);
  const r = w.run('backup.sh', ['--no-verify', '--keep-days', '30']);
  assert.equal(r.status, 0, r.stderr);
  const left = readdirSync(dir);
  assert.ok(!left.includes('dsh-20200101-000000') && !left.includes('dsh-20200102-000000.tar.age'), left.join());
  assert.ok(left.includes('unrelated.txt'), 'only backups are pruned');
  assert.equal(left.filter((f) => /^dsh-\d{8}-\d{6}$/.test(f)).length, 1, 'the new one stays');
  assert.equal(w.run('backup.sh', ['--keep-days', 'x']).status, 2);
});

test('an encrypted backup restores through --check with the right key, fails with another, and leaves no plaintext in TMPDIR', () => {
  const w = world();
  const out = stamp(w.run('backup.sh', ['--no-verify', '--encrypt-to', KEY]));
  const good = join(w.root, 'good.key'); writeFileSync(good, KEY);
  const bad = join(w.root, 'bad.key'); writeFileSync(bad, 'someone-else');
  let r = w.run('restore.sh', ['--check', out, '--identity', good]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Restore check passed/);
  r = w.run('restore.sh', ['--check', out, '--identity', bad]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not decrypt/);
  r = w.run('restore.sh', ['--check', out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--identity/);
  assert.deepEqual(readdirSync(w.tmp), [], 'the private temporary directory is removed in every case');
});

test('an encrypted archive with a member outside its backup directory is refused before extraction', () => {
  const w = world();
  const stage = join(w.root, 'stage'); mkdirSync(join(stage, 'dsh-20260101-000000'), { recursive: true });
  writeFileSync(join(stage, 'dsh-20260101-000000', 'MANIFEST'), 'project=x\n'); writeFileSync(join(stage, 'evil'), 'x');
  const tar = join(w.root, 'evil.tar');
  assert.equal(spawnSync('tar', ['-cf', tar, '-C', stage, 'dsh-20260101-000000', 'evil']).status, 0);
  const enc = join(w.root, 'dsh-20260101-000000.tar.age');
  writeFileSync(enc, `STUBAGE ${KEY}\n${readFileSync(tar, 'latin1')}`, 'latin1');
  const key = join(w.root, 'k'); writeFileSync(key, KEY);
  const r = w.run('restore.sh', ['--check', enc, '--identity', key]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /outside its backup directory/);
  assert.deepEqual(readdirSync(w.tmp), []);
});
