// scripts/vps/setup.sh: each phase's files and commands, against a fake root directory (DSH_VPS_ROOT). Commands are printed, never run, in that
// mode, so nothing here touches the machine. The real thing has been run only as a dry run on an Ubuntu VM (docs/vps-setup.md). No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretProblem } from '../../common/secret.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/vps/setup.sh', import.meta.url));
const OS = { debian12: 'ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\nPRETTY_NAME="Debian GNU/Linux 12"\n', ubuntu2404: 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04"\n' };

function world({ os = OS.debian12, files = {}, stubs = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vps-'));
  const bin = join(root, '_bin');
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(join(root, 'etc/os-release'), os);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  mkdirSync(bin);
  for (const [name, out] of Object.entries(stubs)) { writeFileSync(join(bin, name), `#!/bin/sh\n${out}\n`); chmodSync(join(bin, name), 0o755); }
  const run = (args, env = {}) => spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, DSH_VPS_ROOT: root, ...env } });
  return { root, run, at: (p) => join(root, p), read: (p) => readFileSync(join(root, p), 'utf8') };
}
const ENV = (w) => ['--env-file', join(w.root, 'dsh.env')];
const ssh2222 = { sshd: 'echo "port 2222"' };

test('usage: --help lists the phases and options; a wrong call exits 2 with a message', () => {
  const w = world();
  const h = w.run(['--help']);
  assert.equal(h.status, 0);
  for (const p of ['preflight', 'packages', 'docker', 'gvisor', 'daemon', 'firewall', 'upgrades', 'user', 'ssh', 'env', 'verify']) assert.match(h.stdout, new RegExp(`^  ${p} `, 'm'), p);
  for (const o of ['--domain', '--dry-run', '--harden-ssh', '--yes', '--only']) assert.match(h.stdout, new RegExp(o));
  for (const bad of [['--bogus'], ['--domain'], ['--domain', 'https://x.com'], ['--domain', 'Bad_Name.com'], ['--user', 'root'], ['--user', 'Bad User'], ['--docker-pool', '10.0.0.0/8; rm'], ['--docker-pool', '10.0.0.0/30'], ['--only', 'nonsense'], ['--skip', 'x']]) {
    const r = w.run(bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /^ERROR:/m);
  }
});

test('preflight: Debian 12 and Ubuntu 22.04 or newer pass; older ones, other distributions and other architectures are refused', () => {
  for (const os of [OS.debian12, OS.ubuntu2404]) assert.equal(world({ os }).run(['--only', 'preflight']).status, 0, os);
  for (const os of ['ID=debian\nVERSION_ID="11"\nPRETTY_NAME="Debian 11"\n', 'ID=ubuntu\nVERSION_ID="20.04"\nPRETTY_NAME="Ubuntu 20.04"\n', 'ID=fedora\nVERSION_ID="40"\nPRETTY_NAME="Fedora 40"\n']) {
    const r = world({ os }).run(['--only', 'preflight']);
    assert.notEqual(r.status, 0, os);
    assert.match(r.stderr, /ERROR: .*(Debian 12|Ubuntu 22|only Debian and Ubuntu)/, os);
  }
  const arch = world({ stubs: { uname: 'echo riscv64' } }).run(['--only', 'preflight']);
  assert.notEqual(arch.status, 0);
  assert.match(arch.stderr, /unsupported architecture riscv64/);
});

test('preflight: a Docker address pool that overlaps a network the host already uses is refused, with the way out; one that does not is accepted', () => {
  const w = world({ stubs: { ip: 'case "$*" in *route*) echo "10.201.0.0/16 dev eth0 scope link"; echo "default via 10.201.0.1 dev eth0";; *addr*) echo "2: eth0    inet 10.201.4.7/16 brd 10.201.255.255 scope global eth0";; esac' } });
  const clash = w.run(['--only', 'preflight']);
  assert.notEqual(clash.status, 0);
  assert.match(clash.stderr, /10\.200\.0\.0\/14 overlaps 10\.201\.0\.0\/16.*--docker-pool/);
  const fine = w.run(['--only', 'preflight', '--docker-pool', '10.220.0.0/14']);
  assert.equal(fine.status, 0, fine.stderr);
  assert.match(fine.stdout, /does not overlap/);
});

test('dry run: says so, prints what it would do, writes nothing, and shows no secret', () => {
  const w = world({ stubs: ssh2222 });
  const r = w.run(['--dry-run', '--domain', 'cloud.example.com', ...ENV(w)], { UPSTREAM_API_KEY: 'sk-THE-PROVIDER-KEY-123' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN: nothing will be changed/);
  for (const phase of ['preflight', 'packages', 'docker', 'gvisor', 'daemon', 'firewall', 'upgrades', 'user', 'env', 'verify']) assert.match(r.stdout, new RegExp(`==> ${phase}`), phase);
  assert.doesNotMatch(r.stdout, /==> ssh/, 'ssh is only with --harden-ssh');
  assert.ok(!r.stdout.includes('sk-THE-PROVIDER-KEY-123') && !r.stderr.includes('sk-THE-PROVIDER-KEY-123'));
  assert.equal(existsSync(w.at('dsh.env')), false);
  assert.equal(existsSync(w.at('etc/docker/daemon.json')), false);
  assert.match(r.stdout, /would create .*dsh\.env.*UPSTREAM_API_KEY \(given\)/);
});

test('daemon: bounded logs, live-restore and the address pool are merged into an existing daemon.json without losing what is there; running it again changes nothing', () => {
  const existing = JSON.stringify({ runtimes: { runsc: { path: '/usr/bin/runsc' } }, features: { cdi: true }, 'log-driver': 'json-file' });
  const w = world({ files: { 'etc/docker/daemon.json': existing } });
  const r1 = w.run(['--only', 'daemon', '--docker-pool', '10.220.0.0/14']);
  assert.equal(r1.status, 0, r1.stderr);
  const conf = JSON.parse(w.read('etc/docker/daemon.json'));
  assert.deepEqual(conf.runtimes, { runsc: { path: '/usr/bin/runsc' } }, 'the runsc registration is kept');
  assert.deepEqual(conf.features, { cdi: true });
  assert.equal(conf['log-driver'], 'local');
  assert.deepEqual(conf['log-opts'], { 'max-size': '20m', 'max-file': '5' });
  assert.equal(conf['live-restore'], true);
  assert.deepEqual(conf['default-address-pools'], [{ base: '10.220.0.0/14', size: 28 }]);
  assert.ok(readdirSync(w.at('etc/docker')).some((f) => f.startsWith('daemon.json.dsh-bak-')), 'the old file was backed up');
  assert.match(r1.stdout + r1.stderr, /NOT restarted/, 'it does not restart Docker unasked');
  const r2 = w.run(['--only', 'daemon', '--docker-pool', '10.220.0.0/14']);
  assert.match(r2.stdout, /unchanged: \/etc\/docker\/daemon\.json/);
  assert.doesNotMatch(r2.stderr, /NOT restarted/);
  assert.equal(readdirSync(w.at('etc/docker')).filter((f) => f.includes('dsh-bak')).length, 1, 'no second backup for no change');
});

test('daemon: a Docker daemon configured to listen on TCP is refused (root for anyone who reaches the port)', () => {
  const w = world({ files: { 'etc/docker/daemon.json': JSON.stringify({ hosts: ['unix:///var/run/docker.sock', 'tcp://0.0.0.0:2375'] }) } });
  const r = w.run(['--only', 'daemon']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /listen on TCP/);
});

test('daemon: Docker is restarted only with --yes, because a restart stops every running container', () => {
  const without = world().run(['--only', 'daemon']);
  assert.match(without.stderr, /NOT restarted/);
  assert.doesNotMatch(without.stdout, /systemctl restart docker/);
  const withYes = world().run(['--only', 'daemon', '--yes']);
  assert.match(withYes.stdout, /restarting Docker \(--yes\)/);
  assert.match(withYes.stdout, /would run: systemctl restart docker/);
  assert.doesNotMatch(withYes.stderr, /NOT restarted/);
});

test('firewall: the sandbox pool is denied FIRST, then SSH on the real port, 80 and 443 are allowed, and ufw is enabled last', () => {
  const w = world({ stubs: ssh2222 });
  const r = w.run(['--only', 'firewall']);
  assert.equal(r.status, 0, r.stderr);
  const cmds = r.stdout.split('\n').filter((l) => l.includes('would run: ufw')).map((l) => l.replace('    would run: ufw ', ''));
  assert.match(cmds[0], /^default deny incoming/);
  const deny = cmds.findIndex((c) => /^insert 1 deny from 10\.200\.0\.0\/14/.test(c));
  const firstAllow = cmds.findIndex((c) => /^allow /.test(c));
  assert.ok(deny >= 0 && deny < firstAllow, 'the deny is inserted at position 1, before any allow');
  for (const want of ['allow 2222/tcp', 'allow 80/tcp', 'allow 443/tcp', 'allow 443/udp']) assert.ok(cmds.some((c) => c.startsWith(want)), want);
  assert.ok(!cmds.some((c) => /allow 22\/tcp/.test(c)), 'not the default port when sshd is on another');
  assert.match(cmds.at(-1), /^--force enable/);
  assert.ok(!cmds.some((c) => /reset/.test(c)), 'existing rules are not reset');
});

test('upgrades: security updates install, Docker, containerd and runsc are never upgraded unattended, and nothing reboots', () => {
  const w = world({ stubs: ssh2222 });
  assert.equal(w.run(['--only', 'upgrades']).status, 0);
  const u = w.read('etc/apt/apt.conf.d/52dsh-cloud-unattended');
  for (const pkg of ['docker-ce', 'docker-ce-cli', 'containerd.io', 'runsc']) assert.match(u, new RegExp(`"${pkg}";`), pkg);
  assert.match(u, /Automatic-Reboot "false"/);
  assert.match(u, /Unattended-Upgrade "1"/);
  const f = w.read('etc/fail2ban/jail.d/dsh-cloud.local');
  assert.match(f, /\[sshd\]\nenabled = true\nport = 2222\n/);
});

test('user: only a public key is accepted (never a private one), it is added once, and the files are private', () => {
  const w = world();
  const pub = join(w.root, 'k.pub'); const priv = join(w.root, 'k');
  writeFileSync(pub, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEY deploy@laptop\n');
  writeFileSync(priv, '-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n-----END OPENSSH PRIVATE KEY-----\n');
  writeFileSync(join(w.root, 'junk'), 'hello world\n');
  const both = join(w.root, 'both'); // a public key line followed by a private key block: still refused
  writeFileSync(both, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEY deploy@laptop\n-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n-----END OPENSSH PRIVATE KEY-----\n');
  assert.match(w.run(['--only', 'user', '--ssh-key-file', both]).stderr, /PRIVATE key/);
  assert.match(w.run(['--only', 'user', '--ssh-key-file', priv]).stderr, /does not look like a public key|PRIVATE key/);
  assert.match(w.run(['--only', 'user', '--ssh-key-file', join(w.root, 'junk')]).stderr, /does not look like a public key/);
  assert.match(w.run(['--only', 'user', '--ssh-key-file', join(w.root, 'missing')]).stderr, /cannot read/);
  assert.equal(w.run(['--only', 'user', '--ssh-key-file', pub]).status, 0);
  assert.equal(w.run(['--only', 'user', '--ssh-key-file', pub]).status, 0);
  const keys = w.read('home/dsh/.ssh/authorized_keys');
  assert.equal(keys.split('\n').filter(Boolean).length, 1, 'added once');
  assert.equal(statSync(w.at('home/dsh/.ssh/authorized_keys')).mode & 0o777, 0o600);
  assert.equal(statSync(w.at('home/dsh/.ssh')).mode & 0o777, 0o700);
  const r = w.run(['--only', 'user']);
  assert.match(r.stdout, /would run: usermod -aG docker dsh/);
  assert.match(r.stderr, /root-equivalent/);
});

test('ssh: only with --harden-ssh, and refused when the deploy user has no key (it would lock the operator out)', () => {
  const w = world();
  assert.doesNotMatch(w.run(['--only', 'ssh']).stdout, /==> ssh/, 'off without the flag');
  const refused = w.run(['--only', 'ssh', '--harden-ssh']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /no authorised key/);
  const pub = join(w.root, 'k.pub');
  writeFileSync(pub, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEY deploy@laptop\n');
  assert.equal(w.run(['--only', 'user,ssh', '--harden-ssh', '--ssh-key-file', pub]).status, 0);
  const conf = w.read('etc/ssh/sshd_config.d/50-dsh-cloud.conf');
  for (const line of ['PermitRootLogin no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no']) assert.match(conf, new RegExp(line));
});

test('env: creates .env with mode 600 and generated secrets the services accept, never shows them, and never overwrites an existing file', () => {
  const w = world();
  const r = w.run(['--only', 'env', '--domain', 'cloud.example.com', ...ENV(w)], { UPSTREAM_API_KEY: 'sk-THE-PROVIDER-KEY-123' });
  assert.equal(r.status, 0, r.stderr);
  const env = Object.fromEntries(w.read('dsh.env').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(statSync(w.at('dsh.env')).mode & 0o777, 0o600);
  assert.deepEqual([env.DOMAIN, env.PUBLIC_URL, env.CADDYFILE, env.ALLOW_SIGNUP], ['cloud.example.com', 'https://cloud.example.com/', 'Caddyfile.production', 'false']);
  assert.equal(env.UPSTREAM_API_KEY, 'sk-THE-PROVIDER-KEY-123');
  for (const k of ['RUNNER_SECRET', 'LLM_ADMIN_SECRET']) { assert.equal(secretProblem(env[k]), null, k); assert.match(env[k], /^[0-9a-f]{48}$/); }
  assert.notEqual(env.RUNNER_SECRET, env.LLM_ADMIN_SECRET);
  for (const secret of [env.RUNNER_SECRET, env.LLM_ADMIN_SECRET, env.UPSTREAM_API_KEY]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'a secret was printed');
  // a second run leaves it alone and says what is missing
  writeFileSync(w.at('dsh.env'), 'RUNNER_SECRET=abc\nDOMAIN=x\n');
  const again = w.run(['--only', 'env', '--domain', 'cloud.example.com', ...ENV(w)]);
  assert.equal(w.read('dsh.env'), 'RUNNER_SECRET=abc\nDOMAIN=x\n', 'not overwritten');
  assert.match(again.stderr, /no value for LLM_ADMIN_SECRET/);
  assert.match(again.stderr, /no value for UPSTREAM_API_KEY/);
  assert.doesNotMatch(again.stderr, /no value for RUNNER_SECRET/);
});

test('env: the provider key comes from a file or the environment, with a warning when there is none; the domain is required', () => {
  const w = world();
  writeFileSync(w.at('keyfile'), 'sk-FROM-A-FILE\nignored second line\n');
  assert.equal(w.run(['--only', 'env', '--domain', 'cloud.example.com', ...ENV(w), '--upstream-key-file', w.at('keyfile')]).status, 0);
  assert.match(w.read('dsh.env'), /^UPSTREAM_API_KEY=sk-FROM-A-FILE$/m);
  const w2 = world();
  const none = w2.run(['--only', 'env', '--domain', 'cloud.example.com', ...ENV(w2)], { UPSTREAM_API_KEY: '' });
  assert.match(none.stderr, /no provider key given/);
  assert.match(w2.read('dsh.env'), /^UPSTREAM_API_KEY=$/m);
  const nodomain = world().run(['--only', 'env']);
  assert.notEqual(nodomain.status, 0);
  assert.match(nodomain.stderr, /needs --domain/);
});

test('the script never takes a secret as an argument, only ever writes the provider key into the new .env, and pipes nothing from curl into a shell', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /--upstream-key\)/, 'there is no --upstream-key VALUE option, only --upstream-key-file');
  const uses = src.split('\n').filter((l) => /\$key\b|"\$key"|\$\{key/.test(l) && !l.trim().startsWith('#'));
  const allowed = [/^\s*key="/, /\[ -n "\$key" \]/, /read -r key/, /UPSTREAM_API_KEY=%s\\n' "\$key"/, /^\s*key=""/];
  for (const l of uses) assert.ok(allowed.some((re) => re.test(l)), `an unexpected use of the key: ${l.trim()}`);
  assert.match(src, /^set -eu$/m);
  assert.match(src, /umask 077/);
  assert.match(src, /chmod 600 "\$ENV_FILE"/);
  assert.doesNotMatch(src, /\bcurl [^|]*\|\s*(sh|bash)\b/, 'nothing is piped from curl into a shell');
});
