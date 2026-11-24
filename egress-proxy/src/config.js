export function loadConfig(env = process.env) {
  const int = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number.parseInt(env[k], 10));
  const ports = (env.ALLOWED_PORTS ?? '80,443').split(',').map((p) => Number.parseInt(p.trim(), 10)).filter((p) => p > 0 && p < 65536);
  if (!ports.length) throw new Error('ALLOWED_PORTS must list at least one port');
  return {
    port: int('PORT', 3128),
    allowedPorts: new Set(ports),
    maxConnections: int('MAX_CONNECTIONS', 256),
    connectTimeoutMs: int('CONNECT_TIMEOUT_SECONDS', 10) * 1000,
    idleTimeoutMs: int('IDLE_TIMEOUT_SECONDS', 300) * 1000,
  };
}
