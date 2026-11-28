import { secretProblem } from '../../common/secret.js';
export function loadConfig(env = process.env) {
  const publicUrl = env.PUBLIC_URL;
  if (!publicUrl) throw new Error('PUBLIC_URL is required (e.g. https://localhost/)');
  const url = new URL(publicUrl);
  const runnerUrl = (env.RUNNER_URL || '').replace(/\/+$/, '');
  const runnerSecret = env.RUNNER_SECRET || '';
  if (!runnerUrl) throw new Error('RUNNER_URL is required (e.g. http://sandbox-runner:8090)');
  const runnerProblem = secretProblem(runnerSecret);
  if (runnerProblem) throw new Error(`RUNNER_SECRET ${runnerProblem}`);
  const llmAdminSocket = env.LLM_ADMIN_SOCKET || '';
  const llmAdminSecret = env.LLM_ADMIN_SECRET || '';
  if (llmAdminSocket && !llmAdminSecret) throw new Error('LLM_ADMIN_SECRET is required when LLM_ADMIN_SOCKET is set');
  const adminProblem = llmAdminSecret ? secretProblem(llmAdminSecret) : null;
  if (adminProblem) throw new Error(`LLM_ADMIN_SECRET ${adminProblem}`);
  const int = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number.parseInt(env[k], 10));
  const mail = loadMailConfig(env, int);
  return {
    mail,
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
    // The waiting room: when full and nothing can be stopped, a newcomer waits in line up to this long and is started as a place
    // frees, instead of being refused. 0 = refuse at once (the old behaviour). Only the first MAX_WAITING are admitted to the line.
    waitQueueSeconds: int('WAIT_QUEUE_SECONDS', 600),
    maxWaiting: int('MAX_WAITING', 50),
    waitPollMs: int('WAIT_POLL_MS', 2000), // how often the first in line looks for a free place (a stop wakes it sooner)
    waitAbandonSeconds: int('WAIT_ABANDON_SECONDS', 30), // someone whose page stopped asking for this long leaves the line
    // A sandbox whose agent is busy (recent model calls, or CPU use) is not stopped for being idle while the browser is
    // closed, for up to this long since the user's last activity. 0 turns the feature off (idle sandboxes stop as before).
    maxBusySeconds: int('MAX_BUSY_SECONDS', 0),
    busyCpuPercent: int('BUSY_CPU_PERCENT', 5), // of one CPU, averaged over the reap interval
    busySignalSeconds: int('BUSY_SIGNAL_SECONDS', 300), // how long a model call or CPU burst keeps counting as "busy"
    maxRunSeconds: int('MAX_RUN_SECONDS', 0), // continuous run time before a sandbox is stopped
    // Per user, both volumes together. On by default (a deployment that does not copy the compose file used to run with no limit at all);
    // 0 turns it off. It is enforced by polling, so it bounds how long a user can stay over, not how fast they fill the disk: the real
    // bound is a filesystem quota on Docker's data root (docs/security-review.md, SEC-08).
    maxDiskMb: int('MAX_DISK_MB', 2048),
    // Total bytes of every account volume on the host (0 = no cap): at or over it, no new workspace is started. Orphaned volumes count.
    maxTotalDiskMb: int('MAX_TOTAL_DISK_MB', 0),
    diskCheckSeconds: int('DISK_CHECK_SECONDS', 300),
    // Crash watchdog: a sandbox the user was using that exits unexpectedly is started again within watchdogSeconds. After
    // crashMaxRestarts exits inside crashWindowSeconds it is held instead (a crash loop), until the user restarts it.
    watchdogSeconds: int('WATCHDOG_SECONDS', 5), // 0 turns the watchdog off
    crashMaxRestarts: int('CRASH_MAX_RESTARTS', 3),
    crashWindowSeconds: int('CRASH_WINDOW_SECONDS', 600),
    sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 3600),
    // Sign-in failures allowed per address across all emails (15 minutes) and per email across all addresses (an hour); see SEC-06.
    loginMaxPerIp: int('LOGIN_MAX_PER_IP', 60),
    loginMaxPerEmail: int('LOGIN_MAX_PER_EMAIL', 50),
    // Where the gateway listens. A unix socket path (shared with Caddy only) means no TCP port at all: no sandbox can reach it (SEC-04).
    socketPath: env.GATEWAY_SOCKET || '',
  };
}

const MAIL_PROVIDERS = ['log', 'outbox', 'mailgun'];

/**
 * Outgoing mail (docs/email.md). `log` (the default) sends nothing: the gateway records only that a message would have gone out.
 * `outbox` writes each message to a folder, for trying the flows on one machine (the files hold links with tokens: not for
 * production). `mailgun` sends through Mailgun's HTTP API. The key is read here once and is never logged or put in an audit row.
 */
function loadMailConfig(env, int) {
  const provider = (env.MAIL_PROVIDER || 'log').trim();
  if (!MAIL_PROVIDERS.includes(provider)) throw new Error(`MAIL_PROVIDER must be one of ${MAIL_PROVIDERS.join(', ')} (got "${provider.slice(0, 20)}")`);
  const region = (env.MAILGUN_REGION || 'us').trim().toLowerCase();
  if (!['us', 'eu'].includes(region)) throw new Error('MAILGUN_REGION must be us or eu');
  const mail = {
    provider,
    from: (env.MAIL_FROM || '').trim(),
    mailgunKey: env.MAILGUN_API_KEY || '',
    mailgunDomain: (env.MAILGUN_DOMAIN || '').trim(),
    // The API address follows the region; MAILGUN_API_BASE exists for tests against a fake server.
    apiBase: (env.MAILGUN_API_BASE || (region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net')).replace(/\/+$/, ''),
    outboxDir: env.MAIL_OUTBOX_DIR || '',
    perAddressPerHour: int('MAIL_MAX_PER_ADDRESS_HOUR', 5),
    perHour: int('MAIL_MAX_PER_HOUR', 100),
    resetMinutes: int('MAIL_RESET_MINUTES', 60),
    taskNotices: env.MAIL_TASK_NOTICES !== 'false',
    taskNoticeHours: int('MAIL_TASK_NOTICE_HOURS', 6),
    attempts: 3,
    retryDelaysMs: [1000, 4000],
    timeoutMs: 10000,
  };
  if (provider === 'mailgun') {
    if (!mail.mailgunKey) throw new Error('MAILGUN_API_KEY is required when MAIL_PROVIDER=mailgun');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(mail.mailgunDomain)) throw new Error('MAILGUN_DOMAIN is required when MAIL_PROVIDER=mailgun (for example mg.example.com)');
  }
  if (provider !== 'log' && !/^[^\r\n<>]*<?[^\s@<>]+@[^\s@<>]+>?$/.test(mail.from)) throw new Error('MAIL_FROM is required when mail is on (for example: dsh-cloud <noreply@mg.example.com>)');
  if (provider === 'outbox' && !mail.outboxDir) throw new Error('MAIL_OUTBOX_DIR is required when MAIL_PROVIDER=outbox');
  // Not enumerable: a configuration object that is printed or spread by mistake must not carry the key along.
  Object.defineProperty(mail, 'mailgunKey', { enumerable: false });
  return mail;
}
