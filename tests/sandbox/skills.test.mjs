// Step 5: the methodology skills are well formed, small, and name only tools and options that exist. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'sandbox/skills');
const NAMES = ['engagement-rules', 'web-app-testing', 'secure-code-review', 'report-writing'];
const BUDGET = 6000; // bytes per SKILL.md: the model loads the whole file into its context

function parse(name) {
  const text = readFileSync(join(DIR, name, 'SKILL.md'), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${name}: frontmatter missing`);
  const fm = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  return { text, fm, body: m[2] };
}

test('exactly the expected skills exist, one directory each with a SKILL.md', () => {
  const dirs = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(dirs, [...NAMES].sort());
});

for (const name of NAMES) {
  test(`${name}: valid name (same as its directory), description and size`, () => {
    const { text, fm } = parse(name);
    assert.equal(fm.name, name);
    assert.match(fm.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/); // the harness's own rule
    assert.ok(fm.description && fm.description.length > 40 && fm.description.length < 400, 'description length');
    assert.ok(Buffer.byteLength(text) <= BUDGET, `over ${BUDGET} bytes`);
  });
}

test('the secrets rule and the scope rule are present, and every skill but the rules defers to them', () => {
  const rules = parse('engagement-rules').body;
  assert.match(rules, /ENGAGEMENT\.md/);
  assert.match(rules, /git-credentials/);
  assert.match(rules, /production/i);
  for (const n of NAMES.filter((x) => x !== 'engagement-rules' && x !== 'report-writing')) {
    assert.match(parse(n).body, /engagement-rules/, `${n} does not point at engagement-rules`);
  }
});

test('the engagement template exists and holds no credentials field', () => {
  const t = join(DIR, 'engagement-rules/ENGAGEMENT.template.md');
  assert.ok(existsSync(t));
  assert.doesNotMatch(readFileSync(t, 'utf8'), /password\s*[:=]\s*\S|token\s*[:=]\s*\S/i);
});

test('rate advice matches the tools shipped: no ffuf -rate (version 1.1.0 lacks it), every scanner has a rate option', () => {
  const body = parse('web-app-testing').body;
  assert.doesNotMatch(body, /ffuf[^\n]*\s-rate\b(?! option)/);
  for (const re of [/httpx -rl/, /nuclei -rl/, /ffuf -p /, /gobuster dir --delay/, /sqlmap --delay/]) assert.match(body, re);
});

test('the image ships the skills where the harness reads them', () => {
  const d = readFileSync(join(ROOT, 'sandbox/Dockerfile'), 'utf8');
  assert.match(d, /COPY skills\/ \/opt\/dsh-skills\//);
  assert.match(d, /DSH_BUNDLED_SKILL_DIR=\/opt\/dsh-skills/);
});
