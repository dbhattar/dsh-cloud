// Reading a private repository (docs/plan-first-security-test.md, step 4): `dsh-git` stores a read-only token for one host, git then clones with
// it inside the harness's own confinement, the token is where it should be and nowhere else, and logging out takes it away. The "private repository"
// is a local server that demands credentials (the real GitHub needs a real token, which this suite must not hold), reached over loopback inside
// the sandbox container. Self-contained and non-destructive, like toolbox.test.mjs. Needs the image.
//   DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase6
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../lib/helpers.mjs';
import { agentIn, cleanup, docker, putFile, requireImage, startBox, startEgress } from '../lib/sandbox-box.mjs';

const NET = 'dsh-ghaccess-net';
const EGRESS = 'dsh-ghaccess-egress';
const BOX = 'dsh-ghaccess-sbx';
const WS = 'dsh-ghaccess-ws';
const PORT = 8123;
const HOST = `127.0.0.1:${PORT}`;
// Fake, fine-grained-shaped tokens assembled in pieces so this file never holds a complete token-shaped string.
const GOOD = ['github_pat_', '11AAAAAAA0', 'goodtoken01', 'ABCDEFGHIJ', '_klmnopqrstuvw'].join('');
const WRONG = ['github_pat_', '11BBBBBBB0', 'wrongtoken9', 'ZYXWVUTSRQ', '_abcdefghijklmn'].join('');
const a = (snippet, opts) => agentIn(BOX, snippet, opts);

const SERVER = `
import base64, http.server, os, functools
GOOD = os.environ['GOOD_TOKEN']
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get('Authorization', '')
        ok = False
        if auth.startswith('Basic '):
            user, _, pw = base64.b64decode(auth[6:]).decode().partition(':')
            ok = pw == GOOD
        if not ok:
            self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="git"'); self.end_headers(); return
        super().do_GET()
    do_HEAD = do_GET
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', ${PORT}), functools.partial(H, directory='/workspace/srv')).serve_forever()
`;

before(async () => {
  requireImage();
  const egress = startEgress({ net: NET, name: EGRESS });
  await startBox({ net: NET, name: BOX, egressIp: egress.ip, volume: WS });
  // A repository to serve over the "dumb" HTTP protocol, which needs no CGI: a bare repo with its info files updated.
  const setup = a(`set -e; mkdir -p srv && cd srv && git init -q --bare repo.git && git -C repo.git symbolic-ref HEAD refs/heads/main
    cd /workspace && rm -rf seed && git init -q -b main seed && cd seed && echo "private notes" > NOTES.md && git add . && git -c user.name=t -c user.email=t@example.com commit -q -m "first commit" && git push -q /workspace/srv/repo.git main && git -C /workspace/srv/repo.git update-server-info && echo ready`);
  assert.equal(setup.ok, true, setup.out);
  putFile(BOX, '/workspace/server.py', SERVER);
  docker('exec', '-d', '-e', `GOOD_TOKEN=${GOOD}`, BOX, 'python3', '/workspace/server.py');
  await waitFor(() => a(`curl -s -o /dev/null -w %{http_code} http://${HOST}/repo.git/HEAD`).out === '401', { timeoutMs: 20000, what: 'the credentialed server' });
});

after(() => cleanup({ boxes: [BOX], egress: EGRESS, volumes: [WS], net: NET }));

const login = (token, extra = '') => a(`printf '%s\\n' '${token}' | dsh-git login --stdin --host ${HOST} --protocol http ${extra} 2>&1; echo "exit=$?"`);

test('without a token the private repository cannot be cloned', () => {
  const r = a(`rm -rf c1; GIT_TERMINAL_PROMPT=0 git clone -q http://${HOST}/repo.git c1 2>&1; echo "exit=$?"`);
  assert.match(r.out, /exit=128/);
  assert.match(r.out, /Authentication failed|could not read Username|401/i);
});

test('after dsh-git login the clone works in the confined shell, and the token is checked against the repository', () => {
  const r = login(GOOD, '--repo repo.git');
  assert.match(r.out, /stored a token for http:\/\/127\.0\.0\.1:8123 \(not shown\)/);
  assert.match(r.out, /checked: http:\/\/127\.0\.0\.1:8123\/repo\.git is readable with that token\./);
  assert.match(r.out, /exit=0/);
  assert.ok(!r.out.includes(GOOD), 'the helper never prints the token');
  const clone = a('rm -rf c2; git clone -q http://127.0.0.1:8123/repo.git c2 2>&1; echo "exit=$?"; cat c2/NOTES.md; git -C c2 log --oneline | head -1');
  assert.match(clone.out, /exit=0/);
  assert.match(clone.out, /private notes/);
  assert.match(clone.out, /first commit/);
});

test('the token is only in its own private file: not in the environment, the process list, git\'s config, or the clone', () => {
  const where = a(`
    stat -c '%a %U' ~/.config/dsh/git-credentials ~/.config/dsh
    echo "env-hits=$(env | grep -c -F '${GOOD}' || true)"
    echo "ps-hits=$(ps -ef 2>/dev/null | grep -c -F '${GOOD}' || true)"
    echo "gitconfig-hits=$(grep -c -F '${GOOD}' ~/.gitconfig || true)"
    echo "clone-hits=$(grep -c -F '${GOOD}' c2/.git/config || true)"
    git -C c2 remote get-url origin`);
  assert.match(where.out, /^600 dsh$/m);
  assert.match(where.out, /^700 dsh$/m);
  assert.match(where.out, /env-hits=0/);
  assert.match(where.out, /ps-hits=[01]$/m, 'at most the grep itself');
  assert.match(where.out, /gitconfig-hits=0/);
  assert.match(where.out, /clone-hits=0/);
  assert.match(where.out, /^http:\/\/127\.0\.0\.1:8123\/repo\.git$/m, 'the remote URL carries no credentials');
  const status = a('dsh-git status --host 127.0.0.1:8123 --protocol http');
  assert.match(status.out, /stored for http:\/\/127\.0\.0\.1:8123: a fine-grained token \(github_pat_\.\.\.\) \(file .*git-credentials, mode 600\)\. The token is not shown\./);
  assert.ok(!status.out.includes(GOOD));
});

test('the stored token is the one git uses: a different token makes the clone fail, and the right one fixes it', () => {
  const wrong = login(WRONG, '--repo repo.git');
  assert.match(wrong.out, /could not read http:\/\/127\.0\.0\.1:8123\/repo\.git with that token/);
  assert.match(wrong.out, /exit=3/);
  const clone = a(`rm -rf c3; GIT_TERMINAL_PROMPT=0 git clone -q http://${HOST}/repo.git c3 2>&1; echo "exit=$?"`);
  assert.match(clone.out, /exit=128/);
  assert.equal(login(GOOD).out.includes('exit=0'), true);
  assert.match(a(`rm -rf c4; git clone -q http://${HOST}/repo.git c4 2>&1; echo "exit=$?"`).out, /exit=0/);
});

test('logout takes the token away: the file is gone, git has no setting for it, and cloning fails again', () => {
  const out = a('dsh-git logout --host 127.0.0.1:8123 --protocol http 2>&1; echo "exit=$?"');
  assert.match(out.out, /removed the stored token for http:\/\/127\.0\.0\.1:8123/);
  const left = a('ls ~/.config/dsh/ 2>&1; grep -c credential ~/.gitconfig 2>&1 || true');
  assert.ok(!/git-credentials/.test(left.out), `the credential file is gone: ${left.out}`);
  assert.match(a(`rm -rf c5; GIT_TERMINAL_PROMPT=0 git clone -q http://${HOST}/repo.git c5 2>&1; echo "exit=$?"`).out, /exit=128/);
});

test('a classic-shaped token is refused for github.com inside the sandbox too, with no terminal it will not ask, and the real GitHub is reachable by git (public repository, no token)', (t) => {
  const classic = ['ghp_', 'Q7wE2rT9yU4i', 'O1pA6sD3fG8h', 'J5kL0zX2cV9b'].join('');
  const r = a(`printf '%s\\n' '${classic}' | dsh-git login --stdin 2>&1; echo "exit=$?"`);
  assert.match(r.out, /classic token, which carries broad access/);
  assert.match(r.out, /exit=1/);
  assert.match(a('dsh-git login 2>&1 </dev/null; echo "exit=$?"').out, /no terminal to ask in[\s\S]*exit=2/);
  const online = a('curl -s -m 10 -o /dev/null -w %{http_code} https://github.com/').out;
  if (online !== '200') return t.skip('no internet from this host');
  const pub = a('GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code https://github.com/octocat/Hello-World.git HEAD 2>&1 | head -1; echo "exit=${PIPESTATUS:-0}"');
  assert.match(pub.out, /refs\/heads\/|HEAD|^[0-9a-f]{40}/m, pub.out);
});
