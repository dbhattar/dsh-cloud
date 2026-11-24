export function loadConfig(env = process.env) {
  const publicUrl = env.PUBLIC_URL;
  if (!publicUrl) throw new Error('PUBLIC_URL is required (e.g. https://localhost/)');
  const url = new URL(publicUrl);
  const secret = env.RUNNER_SECRET || '';
  if (secret.length < 16) throw new Error('RUNNER_SECRET is required (min 16 chars)');
  const runtime = env.SANDBOX_RUNTIME ?? 'runc';
  if (runtime && !/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(runtime)) throw new Error('SANDBOX_RUNTIME must be a runtime name such as runc or runsc');
  const int = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number.parseInt(env[k], 10));
  return {
    port: int('PORT', 8090),
    secret,
    dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
    sandboxImage: env.SANDBOX_IMAGE || 'dsh-sandbox:latest',
    // Containers (by `dsh-cloud.role` label) attached to every user network, under their role as DNS name.
    sharedRoles: (env.SHARED_ROLES ?? 'gateway,llm-proxy').split(',').map((r) => r.trim()).filter(Boolean),
    // Filtering forward proxy (a shared service under the same role name). Empty = sandboxes get no web access.
    egressProxyUrl: (env.EGRESS_PROXY_URL || '').replace(/\/+$/, ''),
    reconcileSeconds: int('RECONCILE_SECONDS', 15),
    publicUrl: url.href,
    trustedHost: url.hostname,
    llmProxyUrl: (env.LLM_PROXY_URL || '').replace(/\/+$/, ''),
    defaultModel: env.DEFAULT_MODEL || 'openrouter/free',
    showHarnessSignIn: env.SHOW_HARNESS_SIGN_IN === 'true',
    sandboxMemoryMb: int('SANDBOX_MEMORY_MB', 1024),
    sandboxCpus: Number.parseFloat(env.SANDBOX_CPUS || '1'),
    sandboxPids: int('SANDBOX_PIDS', 256),
    sandboxTmpMb: int('SANDBOX_TMP_MB', 256),
    sandboxNofile: int('SANDBOX_NOFILE', 4096),
    // OCI runtime for sandboxes: 'runc' for dev; 'runsc' (gVisor) in production. Empty = daemon default.
    sandboxRuntime: runtime,
  };
}
