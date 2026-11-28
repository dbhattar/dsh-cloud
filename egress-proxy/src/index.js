import { loadConfig } from './config.js';
import { createEgressProxy } from './server.js';

const cfg = loadConfig();
// Last resort: an error nothing handled leaves the process in an unknown state, so say what it was and exit non-zero; the
// restart policy (infra/docker-compose.gateway.yml) brings the service back. Do not keep serving.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (e) => {
    console.error(`${new Date().toISOString()} fatal ${event}: ${e?.stack ?? e}`);
    process.exit(1);
  });
}
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
createEgressProxy({ cfg, log }).listen(cfg.port, '0.0.0.0', () =>
  log(`egress-proxy listening on :${cfg.port}, ports ${[...cfg.allowedPorts].join(',')}`),
);
