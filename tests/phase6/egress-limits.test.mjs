// The egress proxy's scope list and limits (docs/plan-first-security-test.md, step 3) with real containers and the real tools: in scoped
// mode the sandbox reaches the listed host and what git, pip and the scanners need and nothing else, a storm of connections from one
// sandbox is slowed or refused while its neighbour is not, and every refusal is in the proxy's log with its reason. Self-contained and
// non-destructive, like toolbox.test.mjs (throwaway proxy, network and containers; no compose stack). Needs the image and internet.
//   DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase6
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BASE_HOSTS } from '../../egress-proxy/src/scope.js';
import { sleep } from '../lib/helpers.mjs';
import { agentIn, cleanup, docker, requireImage, startBox, startEgress } from '../lib/sandbox-box.mjs';

const NET = 'dsh-egresslim-net';
const EGRESS = 'dsh-egresslim-proxy';
const A = 'dsh-egresslim-a';
const B = 'dsh-egresslim-b';
const VOL_A = 'dsh-egresslim-ws-a';
const VOL_B = 'dsh-egresslim-ws-b';
const SCOPE = 'example.com';

let internet = false;
const a = (snippet, opts) => agentIn(A, snippet, opts);
const b = (snippet, opts) => agentIn(B, snippet, opts);
const log = () => docker('logs', EGRESS);

before(async () => {
  requireImage();
  // Scoped to one host; low limits so a storm is easy to produce: 5 new connections a second to a destination (a burst of 10), 4 open
  // at once, and a request waits at most 2 seconds before it is refused.
  const egress = startEgress({
    net: NET, name: EGRESS,
    env: { EGRESS_ALLOW_HOSTS: SCOPE, RATE_PER_DESTINATION: '5', MAX_CONNECTIONS_PER_DESTINATION: '4', LIMIT_WAIT_SECONDS: '2' },
  });
  await startBox({ net: NET, name: A, egressIp: egress.ip, volume: VOL_A });
  await startBox({ net: NET, name: B, egressIp: egress.ip, volume: VOL_B });
  internet = a(`curl -s -m 10 -o /dev/null -w %{http_code} https://${SCOPE}/`).out.includes('200');
  if (!internet) console.log('note: no internet from this host; the checks that need it are skipped');
});

after(() => cleanup({ boxes: [A, B], egress: EGRESS, volumes: [VOL_A, VOL_B], net: NET }));

test('the proxy runs in scoped mode with the settings it was given', () => {
  const env = docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', EGRESS);
  assert.match(env, /^EGRESS_ALLOW_HOSTS=example\.com$/m);
  assert.match(env, /^RATE_PER_DESTINATION=5$/m);
});

test('a host that is not on the list is refused with the reason, for curl and for a tool; the listed host works; both are in the log', (t) => {
  if (!internet) return t.skip('no internet from this host');
  assert.equal(a(`curl -s -o /dev/null -w %{http_code} https://${SCOPE}/`).out, '200');
  for (const url of ['https://www.wikipedia.org/', `https://www.${SCOPE}/`]) {
    const r = a(`curl -sS -m 15 -o /dev/null ${url} 2>&1; echo "exit=$?"`);
    assert.match(r.out, /exit=56/, `${url}: the tunnel was refused (${r.out})`);
  }
  // Plain HTTP is refused as an ordinary 403 answer, with the reason in a header.
  const plain = a("curl -s -D - -o /dev/null http://neverssl.com/ | tr -d '\\r' | grep -i -E '^(HTTP/|x-egress-reason)'").out;
  assert.match(plain, /^HTTP\/1\.1 403/m);
  assert.match(plain, /x-egress-reason: not in scope: neverssl\.com is not on the allowed list/i);
  const verbose = a('curl -sS -m 15 -o /dev/null https://www.wikipedia.org/ 2>&1 | tr -d "\\r"').out;
  assert.match(verbose, /CONNECT tunnel failed, response 403/, 'the status the tool sees');
  const httpx = a('echo https://www.wikipedia.org | httpx -silent -status-code -no-color -timeout 10 -retries 0; echo "exit=$?"', { timeout: 60 });
  assert.ok(!/\[200\]/.test(httpx.out), `httpx did not reach it: ${httpx.out}`);
  const l = log();
  assert.match(l, /egress allow .* CONNECT example\.com:443/);
  assert.match(l, /egress deny .* CONNECT www\.wikipedia\.org:443 \(not in scope: www\.wikipedia\.org is not on the allowed list\)/);
  assert.match(l, /egress deny .* CONNECT www\.example\.com:443 \(not in scope: www\.example\.com is not on the allowed list\)/, 'a subdomain of a listed host is not listed');
  assert.match(l, /egress deny .* GET neverssl\.com:80 \(not in scope: neverssl\.com is not on the allowed list\)/);
});

test('what the shipped tools need is on the base list: git clone, pip, osv-scanner and pip-audit work in scoped mode, and the proxy saw only listed hosts', (t) => {
  if (!internet) return t.skip('no internet from this host');
  const clone = a('rm -rf Hello-World && git clone -q --depth 1 https://github.com/octocat/Hello-World.git && ls Hello-World | head -2', { timeout: 120 });
  assert.equal(clone.ok, true, clone.out);
  assert.match(clone.out, /README/);
  const pip = a('pip install -q idna 2>&1 | tail -2; python3 -c "import idna; print(\'idna\', idna.__version__)"', { timeout: 120 });
  assert.match(pip.out, /^idna \d/m, pip.out);
  a('printf "requests==2.19.0\\n" > /workspace/requirements.txt');
  const osv = a('osv-scanner scan source -L /workspace/requirements.txt --no-ignore 2>&1 | tail -15', { timeout: 120 });
  assert.match(osv.out, /requests|GHSA|PYSEC|CVE/i, osv.out);
  const audit = a('pip-audit -r /workspace/requirements.txt --no-deps --disable-pip 2>&1 | tail -8', { timeout: 120 });
  assert.match(audit.out, /requests|PYSEC|GHSA|CVE/i, audit.out);
  // Every host the proxy let through is the listed one or on the base list: nothing a tool needed was missing, nothing else was reached.
  const allowed = [...log().matchAll(/egress allow src=\S+ CONNECT ([^: ]+):\d+/g)].map((m) => m[1]);
  console.log(`hosts the tools reached in scoped mode: ${[...new Set(allowed)].sort().join(', ')}`);
  assert.ok(allowed.includes('github.com') && allowed.includes('pypi.org'), `hosts seen: ${[...new Set(allowed)].join(', ')}`);
  for (const host of new Set(allowed)) assert.ok(host === SCOPE || DEFAULT_BASE_HOSTS.includes(host), `${host} was allowed: it is neither the listed host nor on the base list`);
  assert.ok(!/egress deny .*not in scope/.test(log().split('\n').filter((l) => /github|pypi|osv|pythonhosted/.test(l)).join('\n')), 'no base-list host was refused');
});

test('a storm from one sandbox is slowed and then refused with 429 and the reason; its neighbour, at the same moment, is not affected', async (t) => {
  if (!internet) return t.skip('no internet from this host');
  // 40 connections at once to the listed host from A. The rate (5 a second after a burst of 10) is what binds: about ten more queue for up to
  // the 2-second cap, and the rest are refused. Each result is one line in A's workspace.
  const storm = `rm -f /workspace/storm.out; for i in $(seq 1 40); do (r=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' https://${SCOPE}/ 2>&1); printf '%s\\n' "$(echo "$r" | tr '\\n' ' ')" >> /workspace/storm.out) & done; wait`;
  docker('exec', '-d', A, 'sh', '-c', storm);
  const t0 = Date.now();
  // B asks for the same host while A's storm runs.
  const neighbour = b(`for i in 1 2 3; do curl -sS -m 20 -o /dev/null -w '%{http_code} ' https://${SCOPE}/; done`, { timeout: 60 });
  const neighbourSeconds = (Date.now() - t0) / 1000;
  assert.equal(neighbour.out.trim(), '200 200 200', `the neighbour was served: ${neighbour.out}`);
  assert.ok(neighbourSeconds < 10, `and promptly (${neighbourSeconds}s)`);
  let lines = [];
  for (let i = 0; i < 60; i++) {
    lines = a('cat /workspace/storm.out 2>/dev/null').out.split('\n').filter((x) => x.trim());
    if (lines.length >= 40) break;
    await sleep(1000);
  }
  assert.equal(lines.length, 40, `every one of the 40 finished: ${lines.length}`);
  const ok = lines.filter((x) => x.trim() === '200').length;
  const limited = lines.filter((x) => /response 429/.test(x)).length;
  assert.ok(ok >= 10, `the burst and the queued ones were served: ${ok} of 40`);
  assert.ok(limited >= 5, `the rest were refused with 429: ${limited} of 40`);
  assert.equal(ok + limited, 40, 'nothing else went wrong');
  console.log(`storm: ${ok} of 40 served, ${limited} refused with 429; the neighbour's 3 requests took ${neighbourSeconds.toFixed(1)}s`);
  const l = log();
  assert.match(l, /egress deny .* CONNECT example\.com:443 \((rate limit: too many new connections to example\.com|too many connections open to example\.com)\)/);
  const sources = new Set([...l.matchAll(/egress (?:allow|deny) src=(\S+)/g)].map((m) => m[1]));
  assert.ok(sources.size >= 2, 'the two sandboxes are told apart by address');
});
