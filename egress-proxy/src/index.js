import { loadConfig } from './config.js';
import { createEgressProxy } from './server.js';

const cfg = loadConfig();
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
createEgressProxy({ cfg, log }).listen(cfg.port, '0.0.0.0', () =>
  log(`egress-proxy listening on :${cfg.port}, ports ${[...cfg.allowedPorts].join(',')}`),
);
