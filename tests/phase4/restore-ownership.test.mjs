// scripts/restore.sh gives restored databases back the right owner. A restore into a volume that does not exist yet used to leave
// it root-owned, and the llm-proxy (which runs as `node`, uid 1000) then crashed with "attempt to write a readonly database".
// Uses throwaway volumes named after a unique compose project, so no real data is touched. Needs a Docker daemon.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../lib/helpers.mjs';

const run = randomBytes(3).toString('hex');
const PROJECT = `dshtest${run}`;
const IMG = process.env.BACKUP_IMAGE ?? 'node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const volumes = [];

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const dockerUp = docker('info').status === 0;
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

after(() => { for (const v of volumes) docker('volume', 'rm', '-f', v); });

/** A minimal backup directory (two SQLite databases and a manifest), optionally recording owners. */
function fakeBackup(owners = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-backup-'));
  mkdirSync(join(dir, 'volumes'));
  const lines = ['created=2026-01-01T00:00:00Z', 'docker_context=test', `project=${PROJECT}`, '# sha256  bytes  file'];
  for (const name of ['gateway', 'llm-proxy']) {
    const file = join(dir, `${name}.db`);
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1);');
    db.close();
    lines.push(`${sha(file)}  ${readFileSync(file).length}  ${name}.db`);
  }
  for (const [k, v] of Object.entries(owners)) lines.push(`${k}=${v}`);
  writeFileSync(join(dir, 'MANIFEST'), lines.join('\n') + '\n');
  return dir;
}

const restore = (dir) => spawnSync(join(ROOT, 'scripts', 'restore.sh'), ['--yes', dir], { encoding: 'utf8' });
const ownerOf = (vol, path = '/data') => docker('run', '--rm', '-v', `${vol}:/data:ro`, IMG, 'stat', '-c', '%u:%g', path).stdout.trim();
/** Write to the restored database as the given user: what the service does on start. */
const writeAs = (vol, user) =>
  docker('run', '--rm', '--user', user, '-v', `${vol}:/data`, IMG, 'node', '--input-type=module', '-e',
    "import { DatabaseSync } from 'node:sqlite'; const d = new DatabaseSync('/data/llm-proxy.db'); d.exec('INSERT INTO t VALUES (2)'); console.log(d.prepare('SELECT COUNT(*) n FROM t').get().n);");

function fresh(name) {
  const vol = `${PROJECT}_${name}-data`;
  volumes.push(vol);
  docker('volume', 'rm', '-f', vol);
  return vol;
}

test('restoring into a volume that does not exist yet: the llm-proxy user can write the database (backup made before owners were recorded)', { skip: !dockerUp && 'no Docker daemon' }, () => {
  const vol = fresh('llm-proxy');
  fresh('gateway');
  const r = restore(fakeBackup());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ownerOf(vol, '/data/llm-proxy.db'), '1000:1000', 'the service default for the llm-proxy');
  const w = writeAs(vol, '1000:1000');
  assert.equal(w.status, 0, w.stderr);
  assert.equal(w.stdout.trim(), '2');
  assert.equal(ownerOf(`${PROJECT}_gateway-data`, '/data/gateway.db'), '0:0', 'the gateway runs as root');
});

test('the owner the manifest recorded is the one applied, to the database and to its directory', { skip: !dockerUp && 'no Docker daemon' }, () => {
  const vol = fresh('llm-proxy');
  fresh('gateway');
  const r = restore(fakeBackup({ 'owner.llm-proxy': '1234:2345', 'dirowner.llm-proxy': '1234:2345', 'owner.gateway': '0:0', 'dirowner.gateway': '0:0' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ownerOf(vol, '/data/llm-proxy.db'), '1234:2345');
  assert.equal(ownerOf(vol, '/data'), '1234:2345');
  assert.match(r.stdout, /llm-proxy\.db -> .*\(owner 1234:2345\)/);
});

test('an existing volume that a service already owns keeps that owner when the backup recorded none', { skip: !dockerUp && 'no Docker daemon' }, () => {
  const vol = fresh('llm-proxy');
  fresh('gateway');
  docker('volume', 'create', vol);
  docker('run', '--rm', '-v', `${vol}:/data`, IMG, 'chown', '4321:4321', '/data');
  const r = restore(fakeBackup());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ownerOf(vol, '/data/llm-proxy.db'), '4321:4321');
});

test('a malformed owner in a manifest is ignored, never run as part of a command', { skip: !dockerUp && 'no Docker daemon' }, () => {
  const vol = fresh('llm-proxy');
  fresh('gateway');
  const r = restore(fakeBackup({ 'owner.llm-proxy': '0:0; touch /data/pwned', 'dirowner.llm-proxy': '$(id)' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(docker('run', '--rm', '-v', `${vol}:/data:ro`, IMG, 'sh', '-c', 'ls /data').stdout.includes('pwned'), false);
  assert.equal(ownerOf(vol, '/data/llm-proxy.db'), '1000:1000', 'fell back to the default');
});

test('a database-only restore is not blocked by running user sandboxes (their volumes are not touched)', { skip: !dockerUp && 'no Docker daemon' }, () => {
  fresh('llm-proxy');
  fresh('gateway');
  const r = restore(fakeBackup());
  assert.equal(r.status, 0, 'refused: ' + r.stderr);
});
