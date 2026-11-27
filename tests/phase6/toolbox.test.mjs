// The sandbox toolbox (docs/plan-first-security-test.md, step 2): every tool in the image runs as the sandbox user, in the harness's own
// bubblewrap confinement, in a container with the sandbox's real options, and the pinned versions are the ones in sandbox/tools.lock.
// Self-contained and non-destructive: it starts a throwaway egress proxy and one sandbox-like container on a throwaway internal network;
// it does not touch the compose stack or any volume of a real user. Needs the image (scripts/restart.sh builds it, or
// `docker build -t dsh-sandbox:latest sandbox`). Under gVisor in the Lima VM:
//   DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase6
// Under runc the confinement cannot work (user namespaces are denied), so the checks run without it and say so.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROOT, sh, sleep, waitFor } from '../lib/helpers.mjs';

const RUNTIME = process.env.SANDBOX_RUNTIME ?? 'runc';
const CONFINED = RUNTIME === 'runsc';
const IMAGE = process.env.SANDBOX_IMAGE ?? 'dsh-sandbox:latest';
const NET = 'dsh-toolbox-net';
const EGRESS = 'dsh-toolbox-egress';
const BOX = 'dsh-toolbox-sbx';
const WS = 'dsh-toolbox-ws';

const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };
const lock = readFileSync(`${ROOT}/sandbox/tools.lock`, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split(/\s+/));
const lockedVersion = (tool) => lock.find((l) => l[0] === tool)[1];

/** The harness's own confinement arguments (docs/research-harness-policy.md): the root read-only, /workspace and /tmp writable, no network namespace. */
const BWRAP = 'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /workspace /workspace';
/**
 * Run a shell snippet as the agent's shell would: confined when possible. The snippet is written to a file in the workspace first, so
 * it reaches the shell exactly as written (no quoting layers). Returns { ok, out }.
 */
function agent(snippet, { timeout = 90 } = {}) {
  try {
    sh('docker', ['exec', '-i', BOX, 'sh', '-c', 'cat > /workspace/.snippet.sh'], { input: snippet, stdio: ['pipe', 'pipe', 'pipe'] });
    const run = `timeout ${timeout} sh /workspace/.snippet.sh`;
    return { ok: true, out: docker('exec', '-w', '/workspace', BOX, 'sh', '-c', CONFINED ? `${BWRAP} ${run}` : run) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
}

let internet = false;

before(async () => {
  assert.ok(tryDocker('image', 'inspect', '-f', '{{.Id}}', IMAGE), `the image ${IMAGE} is not built: run scripts/restart.sh, or docker build -t dsh-sandbox:latest sandbox`);
  docker('build', '-q', '-t', 'dsh-toolbox-egress-img', `${ROOT}/egress-proxy`);
  docker('network', 'create', '--internal', NET);
  docker('run', '-d', '--name', EGRESS, '--network', 'bridge', 'dsh-toolbox-egress-img');
  docker('network', 'connect', NET, EGRESS);
  const ip = docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, EGRESS);
  const proxy = `http://egress-proxy:3128`;
  const env = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap((k) => ['-e', `${k}=${proxy}`]);
  docker('run', '-d', '--name', BOX, ...(RUNTIME ? ['--runtime', RUNTIME] : []), '--network', NET, '--add-host', `egress-proxy:${ip}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m',
    '--memory', '2g', '--pids-limit', '512', '-v', `${WS}:/workspace`,
    ...env, '-e', 'NO_PROXY=localhost,127.0.0.1', '-e', 'no_proxy=localhost,127.0.0.1', '-e', 'NODE_USE_ENV_PROXY=1',
    '--entrypoint', 'sleep', IMAGE, '3600');
  await waitFor(() => tryDocker('inspect', '-f', '{{.State.Running}}', BOX) === 'true', { timeoutMs: 30000, what: 'sandbox container' });
  // A local web server for the offline checks, started outside the confinement (its own pid namespace would end it).
  docker('exec', BOX, 'sh', '-c', 'mkdir -p /workspace/www/admin && echo secret-panel > /workspace/www/admin/index.html && echo hello > /workspace/www/index.html');
  docker('exec', '-d', BOX, 'python3', '-m', 'http.server', '8099', '--bind', '127.0.0.1', '--directory', '/workspace/www');
  await waitFor(() => agent('curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8099/').out.includes('200'), { timeoutMs: 20000, what: 'local server' });
  internet = agent('curl -s -m 10 -o /dev/null -w %{http_code} https://example.com/').out.includes('200');
  if (!internet) console.log('note: no internet from this host; skipping the checks that go through the egress proxy');
  if (!CONFINED) console.log(`note: SANDBOX_RUNTIME=${RUNTIME}: the harness's bubblewrap confinement cannot work here, so the checks run without it`);
});

after(() => {
  tryDocker('rm', '-f', BOX);
  tryDocker('rm', '-f', EGRESS);
  tryDocker('volume', 'rm', WS);
  tryDocker('network', 'rm', NET);
});

test('the tools are there, run as the sandbox user, and the pinned ones are the versions in sandbox/tools.lock', () => {
  const who = agent('id -u && id -un');
  assert.match(who.out, /^1001\ndsh$/m);
  const checks = [
    ['git', 'git --version', /git version 2\./], ['curl', 'curl --version', /^curl 7\./], ['python3', 'python3 --version', /Python 3\.11/],
    ['pip', 'pip --version', /^pip 23/], ['jq', 'jq --version', /^jq-1\./], ['rg', 'rg --version', /^ripgrep/], ['unzip', 'unzip -v | head -1', /UnZip/],
    ['sqlmap', 'sqlmap --version 2>&1 | head -1', /^1\.7/], ['ffuf', 'ffuf -V', /ffuf version/], ['gobuster', 'gobuster version', /^3\./],
    ['sslscan', 'sslscan --version | head -3', /2\.0/], ['testssl', 'testssl --version 2>&1 | head -8', /testssl +3\.0\./],
    ['bandit', 'bandit --version | head -1', /bandit 1\.9\.4/], ['pip-audit', 'pip-audit --version', /pip-audit 2\.10\.1/],
    ['httpx', 'httpx -version 2>&1', new RegExp(`v?${lockedVersion('httpx').replace(/\./g, '\\.')}`)],
    ['nuclei', 'nuclei -version 2>&1 -duc', new RegExp(`v${lockedVersion('nuclei').replace(/\./g, '\\.')}`)],
    ['gitleaks', 'gitleaks version', new RegExp(lockedVersion('gitleaks').replace(/\./g, '\\.'))],
    ['osv-scanner', 'osv-scanner --version', new RegExp(`version: ${lockedVersion('osv-scanner').replace(/\./g, '\\.')}`)],
  ];
  const failed = [];
  for (const [name, cmd, expect] of checks) {
    const r = agent(cmd, { timeout: 40 });
    if (!(r.ok || name === 'httpx') || !expect.test(r.out)) failed.push(`${name}: ${r.out.slice(0, 120)}`);
  }
  assert.deepEqual(failed, [], 'every tool answers with the expected version');
});

test('nothing that needs raw sockets or root is shipped, and the root is read-only', () => {
  for (const missing of ['nmap', 'masscan', 'hydra', 'metasploit', 'msfconsole', 'trufflehog', 'semgrep']) assert.equal(agent(`command -v ${missing}`).ok, false, missing);
  assert.equal(agent('touch /usr/local/bin/x').ok, false, 'the image cannot be changed from inside');
  assert.equal(agent('touch /workspace/ok && echo writable').out, 'writable');
});

test('git, jq, ripgrep and unzip do real work offline', () => {
  const r = agent(`set -e; rm -rf g && mkdir g && cd g && git init -q && echo one > f && git add f && git -c user.name=t -c user.email=t@example.com commit -q -m first && git log --oneline | wc -l;
    echo '{"a":[1,2,3]}' | jq '.a | add'; printf 'alpha\\nbeta\\n' | rg -c beta; cd /workspace && printf 'x' > z.txt && (zip -q z.zip z.txt 2>/dev/null || python3 -c "import zipfile;zipfile.ZipFile('z.zip','w').write('z.txt')") && unzip -l z.zip | tail -1`);
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /^1\n6\n1\n/);
  assert.match(r.out, /1 file/);
});

test('the web-testing tools work against a local target: httpx, ffuf, gobuster, nuclei with a template of our own', () => {
  const httpx = agent('echo http://127.0.0.1:8099 | httpx -silent -status-code -no-color', { timeout: 60 });
  assert.match(httpx.out, /http:\/\/127\.0\.0\.1:8099 \[200\]/, httpx.out);
  const words = 'printf "nothing\\nadmin\\nmissing\\n" > /workspace/words.txt';
  const ffuf = agent(`${words} && ffuf -u http://127.0.0.1:8099/FUZZ -w /workspace/words.txt -mc 200,301 -s`, { timeout: 60 });
  assert.match(ffuf.out, /^admin$/m, ffuf.out);
  const gobuster = agent(`${words} && gobuster dir -u http://127.0.0.1:8099 -w /workspace/words.txt -q -n -t 2`, { timeout: 60 });
  assert.match(gobuster.out, /\/admin/, gobuster.out);
  const template = ['id: local-server-banner', 'info:', '  name: local server banner', '  author: test', '  severity: info', 'http:', '  - method: GET', '    path:', '      - "{{BaseURL}}/"', '    matchers:', '      - type: word', '        part: header', '        words:', '          - "SimpleHTTP"'].join('\\n');
  const nuclei = agent(`printf '${template}\\n' > /workspace/t.yaml && nuclei -u http://127.0.0.1:8099 -t /workspace/t.yaml -duc -silent -no-color`, { timeout: 90 });
  assert.match(nuclei.out, /local-server-banner/, nuclei.out);
});

test('the review tools find what they should: gitleaks a planted secret, bandit an eval, and neither cries wolf on clean files', () => {
  // A fake GitHub-token-shaped string, assembled here so this file never contains a complete secret-shaped value (and so a push scanner has nothing to flag).
  // gitleaks deliberately ignores the well-known documentation keys (AKIA...EXAMPLE), so a documentation key would prove nothing.
  const fake = ['ghp_', 'Q7wE2r', 'T9yU4i', 'O1pA6s', 'D3fG8h', 'J5kL0z', 'X2cV9b'].join('');
  const planted = `mkdir -p /workspace/leaky /workspace/clean && printf 'github_token = "${fake}"\\n' > /workspace/leaky/creds.txt && echo hello > /workspace/clean/a.txt`;
  const leaky = agent(`${planted}; gitleaks detect --no-git --source /workspace/leaky --no-banner --exit-code 3 2>&1; echo "exit=$?"`);
  assert.match(leaky.out, /exit=3/, leaky.out);
  assert.match(leaky.out, /Finding|leaks found|aws/i);
  assert.match(agent('gitleaks detect --no-git --source /workspace/clean --no-banner --exit-code 3 2>&1; echo "exit=$?"').out, /exit=0/);
  const bad = agent(`printf 'import os\\nuser = input()\\neval(user)\\n' > /workspace/bad.py && printf 'print(1+1)\\n' > /workspace/fine.py && bandit -q -f txt /workspace/bad.py 2>&1; echo "exit=$?"`);
  assert.match(bad.out, /B307|eval/i, bad.out);
  assert.match(bad.out, /exit=1/);
  assert.match(agent('bandit -q /workspace/fine.py 2>&1; echo "exit=$?"').out, /exit=0/);
});

test('the agent can add its own tools under /workspace: a virtualenv works offline, and the writable places are the right ones', () => {
  const r = agent('python3 -m venv /workspace/v && /workspace/v/bin/python -c "import sys; print(sys.prefix)" && /workspace/v/bin/pip --version | cut -c1-6');
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /\/workspace\/v\npip 2/);
  assert.equal(agent('echo $HOME').out, '/workspace');
  assert.match(agent('echo $PATH').out, /^\/workspace\/\.local\/bin:.*:\/opt\/pytools\/bin$/, 'user scripts first, bandit and pip-audit last');
});

test('through the egress proxy: curl, git over HTTPS, pip, httpx and the scanners that need the internet work, and the refusals still hold', (t) => {
  if (!internet) return t.skip('no internet from this host');
  assert.equal(agent('curl -s -o /dev/null -w %{http_code} https://example.com/').out, '200');
  const clone = agent('rm -rf Hello-World && git clone -q --depth 1 https://github.com/octocat/Hello-World.git && ls Hello-World | head -3', { timeout: 120 });
  assert.equal(clone.ok, true, clone.out);
  assert.match(clone.out, /README/);
  const pip = agent('pip install -q idna 2>&1 | tail -2; python3 -c "import idna; print(\'idna\', idna.__version__)"; ls /workspace/.local/lib | head -1', { timeout: 120 });
  assert.match(pip.out, /^idna \d/m, pip.out);
  assert.match(pip.out, /python3\.11/, 'it landed under ~/.local in the workspace');
  const venv = agent('python3 -m venv /workspace/v2 && /workspace/v2/bin/pip install -q idna 2>&1 | tail -2; /workspace/v2/bin/python -c "import idna; print(\'venv-idna ok\')"', { timeout: 120 });
  assert.match(venv.out, /venv-idna ok/, venv.out);
  assert.match(agent('echo https://example.com | httpx -silent -status-code -no-color', { timeout: 60 }).out, /example\.com \[200\]/);
  // A known-vulnerable dependency is found by both dependency scanners (they query public advisory services through the proxy).
  const dep = agent('printf "requests==2.19.0\\n" > /workspace/requirements.txt; osv-scanner scan source -L /workspace/requirements.txt --no-ignore 2>&1 | tail -15; echo "exit=$?"', { timeout: 120 });
  assert.match(dep.out, /requests|GHSA|PYSEC|CVE/i, dep.out);
  const audit = agent('pip-audit -r /workspace/requirements.txt --no-deps --disable-pip 2>&1 | tail -8', { timeout: 120 });
  assert.match(audit.out, /requests|PYSEC|GHSA|CVE/i, audit.out);
  // Refusals still hold for tools: another port and a private address.
  assert.equal(agent('curl -s -m 8 -o /dev/null -w %{http_code} http://example.com:8080/').out === '200', false);
  assert.equal(agent('curl -s -m 8 -o /dev/null -w %{http_code} http://169.254.169.254/').out === '200', false);
  const log = docker('logs', EGRESS);
  assert.match(log, /egress allow .* CONNECT github\.com:443/);
  assert.match(log, /egress deny .* example\.com:8080 \(port 8080 not allowed\)/);
  assert.match(log, /egress deny .* 169\.254\.169\.254/);
});
