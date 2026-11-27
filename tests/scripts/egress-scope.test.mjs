// scripts/egress-scope.sh: it edits one line of the env file, validates with the proxy's own rules, and applies by recreating the proxy.
// A stub `docker`; the real Node runs the entry check. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/egress-scope.sh', import.meta.url));
const OTHER = ['UPSTREAM_API_KEY=sk-not-a-real-key-0123456789', 'LLM_ADMIN_SECRET=abc123', '# a comment that must survive', 'IDLE_SECONDS=900', ''];

function setup({ envFile = OTHER.join('\n'), running = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-scope-'));
  const env = join(dir, 'env');
  if (envFile !== null) writeFileSync(env, envFile);
  const log = join(dir, 'calls.log');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"ps -q egress-proxy"*) echo abc123 ;;
  "inspect "*) printf 'PATH=/bin\\n${running ? `EGRESS_ALLOW_HOSTS=${running}\\n` : ''}ALLOWED_PORTS=80,443\\n' ;;
esac
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } };
  const run = (...args) => {
    const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, DSH_ENV_FILE: env } });
    return { status: r.status, out: r.stdout, err: r.stderr, calls: calls(), env: () => readFileSync(env, 'utf8') };
  };
  return { run, env: () => readFileSync(env, 'utf8') };
}

test('help prints the usage only; no mode, an unknown option and a missing env file are refused', () => {
  const s = setup();
  const h = s.run('--help');
  assert.equal(h.status, 0);
  assert.match(h.out, /Show or change which sites/);
  assert.ok(!/set -eu/.test(h.out));
  assert.equal(s.run().status, 2);
  assert.equal(s.run('--nope').status, 2);
  assert.equal(s.run('--set').status, 2, '--set needs a list');
  const none = setup({ envFile: null }).run('--show');
  assert.equal(none.status, 1);
  assert.match(none.err, /no env file/);
});

test('--set: validates with the proxy\'s rules, writes only its own line, keeps everything else byte for byte, and recreates the proxy', () => {
  const s = setup();
  const r = s.run('--set', ' Staging.Example.org, *.api.example.org ');
  assert.equal(r.status, 0, r.err);
  const lines = s.env().split('\n');
  assert.ok(lines.includes('EGRESS_ALLOW_HOSTS=Staging.Example.org,*.api.example.org'), 'spaces removed; the proxy lower-cases on read');
  for (const keep of OTHER.filter(Boolean)) assert.ok(lines.includes(keep), `kept: ${keep}`);
  assert.match(r.out, /scoped: Staging\.Example\.org,\*\.api\.example\.org \(plus the base list\)/);
  assert.ok(!r.out.includes('sk-not-a-real-key'), 'other lines of the env file are never printed');
  assert.ok(r.calls.some((c) => /^compose --env-file .* -f infra\/docker-compose\.gateway\.yml up -d --no-deps --force-recreate egress-proxy$/.test(c)));
  assert.match(r.out, /applied/);
});

test('--set again replaces the line instead of adding a second one', () => {
  const s = setup({ envFile: `${OTHER.join('\n')}EGRESS_ALLOW_HOSTS=old.example.org\n` });
  assert.equal(s.run('--set', 'new.example.org', '--no-apply').status, 0);
  const matches = s.env().split('\n').filter((l) => l.startsWith('EGRESS_ALLOW_HOSTS='));
  assert.deepEqual(matches, ['EGRESS_ALLOW_HOSTS=new.example.org']);
});

test('--set refuses a bad list and changes nothing: wildcards that are too broad, URLs, ports, empty', () => {
  for (const bad of ['*.com', 'https://example.org', 'example.org:443', 'localhost', 'a b', '*', ' , ']) {
    const s = setup();
    const before = s.env();
    const r = s.run('--set', bad);
    assert.notEqual(r.status, 0, bad);
    assert.equal(s.env(), before, `unchanged for ${JSON.stringify(bad)}`);
    assert.deepEqual(r.calls.filter((c) => c.includes('up -d')), [], 'nothing was recreated');
  }
  assert.match(setup().run('--set', '*.com').err, /EGRESS_ALLOW_HOSTS: "\*\.com" is not usable/);
});

test('--no-apply edits the file and does not touch Docker; --clear removes only the scope line and recreates the proxy', () => {
  const s = setup({ envFile: `${OTHER.join('\n')}EGRESS_ALLOW_HOSTS=a.example.org\n` });
  const n = s.run('--set', 'b.example.org', '--no-apply');
  assert.deepEqual(n.calls, []);
  assert.match(n.out, /not applied/);
  const c = s.run('--clear');
  assert.equal(c.status, 0, c.err);
  assert.ok(!s.env().includes('EGRESS_ALLOW_HOSTS'));
  for (const keep of OTHER.filter(Boolean)) assert.ok(s.env().includes(keep));
  assert.match(c.out, /open: any public host/);
  assert.ok(c.calls.some((x) => x.includes('--force-recreate egress-proxy')));
});

test('--show reports the file and the running proxy, and says when they differ', () => {
  const same = setup({ envFile: 'EGRESS_ALLOW_HOSTS=a.example.org\n', running: 'a.example.org' }).run('--show');
  assert.match(same.out, /env file .*: scoped: a\.example\.org/);
  assert.match(same.out, /running egress proxy: scoped: a\.example\.org/);
  assert.ok(!/differ/.test(same.out));
  const differ = setup({ envFile: 'EGRESS_ALLOW_HOSTS=b.example.org\n', running: 'a.example.org' }).run('--show');
  assert.match(differ.out, /note: they differ/);
  const open = setup({ envFile: 'IDLE_SECONDS=1\n', running: '' }).run('--show');
  assert.match(open.out, /env file .*: open/);
  assert.match(open.out, /running egress proxy: open/);
  assert.deepEqual(open.calls.filter((c) => c.includes('up -d')), []);
});
