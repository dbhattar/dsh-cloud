export function loadConfig(env = process.env) {
  const publicUrl = env.PUBLIC_URL;
  if (!publicUrl) throw new Error('PUBLIC_URL is required (e.g. https://localhost/)');
  const url = new URL(publicUrl);
  const runnerUrl = (env.RUNNER_URL || '').replace(/\/+$/, '');
  const runnerSecret = env.RUNNER_SECRET || '';
  if (!runnerUrl) throw new Error('RUNNER_URL is required (e.g. http://sandbox-runner:8090)');
  if (runnerSecret.length < 16) throw new Error('RUNNER_SECRET is required (min 16 chars)');
  const llmAdminSocket = env.LLM_ADMIN_SOCKET || '';
  const llmAdminSecret = env.LLM_ADMIN_SECRET || '';
  if (llmAdminSocket && !llmAdminSecret) throw new Error('LLM_ADMIN_SECRET is required when LLM_ADMIN_SOCKET is set');
  const int = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number.parseInt(env[k], 10));
  return {
    port: int('PORT', 8080),
    dataDir: env.DATA_DIR || '/data',
    publicUrl: url.href,
    publicHost: url.host, // Host header the browser sends (may include a port)
    trustedHost: url.hostname, // value for dsh --trusted-host
    secureCookies: url.protocol === 'https:',
    // true = anyone may sign up; false (default) = a valid invite code is required (see scripts/invite.sh).
    allowSignup: env.ALLOW_SIGNUP === 'true',
    runnerUrl,
    runnerSecret,
    // llm-proxy admin API (token issue/revoke/usage) on a unix socket shared only with the gateway.
    // Setting it enables metering. The real key lives only in the proxy.
    llmAdminSocket,
    llmAdminSecret,
    // What the workspace is called on screen where the harness would say "DSH Local Build".
    workspaceName: (env.WORKSPACE_NAME || 'Workspace').slice(0, 40),
    sandboxPort: 3080,
    idleSeconds: int('IDLE_SECONDS', 1800),
    reapIntervalSeconds: int('REAP_INTERVAL_SECONDS', 30),
    startTimeoutSeconds: int('START_TIMEOUT_SECONDS', 90),
    auditRetentionDays: int('AUDIT_RETENTION_DAYS', 90), // 0 = keep forever
    // Capacity and abuse limits; 0 turns each off.
    maxRunningSandboxes: int('MAX_RUNNING_SANDBOXES', 0),
    evictAfterIdleSeconds: int('EVICT_AFTER_IDLE_SECONDS', 300), // when full, only sandboxes idle this long may be stopped for a newcomer
    // A sandbox whose agent is busy (recent model calls, or CPU use) is not stopped for being idle while the browser is
    // closed, for up to this long since the user's last activity. 0 turns the feature off (idle sandboxes stop as before).
    maxBusySeconds: int('MAX_BUSY_SECONDS', 0),
    busyCpuPercent: int('BUSY_CPU_PERCENT', 5), // of one CPU, averaged over the reap interval
    busySignalSeconds: int('BUSY_SIGNAL_SECONDS', 300), // how long a model call or CPU burst keeps counting as "busy"
    maxRunSeconds: int('MAX_RUN_SECONDS', 0), // continuous run time before a sandbox is stopped
    maxDiskMb: int('MAX_DISK_MB', 0), // per user, both volumes together
    diskCheckSeconds: int('DISK_CHECK_SECONDS', 300),
    sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 3600),
  };
}
