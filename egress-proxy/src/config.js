import { DEFAULT_BASE_HOSTS, createScope, parseHostList } from './scope.js';

export function loadConfig(env = process.env) {
  const int = (k, d) => {
    if (env[k] === undefined || env[k] === '') return d;
    const n = Number(env[k]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a whole number, 0 or more`);
    return n;
  };
  const ports = (env.ALLOWED_PORTS ?? '80,443').split(',').map((p) => Number.parseInt(p.trim(), 10)).filter((p) => p > 0 && p < 65536);
  if (!ports.length) throw new Error('ALLOWED_PORTS must list at least one port');
  // Scope: unset, any public host; set, only these hosts plus the base list (scope.js). EGRESS_BASE_HOSTS=none drops the base list.
  const allow = parseHostList(env.EGRESS_ALLOW_HOSTS, 'EGRESS_ALLOW_HOSTS');
  const base = env.EGRESS_BASE_HOSTS === undefined || env.EGRESS_BASE_HOSTS === '' ? parseHostList(DEFAULT_BASE_HOSTS.join(','), 'the base list') : env.EGRESS_BASE_HOSTS.trim() === 'none' ? [] : parseHostList(env.EGRESS_BASE_HOSTS, 'EGRESS_BASE_HOSTS');
  return {
    port: int('PORT', 3128),
    allowedPorts: new Set(ports),
    maxConnections: int('MAX_CONNECTIONS', 256),
    connectTimeoutMs: int('CONNECT_TIMEOUT_SECONDS', 10) * 1000,
    idleTimeoutMs: int('IDLE_TIMEOUT_SECONDS', 300) * 1000,
    scope: createScope({ allow, base }),
    // Per sandbox (source address) and per destination host; 0 turns each off. See limits.js for what they can and cannot see.
    limits: {
      perSourceRate: int('RATE_PER_SOURCE', 100), // new connections or plain-HTTP requests per second
      perDestRate: int('RATE_PER_DESTINATION', 20),
      perSourceConcurrent: int('MAX_CONNECTIONS_PER_SOURCE', 64),
      perDestConcurrent: int('MAX_CONNECTIONS_PER_DESTINATION', 16),
      maxWaitMs: int('LIMIT_WAIT_SECONDS', 5) * 1000,
    },
  };
}
