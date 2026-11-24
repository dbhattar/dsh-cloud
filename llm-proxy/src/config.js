/** Environment configuration. Fails fast on anything that would make the proxy unsafe or useless. */
export function loadConfig(env = process.env) {
  const int = (k, d) => {
    if (env[k] === undefined || env[k] === '') return d;
    const n = Number.parseInt(env[k], 10);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a non-negative integer`);
    return n;
  };
  const need = (k) => {
    if (!env[k]) throw new Error(`${k} is required`);
    return env[k];
  };
  const upstreamApiKey = need('UPSTREAM_API_KEY');
  const adminSecret = need('ADMIN_SECRET');
  if (adminSecret.length < 16) throw new Error('ADMIN_SECRET must be at least 16 characters');
  const allowedModels = (env.ALLOWED_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowedModels.length) throw new Error('ALLOWED_MODELS is required (comma-separated model ids)');
  return {
    port: int('PORT', 8081),
    // Unix socket for the admin API (token issue/revoke, usage). Never a TCP port: the proxy is attached to every
    // user network, so any TCP listener is reachable from every sandbox.
    adminSocket: env.ADMIN_SOCKET || '/run/llm-admin/admin.sock',
    dataDir: env.DATA_DIR || '/data',
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    upstreamApiKey,
    adminSecret,
    allowedModels,
    // Token caps per UTC day / month (input + output). 0 disables the cap.
    dailyTokenQuota: int('DAILY_TOKEN_QUOTA', 500_000),
    monthlyTokenQuota: int('MONTHLY_TOKEN_QUOTA', 5_000_000),
    // Token cap for ALL users together per UTC day; when it is used up every request gets 429. 0 disables it.
    globalDailyTokenBudget: int('GLOBAL_DAILY_TOKEN_BUDGET', 0),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60),
    maxConcurrent: int('MAX_CONCURRENT', 4),
    maxOutputTokens: int('MAX_OUTPUT_TOKENS', 16_384),
    maxBodyBytes: int('MAX_BODY_BYTES', 8 * 1024 * 1024),
    upstreamTimeoutSeconds: int('UPSTREAM_TIMEOUT_SECONDS', 600),
  };
}
