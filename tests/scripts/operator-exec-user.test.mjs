// SEC-10 follow-up: the gateway runs as the unprivileged `node` user and owns its database, so an operator script that execs into the
// container must do so as `node`. A plain `docker exec` is root without the capability to write a file owned by node: "attempt to write
// a readonly database". Found by running tests/phase4 on 2026-11-28 after the hardening had shipped. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

test('every operator script that runs the gateway CLI execs as the node user', () => {
  for (const f of ['invite.sh', 'audit.sh', 'make-admin.sh', 'mail-test.sh']) {
    const lines = readFileSync(root(`scripts/${f}`), 'utf8').split('\n').filter((l) => /docker exec\b/.test(l) && !l.trim().startsWith('#'));
    assert.ok(lines.length > 0, f);
    for (const l of lines) assert.match(l, /docker exec -u node /, `${f}: ${l.trim()}`);
  }
});

test('the Docker suites run the gateway CLI as node too', () => {
  for (const f of ['phase4/limits', 'phase5/admin-users', 'phase5/policies', 'phase5/waiting-room', 'phase5/watchdog', 'phase5/busy']) {
    const src = readFileSync(root(`tests/${f}.test.mjs`), 'utf8');
    for (const l of src.split('\n').filter((x) => x.includes('src/cli.js'))) assert.match(l, /'-u', 'node'/, `${f}: ${l.trim().slice(0, 100)}`);
  }
});
