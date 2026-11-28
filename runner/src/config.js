/** Friendly name for the model picker: MODEL_DISPLAY_NAME, else a known friendly name for the default model, else none. */
function modelDisplayName(env) {
  const FRIENDLY = { 'openrouter/free': 'Free models (automatic)' };
  const name = env.MODEL_DISPLAY_NAME || FRIENDLY[env.DEFAULT_MODEL || 'openrouter/free'] || '';
  if (name && !/^[A-Za-z0-9][A-Za-z0-9 ._()+\/-]{0,59}$/.test(name)) throw new Error('MODEL_DISPLAY_NAME must be plain words (letters, digits, spaces and . _ ( ) + / -), at most 60 characters');
  return name;
}

/** A Docker log size such as 10m or 500k; anything else is an error rather than being passed on to the daemon. */
function logSize(value, fallback) {
  const v = value === undefined || value === '' ? fallback : value;
  if (!/^[1-9][0-9]{0,5}[kmg]$/.test(v)) throw new Error('SANDBOX_LOG_MAX_SIZE must look like 10m, 500k or 1g');
  return v;
}

export function loadConfig(env = process.env) {
  const publicUrl = env.PUBLIC_URL;
  if (!publicUrl) throw new Error('PUBLIC_URL is required (e.g. https://localhost/)');
  const url = new URL(publicUrl);
  const secret = env.RUNNER_SECRET || '';
  if (secret.length < 16) throw new Error('RUNNER_SECRET is required (min 16 chars)');
  // gVisor by default, and plain runc only when the operator says so in words (docs/security-review.md, SEC-05). Sandboxes run commands
  // an AI wrote; under runc they share the host's kernel. An unset, empty or `runc` value used to be accepted silently, so a host
  // without gVisor ran every user's agent on the host kernel and the visible symptom was only a broken shell tool.
  const runtime = env.SANDBOX_RUNTIME ?? 'runsc';
  if (runtime && !/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(runtime)) throw new Error('SANDBOX_RUNTIME must be a runtime name such as runc or runsc');
  const allowInsecureRuntime = env.ALLOW_INSECURE_RUNTIME === 'true';
  if ((!runtime || runtime === 'runc') && !allowInsecureRuntime) {
    throw new Error(`refusing to start: SANDBOX_RUNTIME is ${runtime ? `"${runtime}"` : 'empty'}, which runs sandboxes on the host kernel. Use runsc (gVisor), or set ALLOW_INSECURE_RUNTIME=true for development on a machine with nothing to lose`);
  }
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
    // What the model is called in the model picker. Empty = the catalog's own name. Plain words only (it goes into a YAML patch).
    modelDisplayName: modelDisplayName(env),
    // Most one model reply may produce, as the harness declares it. Without it the harness assumes 4096 for an unlisted model and cuts a long
    // file write off mid-call. Keep it at or below the llm-proxy's MAX_OUTPUT_TOKENS (16384), which clamps anyway.
    modelMaxOutputTokens: int('MODEL_MAX_OUTPUT_TOKENS', 16384),
    showHarnessSignIn: env.SHOW_HARNESS_SIGN_IN === 'true',
    sandboxMemoryMb: int('SANDBOX_MEMORY_MB', 1024),
    sandboxCpus: Number.parseFloat(env.SANDBOX_CPUS || '1'),
    sandboxPids: int('SANDBOX_PIDS', 256),
    sandboxTmpMb: int('SANDBOX_TMP_MB', 256),
    sandboxNofile: int('SANDBOX_NOFILE', 4096),
    // What a sandbox's own console output may keep on the host (the container log): without a bound, a process printing in a loop fills
    // the host's disk, outside every volume quota (SEC-07).
    sandboxLogMaxSize: logSize(env.SANDBOX_LOG_MAX_SIZE, '10m'),
    sandboxLogMaxFiles: int('SANDBOX_LOG_MAX_FILES', 3),
    // OCI runtime for sandboxes: 'runc' for dev; 'runsc' (gVisor) in production. Empty = daemon default.
    sandboxRuntime: runtime,
    allowInsecureRuntime,
  };
}

/**
 * A warning to log at startup when sandboxes will run under plain runc (or the daemon default, usually runc), or null.
 * Under runc the harness's shell tool cannot work: user namespaces are denied, so bubblewrap fails, and the Landlock
 * launcher is not in the image, so the harness refuses to run commands unconfined. gVisor (runsc) is what works.
 */
export function runtimeWarning(cfg) {
  if (cfg.sandboxRuntime && cfg.sandboxRuntime !== 'runc') return null;
  return 'INSECURE: sandbox runtime is runc (ALLOW_INSECURE_RUNTIME=true): sandboxes share the host kernel, and the agent\'s shell tool will not work in them (the harness refuses to run commands unconfined). '
    + 'Development only. Set SANDBOX_RUNTIME=runsc on a Docker host with gVisor registered (scripts/restart.sh picks it automatically; scripts/lima/setup.sh --stack for a Mac).';
}
