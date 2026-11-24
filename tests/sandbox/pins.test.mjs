// E3: what makes a rebuild reproducible. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('every base image in the Dockerfiles and compose files is pinned by tag and digest', () => {
  const out = execFileSync(join(ROOT, 'scripts/pin-images.sh'), ['--check'], { encoding: 'utf8' });
  assert.match(out, /images are pinned by digest/);
});

test('the pin check fails on a floating tag', () => {
  const copy = mkdtempSync(join(tmpdir(), 'pins-'));
  cpSync(join(ROOT, 'scripts'), join(copy, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'runner'), join(copy, 'runner'), { recursive: true });
  const f = join(copy, 'runner', 'Dockerfile');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/FROM node:[^ \n]+/, 'FROM node:24-slim'));
  const r = spawnSync(join(copy, 'scripts/pin-images.sh'), ['--check'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /runner\/Dockerfile: node:24-slim/);
});

test('all service images share one Node base, and CI uses the same Node version', () => {
  const froms = ['runner', 'gateway', 'llm-proxy', 'egress-proxy', 'sandbox']
    .flatMap((d) => [...read(`${d}/Dockerfile`).matchAll(/^FROM (node:[^ \n]+)/gm)].map((m) => m[1]));
  assert.equal(new Set(froms).size, 1, `one pinned Node base everywhere: ${[...new Set(froms)]}`);
  const version = /node:(\d+\.\d+\.\d+)-slim@/.exec(froms[0])[1];
  assert.match(read('.github/workflows/ci.yml'), new RegExp(`node-version: ${version.replace(/\./g, '\\.')}`));
});

test('sandbox/harness.lock records commit, version and a content hash', () => {
  const lock = read('sandbox/harness.lock');
  assert.match(lock, /^commit=[0-9a-f]{40}$/m);
  assert.match(lock, /^source_hash=[0-9a-f]{64}$/m);
  assert.match(lock, /^version=\S+$/m);
});

test('CI pins its actions by commit and runs the unit suites; every workflow job has a timeout', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const m of ci.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `action not pinned by commit: ${m[1]}`);
  assert.match(ci, /tests\/run\.sh unit/);
  const jobs = ci.slice(ci.indexOf('\njobs:')).split(/^  (?=[a-z]+:[ \t]*\n)/m).slice(1);
  assert.ok(jobs.length >= 4);
  for (const j of jobs) assert.match(j, /timeout-minutes:/, j.split('\n')[0]);
  assert.ok(readdirSync(join(ROOT, '.github')).includes('dependabot.yml'));
});
