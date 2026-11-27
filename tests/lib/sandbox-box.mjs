// Throwaway sandbox-like containers and an egress proxy for the phase 6 suites: the sandbox's real image and options (gVisor when
// SANDBOX_RUNTIME=runsc, dropped capabilities, read-only root, an internal network), reached through a proxy built from this repository.
// Nothing here touches the compose stack or any user's volume.
import { ROOT, sh, waitFor } from './helpers.mjs';

export const RUNTIME = process.env.SANDBOX_RUNTIME ?? 'runc';
/** The harness's bubblewrap confinement works under gVisor only (user namespaces are denied under runc). */
export const CONFINED = RUNTIME === 'runsc';
export const IMAGE = process.env.SANDBOX_IMAGE ?? 'dsh-sandbox:latest';

/** The harness's own confinement arguments (docs/research-harness-policy.md): root read-only, /workspace and /tmp writable, network shared. */
export const BWRAP = 'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /workspace /workspace';

export const docker = (...a) => sh('docker', a, { maxBuffer: 64 * 1024 * 1024 }).trim();
export const tryDocker = (...a) => { try { return docker(...a); } catch { return ''; } };

export function requireImage() {
  if (!tryDocker('image', 'inspect', '-f', '{{.Id}}', IMAGE)) throw new Error(`the image ${IMAGE} is not built: run scripts/restart.sh, or docker build -t dsh-sandbox:latest sandbox`);
}

/** Start an egress proxy (built from egress-proxy/) on a new internal network and on the default bridge, so it can reach the internet. */
export function startEgress({ net, name, env = {} }) {
  docker('build', '-q', '-t', 'dsh-phase6-egress-img', `${ROOT}/egress-proxy`);
  docker('network', 'create', '--internal', net);
  docker('run', '-d', '--name', name, '--network', 'bridge', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'dsh-phase6-egress-img');
  docker('network', 'connect', net, name);
  return { name, ip: docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, name) };
}

/** Start a sandbox-like container that sleeps (no harness), on `net`, with the proxy variables the runner sets. */
export async function startBox({ net, name, egressIp, volume }) {
  const proxy = 'http://egress-proxy:3128';
  docker('run', '-d', '--name', name, ...(RUNTIME ? ['--runtime', RUNTIME] : []), '--network', net, '--add-host', `egress-proxy:${egressIp}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m',
    '--memory', '2g', '--pids-limit', '512', '-v', `${volume}:/workspace`,
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap((k) => ['-e', `${k}=${proxy}`]),
    '-e', 'NO_PROXY=localhost,127.0.0.1', '-e', 'no_proxy=localhost,127.0.0.1', '-e', 'NODE_USE_ENV_PROXY=1',
    '--entrypoint', 'sleep', IMAGE, '3600');
  await waitFor(() => tryDocker('inspect', '-f', '{{.State.Running}}', name) === 'true', { timeoutMs: 30000, what: `container ${name}` });
}

/**
 * Run a shell snippet in `box` as the agent's shell would (confined when possible). The snippet is written to a file in the workspace
 * first, so it reaches the shell exactly as written. Returns { ok, out }.
 */
export function agentIn(box, snippet, { timeout = 90 } = {}) {
  try {
    sh('docker', ['exec', '-i', box, 'sh', '-c', 'cat > /workspace/.snippet.sh'], { input: snippet, stdio: ['pipe', 'pipe', 'pipe'] });
    const run = `timeout ${timeout} sh /workspace/.snippet.sh`;
    return { ok: true, out: docker('exec', '-w', '/workspace', box, 'sh', '-c', CONFINED ? `${BWRAP} ${run}` : run) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
}

/** Write `content` to `path` inside `box` (as the sandbox user), through stdin so it is not subject to any quoting. */
export function putFile(box, path, content) {
  sh('docker', ['exec', '-i', box, 'sh', '-c', `cat > ${path}`], { input: content, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function cleanup({ boxes = [], egress, volumes = [], net }) {
  for (const b of boxes) tryDocker('rm', '-f', b);
  if (egress) tryDocker('rm', '-f', egress);
  for (const v of volumes) tryDocker('volume', 'rm', v);
  if (net) tryDocker('network', 'rm', net);
}
