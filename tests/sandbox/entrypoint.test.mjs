// F1: the policy the sandbox entrypoint hands to the harness. Runs entrypoint.sh with a stub `dsh` that
// prints the patch it was given, so no Docker is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRYPOINT = join(ROOT, 'sandbox', 'entrypoint.sh');

function patchFor(env = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'stub-dsh-'));
  // Stub dsh: print the file named after --patch, then exit.
  writeFileSync(join(bin, 'dsh'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --patch ] && cat "$2"; shift; done\n');
  chmodSync(join(bin, 'dsh'), 0o755);
  writeFileSync(join(bin, 'hostname'), '#!/bin/sh\necho 127.0.0.1\n');
  chmodSync(join(bin, 'hostname'), 0o755);
  return execFileSync('sh', [ENTRYPOINT], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, DSH_PUBLIC_URL: 'https://localhost/', DSH_TRUSTED_HOST: 'localhost', DSH_WELCOME_VERSION_FILE: '/nonexistent/welcome-version', ...env },
  });
}

/** Minimal reader for the flat YAML the entrypoint writes: [{ id, text }] per "- id:" block. */
const rows = (yaml) => yaml.split(/^(?=- id: )/m).filter(Boolean).map((text) => ({ id: /^- id: (.+)$/m.exec(text)[1], text }));
const row = (yaml, id) => rows(yaml).find((r) => r.id === id);

test('policy: workspace-write rooted at /workspace, approval on, nothing from the environment can widen it', () => {
  for (const env of [{}, { DSH_PERMISSION_MODE: 'danger-full-access' }]) {
    const y = patchFor(env);
    assert.match(row(y, 'sandbox-policy').text, /mode: workspace-write, workspaceRoot: \/workspace/);
    assert.match(row(y, 'approval').text, /policy: ask/);
  }
});

test('policy: the preset table offers read-only and workspace-write only, and no preset turns approval off', () => {
  const t = row(patchFor(), 'permission').text;
  assert.match(t, /read-only: \{ sandbox: read-only, approval: ask \}/);
  assert.match(t, /workspace-write: \{ sandbox: workspace-write, approval: ask \}/);
  assert.ok(!/danger-full-access/.test(t), 'no danger-full-access preset');
  assert.ok(!/approval: never/.test(t));
});

test('policy: the whole patch never mentions danger-full-access, with or without a model token', () => {
  assert.ok(!/danger-full-access/.test(patchFor()));
  const withModel = patchFor({ LLM_PROXY_TOKEN: 'dshu_x', LLM_BASE_URL: 'http://llm-proxy:8081/v1' });
  assert.ok(!/danger-full-access/.test(withModel));
  assert.ok(row(withModel, 'llm-pi-ai'), 'the model rows are still there');
});

test('every patch row has an id and a config (a malformed row would change a different plugin)', () => {
  for (const r of rows(patchFor())) assert.match(r.text, /^- id: [\w-]+\n  config:/, r.id);
});

// ---- first-run "Preview Notice" ----
const versionFile = (text) => {
  const f = join(mkdtempSync(join(tmpdir(), 'welcome-')), 'WELCOME_NOTICE_VERSION');
  writeFileSync(f, text);
  return f;
};

test('preview notice: the version recorded at image build is written as acknowledged', () => {
  const y = patchFor({ DSH_WELCOME_VERSION_FILE: versionFile('2026-09-28.1\n') });
  assert.match(row(y, 'ui-settings-general').text, /config: \{ welcomeNoticeVersion: "2026-09-28\.1" \}/);
  assert.match(y, /^- id: ui-settings-account$/m, 'the account settings row is still there');
});

test('preview notice: with no version file, or one that is not a plain version string, the row is left out', () => {
  assert.equal(row(patchFor(), 'ui-settings-general'), undefined);
  for (const bad of ['', '\n', '1.0"; evil: true', 'a b', '2026\n- id: other']) {
    assert.equal(row(patchFor({ DSH_WELCOME_VERSION_FILE: versionFile(bad) }), 'ui-settings-general'), undefined, JSON.stringify(bad));
  }
});

test('preview notice: the Dockerfile extracts the version from the real harness source (skipped without a harness build)', (t) => {
  const dist = join(ROOT, 'sandbox', '.harness-dist');
  const source = join(dist, 'packages/client/ui-settings-models/src/onboarding-copy.ts');
  if (!existsSync(source)) return t.skip('no sandbox/.harness-dist');
  const dockerfile = readFileSync(join(ROOT, 'sandbox', 'Dockerfile'), 'utf8');
  const line = /^RUN (v="\$\(sed[\s\S]*?WELCOME_NOTICE_VERSION)$/m.exec(dockerfile.replace(/\\\n/g, ''));
  assert.ok(line, 'the Dockerfile step is present');
  const out = mkdtempSync(join(tmpdir(), 'welcome-out-'));
  execFileSync('sh', ['-c', line[1].replaceAll('/opt/dsh/WELCOME_NOTICE_VERSION', `${out}/v`).replaceAll('/opt/dsh/', `${dist}/`)]);
  const version = readFileSync(join(out, 'v'), 'utf8').trim();
  assert.match(version, /^[A-Za-z0-9._-]+$/);
  assert.ok(readFileSync(source, 'utf8').includes(`WELCOME_NOTICE_VERSION = '${version}'`));
});

// ---- default workspace ----
test('default workspace: the harness is told to use the workspace volume instead of looking for a Documents folder', () => {
  const y = patchFor();
  assert.match(row(y, 'workspace-controller').text, /config: \{ documentsDirectory: \/workspace \}/);
});
