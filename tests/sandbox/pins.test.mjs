// E3: what makes a rebuild reproducible. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
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

test('the images workflow: actions pinned by commit, a timeout, the harness fetched at the locked commit and built --locked, pushed by script, never to a floating tag', () => {
  const y = read('.github/workflows/images.yml');
  for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `action not pinned by commit: ${m[1]}`);
  assert.match(y, /timeout-minutes:/);
  assert.match(y, /ref: \$\{\{ steps\.lock\.outputs\.commit \}\}/);
  assert.match(y, /scripts\/build-harness\.sh --locked/);
  assert.match(y, /scripts\/publish-images\.sh --registry/);
  assert.match(y, /persist-credentials: false/);
  assert.doesNotMatch(y, /:latest/);
  assert.doesNotMatch(y, /pull_request/, 'nothing that runs on a pull request may push images or see the harness token');
});

test('compose takes the five images from the environment (registry digests on a server) and defaults to the local names', () => {
  const yml = read('infra/docker-compose.gateway.yml');
  for (const v of ['GATEWAY_IMAGE', 'RUNNER_IMAGE', 'LLM_PROXY_IMAGE', 'EGRESS_PROXY_IMAGE']) assert.match(yml, new RegExp(`image: \\$\\{${v}:-dshcloud-[a-z-]+:latest\\}`), v);
  assert.match(yml, /image: \$\{SANDBOX_IMAGE:-dsh-sandbox:latest\}/);
  assert.match(yml, /SANDBOX_IMAGE: \$\{SANDBOX_IMAGE:-dsh-sandbox:latest\}/);
});

test('the sandbox image refuses a harness that was not built from a commit when asked to', () => {
  const d = read('sandbox/Dockerfile');
  assert.match(d, /ARG REQUIRE_CLEAN_HARNESS=0\nRUN \[ "\$REQUIRE_CLEAN_HARNESS" = 0 \] \|\| grep -qx 'dirty=no' \/opt\/dsh\/BUILD_INFO/);
});

test('the pin check exempts only our own five locally built images: a floating base in a compose image variable still fails', () => {
  const copy = mkdtempSync(join(tmpdir(), 'pins-'));
  cpSync(join(ROOT, 'scripts'), join(copy, 'scripts'), { recursive: true });
  mkdirSync(join(copy, 'infra'));
  writeFileSync(join(copy, 'infra', 'docker-compose.x.yml'), 'services:\n  a:\n    image: ${GATEWAY_IMAGE:-dshcloud-gateway:latest}\n  b:\n    image: ${OTHER_IMAGE:-node:latest}\n');
  const r = spawnSync(join(copy, 'scripts/pin-images.sh'), ['--check'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /OTHER_IMAGE/);
  assert.doesNotMatch(r.stderr, /GATEWAY_IMAGE/);
});

test('build-harness.sh copies the build out of an image, not with the local exporter that stalled on this tree, and stages the locked commit when --locked', () => {
  const s = read('scripts/build-harness.sh').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(s, /--output/);
  assert.match(s, /docker cp "\$CID:\/\." "\$OUT\.tmp"/);
  assert.match(s, /stage-harness\.sh --commit "\$\(sed -n 's\/\^commit=\/\/p' sandbox\/harness\.lock\)"/);
});
