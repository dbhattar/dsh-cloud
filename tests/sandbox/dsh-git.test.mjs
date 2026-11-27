// sandbox/bin/dsh-git: the helper that gives git a read-only credential for one host without the token passing through the chat. Real git on
// the host, a temporary HOME; no Docker needed. The tokens here are fake and assembled in pieces so this file holds no complete token-shaped string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../sandbox/bin/dsh-git', import.meta.url));
const FINE = ['github_pat_', '11ABCDEFG0', 'abcdefghij', 'KLMNOPQRST', '_uvwxyz0123456789'].join('');
const FINE2 = ['github_pat_', '11ZYXWVUT9', 'srqponmlkj', 'IHGFEDCBA8', '_zyxwvu9876543210'].join('');
const CLASSIC = ['ghp_', 'Q7wE2rT9yU4i', 'O1pA6sD3fG8h', 'J5kL0zX2cV9b'].join('');

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-home-'));
  const run = (args, { input, tty = false } = {}) =>
    spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', input: input ?? '', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(dir, '.xdg') } });
  const git = (...args) => spawnSync('git', args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(dir, '.xdg') } });
  const cred = (host = 'github.com', protocol = 'https') => git('credential', 'fill').stdout; // replaced below with input
  const fill = (host = 'github.com', protocol = 'https') =>
    spawnSync('git', ['credential', 'fill'], { encoding: 'utf8', input: `protocol=${protocol}\nhost=${host}\n\n`, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(dir, '.xdg'), GIT_TERMINAL_PROMPT: '0' } });
  void cred;
  return { dir, run, git, fill, file: join(dir, '.config/dsh/git-credentials') };
}
const everything = (r) => `${r.stdout}${r.stderr}`;

test('login --stdin stores the token privately for github.com, git then finds it for that host only, and the script never prints it', () => {
  const h = home();
  const r = h.run(['login', '--stdin'], { input: `${FINE}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!everything(r).includes(FINE), 'the token is never echoed');
  assert.match(r.stderr, /stored a token for https:\/\/github\.com \(not shown\)/);
  assert.match(r.stderr, /readable by the agent and by backups/);
  assert.equal(statSync(h.file).mode & 0o777, 0o600, 'the file is private');
  assert.equal(statSync(join(h.dir, '.config/dsh')).mode & 0o777, 0o700, 'and so is its folder');
  assert.equal(readFileSync(h.file, 'utf8'), `https://x-access-token:${FINE}@github.com\n`);
  const found = h.fill('github.com');
  assert.match(found.stdout, /^username=x-access-token$/m);
  assert.ok(found.stdout.includes(`password=${FINE}`), 'git reads it through the credential store');
  const other = h.fill('gitlab.com');
  assert.ok(!other.stdout.includes(FINE), 'another host does not get it');
  assert.ok(!readFileSync(join(h.dir, '.gitconfig'), 'utf8').includes(FINE), 'the token is not in git\'s own config');
  assert.match(readFileSync(join(h.dir, '.gitconfig'), 'utf8'), /\[credential "https:\/\/github\.com"\]\n\s+helper = store --file .*git-credentials/);
});

test('login refuses anything that is not a plain token, and nothing is stored', () => {
  for (const bad of ['', 'short', 'x'.repeat(256), `${FINE} extra`, `${FINE}@evil.example`, `${FINE}/../x`, `${FINE}:pw`, 'abc def ghi jkl mno pqr', 'a'.repeat(24) + '%0a' + 'b'.repeat(5), `${FINE}\r`]) { // (a NUL byte is simply dropped by the shell's read, which leaves a valid token: nothing to refuse)
    const h = home();
    const r = h.run(['login', '--stdin'], { input: `${bad}\n` });
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.match(r.stderr, /that is not a token/);
    assert.ok(!existsSync(h.file), 'nothing was written');
    assert.ok(!existsSync(join(h.dir, '.gitconfig')), 'git was not configured');
  }
  // a line break inside the input cannot add a second credential line: only the first line is read
  const h = home();
  const r = h.run(['login', '--stdin'], { input: `${FINE}\nhttps://x-access-token:${FINE2}@evil.example\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(h.file, 'utf8').split('\n').filter(Boolean).length, 1);
  assert.ok(!readFileSync(h.file, 'utf8').includes('evil.example'));
});

test('a classic token is refused for github.com (it carries broad access) unless the user says so; other hosts are not judged by that rule', () => {
  const h = home();
  const r = h.run(['login', '--stdin'], { input: `${CLASSIC}\n` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /classic token, which carries broad access/);
  assert.match(r.stderr, /fine-grained token limited to one repository with Contents: read-only/);
  assert.ok(!existsSync(h.file));
  assert.equal(h.run(['login', '--stdin', '--allow-classic'], { input: `${CLASSIC}\n` }).status, 0);
  assert.match(h.run(['status']).stdout, /CLASSIC token \(broad access: replace it\)/);
  const t = home();
  assert.equal(t.run(['login', '--stdin', '--host', '127.0.0.1:8123', '--protocol', 'http'], { input: `${CLASSIC}\n` }).status, 0);
});

test('without a terminal and without --stdin it refuses to ask, and says why', () => {
  const h = home();
  const r = h.run(['login']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no terminal to ask in\. Run this in a terminal, not through the chat/);
  assert.ok(!existsSync(h.file));
});

test('login again replaces the token instead of adding one; several hosts coexist; logout removes only its host and git\'s setting for it', () => {
  const h = home();
  h.run(['login', '--stdin'], { input: `${FINE}\n` });
  h.run(['login', '--stdin', '--host', 'git.example.org'], { input: `${FINE2}\n` });
  assert.equal(readFileSync(h.file, 'utf8').trim().split('\n').length, 2);
  h.run(['login', '--stdin'], { input: `${FINE2}\n` }); // a new token for github.com
  const lines = readFileSync(h.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'replaced, not appended');
  assert.ok(h.fill('github.com').stdout.includes(`password=${FINE2}`));
  assert.ok(!readFileSync(h.file, 'utf8').includes(FINE), 'the old token is gone');
  const out = h.run(['logout']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /removed the stored token for https:\/\/github\.com/);
  assert.match(out.stdout, /also delete it on GitHub/);
  assert.equal(readFileSync(h.file, 'utf8').trim().split('\n').length, 1, 'the other host is untouched');
  assert.ok(readFileSync(h.file, 'utf8').includes('@git.example.org'));
  assert.ok(!h.fill('github.com').stdout.includes('password='), 'git no longer finds a credential for github.com');
  assert.ok(h.fill('git.example.org', 'https').stdout.length >= 0);
  h.run(['logout', '--host', 'git.example.org']);
  assert.ok(!existsSync(h.file), 'the file is removed when nothing is left');
  assert.equal(h.run(['logout']).status, 0, 'logging out twice is harmless');
});

test('a token that git has just used (and rewritten with its own encoding) is still replaced by login and removed by logout, and is seen by status', () => {
  // Regression: after a successful clone git approves the credential and the store helper rewrites the line, encoding the ":" in "host:port".
  // The first version matched only its own spelling, so the old token stayed (and won), and logout left it on disk.
  const h = home();
  const host = '127.0.0.1:8123';
  assert.equal(h.run(['login', '--stdin', '--host', host, '--protocol', 'http'], { input: `${FINE}\n` }).status, 0);
  spawnSync('git', ['credential', 'approve'], { input: `protocol=http\nhost=${host}\nusername=x-access-token\npassword=${FINE}\n\n`, env: { PATH: process.env.PATH, HOME: h.dir, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(h.dir, '.xdg') } });
  const rewritten = readFileSync(h.file, 'utf8').trim();
  assert.match(rewritten, /^http:\/\/x-access-token:.*@127\.0\.0\.1%3a8123$/i, `git really did rewrite it: ${rewritten.replace(FINE, '<token>')}`);
  assert.match(h.run(['status', '--host', host, '--protocol', 'http']).stdout, /^stored for http:\/\/127\.0\.0\.1:8123/);
  assert.equal(h.run(['login', '--stdin', '--host', host, '--protocol', 'http'], { input: `${FINE2}\n` }).status, 0);
  const after = readFileSync(h.file, 'utf8').trim().split('\n');
  assert.equal(after.length, 1, 'one line, not two');
  assert.ok(after[0].includes(FINE2) && !readFileSync(h.file, 'utf8').includes(FINE), 'the old token is gone and the new one is the one git finds');
  assert.ok(h.fill(host, 'http').stdout.includes(`password=${FINE2}`));
  // and again for logout
  spawnSync('git', ['credential', 'approve'], { input: `protocol=http\nhost=${host}\nusername=x-access-token\npassword=${FINE2}\n\n`, env: { PATH: process.env.PATH, HOME: h.dir, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(h.dir, '.xdg') } });
  assert.equal(h.run(['logout', '--host', host, '--protocol', 'http']).status, 0);
  assert.ok(!existsSync(h.file), 'logout removed the rewritten line too');
});

test('a longer host name is never mistaken for a shorter one when removing', () => {
  const h = home();
  h.run(['login', '--stdin', '--host', 'github.com.example.org'], { input: `${FINE}\n` });
  h.run(['login', '--stdin'], { input: `${FINE2}\n` });
  h.run(['logout']);
  assert.ok(readFileSync(h.file, 'utf8').includes(`${FINE}@github.com.example.org`), 'the other host survived');
});

test('status says whether a token is stored and what kind, and never shows it', () => {
  const h = home();
  assert.match(h.run(['status']).stdout, /no token stored for https:\/\/github\.com/);
  h.run(['login', '--stdin'], { input: `${FINE}\n` });
  const s = h.run(['status']);
  assert.match(s.stdout, /stored for https:\/\/github\.com: a fine-grained token \(github_pat_\.\.\.\) \(file .*git-credentials, mode 600\)\. The token is not shown\./);
  assert.ok(!everything(s).includes(FINE.slice(12)), 'no part of the token is printed');
});

test('usage errors: help, an unknown command or option, a bad host, protocol or repo', () => {
  const h = home();
  assert.equal(h.run(['--help']).status, 0);
  assert.match(h.run(['--help']).stdout, /let git read a private GitHub repository/);
  assert.equal(h.run([]).status, 2);
  assert.equal(h.run(['nope']).status, 2);
  assert.equal(h.run(['login', '--nope']).status, 2);
  for (const args of [['--host', 'a b'], ['--host', 'x/y'], ['--host', ''], ['--protocol', 'ftp'], ['--repo', 'a b'], ['--repo', 'a;b']]) {
    const r = h.run(['login', '--stdin', ...args], { input: `${FINE}\n` });
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.ok(!existsSync(h.file));
  }
});

test('the token only ever goes into the credential file: no command line, no echo, no other output', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const uses = text.split('\n').filter((l) => /\$token|\$\{#token\}|\$\{token/.test(l)).map((l) => l.trim());
  const allowed = [
    /^IFS= read -r token/, /^case "\$token" in ""\|\*\[!A-Za-z0-9_-\]\*\)/, /^\[ "\$\{#token\}" -ge 20 \]/, /^ghp_\*\|gho_\*/, /^case "\$token" in$/,
    /^printf '%s:\/\/x-access-token:%s@%s\\n' "\$PROTOCOL" "\$token" "\$HOST" >> "\$CRED_FILE"$/, /^unset token$/,
  ];
  for (const l of uses) assert.ok(allowed.some((re) => re.test(l)), `an unexpected use of the token: ${l}`);
  assert.ok(uses.length >= 3, 'the guard is looking at the right lines');
});
