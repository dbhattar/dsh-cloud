// E2: scripts/backup.sh and scripts/restore.sh against a live stack: the backup verifies itself, damage is detected,
// restore refuses while the stack runs, and a real restore brings back accounts and workspace files.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNoDevData, compose, removeUserVolumes, request, ROOT, sh, signupUser, userVolumes, waitFor, waitSandboxUp } from '../lib/helpers.mjs';

const FILE = 'docker-compose.gateway.yml';
const run = randomBytes(3).toString('hex');
const ENV = {
  SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runc',
  ALLOW_SIGNUP: 'true',
  UPSTREAM_API_KEY: 'phase4-placeholder',
  LLM_ADMIN_SECRET: randomBytes(16).toString('hex'),
  RUNNER_SECRET: randomBytes(16).toString('hex'),
};
const users = {};
let owned = false;
let outDir;
let backupDir;

const docker = (...a) => sh('docker', a).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const script = (name, ...args) => spawnSync(join(ROOT, 'scripts', name), args, { encoding: 'utf8', env: { ...process.env, ...ENV } });
const login = async (u) => (await request('/gw/login', { method: 'POST', body: { email: u.email, password: 'test-password-123' } })).status;

before(async () => {
  assertNoDevData();
  owned = true;
  outDir = mkdtempSync(join(tmpdir(), 'dsh-backup-test-'));
  compose(FILE, ['up', '-d', '--build'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway healthz' });
  users.a = await signupUser('a', run);
  await waitSandboxUp(users.a);
  docker('exec', users.a.container, 'sh', '-c', 'echo precious > /workspace/precious.txt');
});

after(() => {
  if (!owned) return;
  for (const u of Object.values(users)) {
    tryDocker('rm', '-f', u.container);
    removeUserVolumes(u.id);
    tryDocker('network', 'rm', `dsh-net-${u.id}`);
  }
  compose(FILE, ['down', '-v'], ENV);
  rmSync(outDir, { recursive: true, force: true });
});

test('backup.sh writes both databases, every user volume and a manifest, and its own restore check passes', () => {
  const r = script('backup.sh', '--out', outDir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Restore check passed/);
  backupDir = r.stdout.match(/Backup complete: (.+)/)[1].trim();
  for (const f of ['gateway.db', 'llm-proxy.db', 'MANIFEST', ...userVolumes(users.a.id).map((v) => `volumes/${v}.tar.gz`)]) assert.ok(existsSync(join(backupDir, f)), f);
  const manifest = readFileSync(join(backupDir, 'MANIFEST'), 'utf8');
  assert.match(manifest, new RegExp(`counts\\.gateway=\\{"integrity":"ok","tables":\\{.*"users":[1-9]`));
  assert.match(manifest, /^owner\.llm-proxy=1000:1000$/m, 'who owns the data is recorded, so a restore into a new volume can give it back');
  assert.match(manifest, /^owner\.gateway=\d+:\d+$/m);
  assert.ok(!existsSync(join(backupDir, '.owners')), 'no temporary file left behind');
  assert.ok(!manifest.includes('test-password-123'));
});

test('a damaged or incomplete backup fails the restore check', () => {
  const bad = join(outDir, 'bad');
  cpSync(backupDir, bad, { recursive: true });
  const db = readFileSync(join(bad, 'gateway.db'));
  db[100] ^= 0xff;
  writeFileSync(join(bad, 'gateway.db'), db);
  assert.notEqual(script('restore.sh', '--check', bad).status, 0, 'a flipped byte');
  const missing = join(outDir, 'missing');
  cpSync(backupDir, missing, { recursive: true });
  rmSync(join(missing, 'volumes', `${userVolumes(users.a.id).find((n) => n.startsWith('dsh-ws-'))}.tar.gz`));
  assert.notEqual(script('restore.sh', '--check', missing).status, 0, 'a missing archive');
  assert.equal(tryDocker('volume', 'ls', '-q', '--filter', 'name=dsh-restorecheck-'), '', 'scratch volumes are removed even on failure');
});

const hasAge = spawnSync('age-keygen', ['--version'], { encoding: 'utf8' }).status === 0;
test('SEC-13: an encrypted backup is owner-only, holds no plaintext, and restores (--check) only with the private key', { skip: hasAge ? false : 'age is not installed (apt install age)' }, () => {
  const keyFile = join(outDir, 'age.key');
  const gen = spawnSync('age-keygen', ['-o', keyFile], { encoding: 'utf8' });
  const pub = /(age1[a-z0-9]+)/.exec(gen.stderr + gen.stdout)[1];
  const r = script('backup.sh', '--out', outDir, '--encrypt-to', pub);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const enc = r.stdout.match(/Backup complete: (.+)/)[1].trim();
  assert.match(enc, /\.tar\.age$/);
  assert.equal(statSync(enc).mode & 0o777, 0o600);
  assert.ok(!existsSync(enc.replace(/\.tar\.age$/, '')), 'the plaintext directory is gone');
  assert.ok(!readFileSync(enc).includes('SQLite format 3'), 'no database header in the clear');
  const ok = script('restore.sh', '--check', enc, '--identity', keyFile);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const other = join(outDir, 'other.key'); spawnSync('age-keygen', ['-o', other]);
  assert.notEqual(script('restore.sh', '--check', enc, '--identity', other).status, 0, 'another key cannot open it');
});

test('restore --yes refuses while the stack or a sandbox is running', () => {
  const r = script('restore.sh', '--yes', backupDir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /running/);
});

test('a real restore brings back accounts and workspace files and drops what came after the backup', async () => {
  users.late = await signupUser('late', run); // created after the backup
  docker('exec', users.a.container, 'rm', '-f', '/workspace/precious.txt');
  compose(FILE, ['down'], ENV);
  for (const id of tryDocker('ps', '-aq', '--filter', 'label=dsh-cloud.user').split('\n').filter(Boolean)) tryDocker('rm', '-f', id); // every sandbox, not only ours
  const r = script('restore.sh', '--yes', backupDir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  compose(FILE, ['up', '-d'], ENV);
  await waitFor(async () => (await request('/gw/healthz')).status === 200, { what: 'gateway after restore' });
  assert.equal(await login(users.a), 303, 'the account from the backup works');
  assert.equal(await login(users.late), 401, 'an account created after the backup is gone');
  const cookie = String((await request('/gw/login', { method: 'POST', body: { email: users.a.email, password: 'test-password-123' } })).headers['set-cookie']).split(';')[0];
  users.a.cookie = cookie;
  await waitSandboxUp(users.a);
  assert.equal(docker('exec', users.a.container, 'cat', '/workspace/precious.txt'), 'precious', 'the deleted workspace file is back');
});
